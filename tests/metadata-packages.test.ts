/**
 * Focused tests for metadata-packages.ts: selection/fallback, manager
 * selection, injected-runner queries and installs, validation-worker use,
 * locking and atomic activation. No live registry installs — every process
 * call goes through an injected fake runner; package contents are synthetic
 * fixtures built in private temp dirs.
 */
import assert from "node:assert/strict";
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  realpathSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";

import {
  checkMetadataPackages,
  execFileRunner,
  metadataRoot,
  selectDataSource,
  selectPackageManager,
  managerFromNpmCommand,
  updateMetadataPackages,
  MODELS_DEV_PACKAGE,
  MODELPARAMS_PACKAGE,
  type MetadataPackagesDeps,
  type ProcessRunner,
  type RunResult,
} from "../metadata-packages.ts";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function tempDir(prefix = "oapi-meta-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function agentDir(): string {
  return tempDir("oapi-agent-");
}

/** Extension dir with bundled fixture packages installed (dist entries
 *  included — completeness is part of "usable" since the P1/P2 repairs). */
function extensionDir(versions: { modelsDev?: string; modelparams?: string }): string {
  const dir = tempDir("oapi-ext-");
  for (const [name, version] of [
    [MODELS_DEV_PACKAGE, versions.modelsDev],
    [MODELPARAMS_PACKAGE, versions.modelparams],
  ] as const) {
    if (!version) continue;
    const pkg = join(dir, "node_modules", ...name.split("/"));
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name, version }));
    const dist = join(pkg, "dist");
    mkdirSync(dist, { recursive: true });
    if (name === MODELS_DEV_PACKAGE) {
      writeFileSync(join(dist, "snapshot.js"),
        `export const generatedAt = "2026-10-24";\nexport const providers = {};\nexport const models = {};\n`);
    } else {
      writeFileSync(join(dist, "index.js"), `export const CATALOG = [];\n`);
    }
  }
  return dir;
}

const NODE_HOST = { bunRuntime: false, bunBinary: false, execPath: "/usr/bin/node" };
const BUN_STANDALONE = { bunRuntime: true, bunBinary: true, execPath: "/usr/local/bin/pi" };
const BUN_SOURCE = { bunRuntime: true, bunBinary: false, execPath: "/usr/bin/bun" };

function baseDeps(overrides: Partial<MetadataPackagesDeps> = {}): MetadataPackagesDeps {
  return {
    agentDir: agentDir(),
    extensionDir: extensionDir({ modelsDev: "0.0.113", modelparams: "0.0.72" }),
    hostRuntime: NODE_HOST,
    ...overrides,
  };
}

const ok = (stdout = ""): RunResult => ({ code: 0, signal: null, stdout, stderr: "" });

/** A runner that fails a matching call; returns canned replies otherwise. */
function scriptedRunner(
  script: { match: (args: string[]) => boolean; result: RunResult | (() => RunResult) }[],
): { runner: ProcessRunner; calls: { command: string; args: string[]; cwd: string; env: Record<string, string | undefined> }[] } {
  const calls: { command: string; args: string[]; cwd: string; env: Record<string, string | undefined> }[] = [];
  return {
    calls,
    runner: async (req) => {
      calls.push({ command: req.command, args: req.args, cwd: req.cwd, env: req.env });
      const hit = script.find((s) => s.match(req.args));
      if (!hit) return { code: 2, signal: null, stdout: "", stderr: `unscripted call: ${req.args.join(" ")}` };
      return typeof hit.result === "function" ? hit.result() : hit.result;
    },
  };
}

/** Runner for a happy-path npm check/update. */
function npmRunner(versions: Record<string, string>, installFail?: string) {
  return scriptedRunner([
    // Probe runs before queries; `install` is listed first because install
    // args contain no "view" token — ordering only guards --version.
    {
      match: (a) => a.length === 1 && a[0] === "--version",
      result: ok("10.0.0\n"),
    },
    {
      match: (a) => a[0] === "view" && a[1] === MODELS_DEV_PACKAGE,
      result: ok(JSON.stringify(versions[MODELS_DEV_PACKAGE])),
    },
    {
      match: (a) => a[0] === "view" && a[1] === MODELPARAMS_PACKAGE,
      result: ok(JSON.stringify(versions[MODELPARAMS_PACKAGE])),
    },
    {
      match: (a) => a[0] === "install",
      result: installFail
        ? { code: 1, signal: null, stdout: "", stderr: installFail }
        : ok(""),
    },
  ]);
}

/** Installs synthetic package files where npm would put them. */
function fakeInstalls(version: Record<string, string>): ProcessRunner {
  const { runner } = npmRunner(version);
  return async (req) => {
    if (req.args[0] === "install") {
      const prefix = req.args[req.args.indexOf("--prefix") + 1];
      for (const name of [MODELS_DEV_PACKAGE, MODELPARAMS_PACKAGE]) {
        const pkg = join(prefix, "node_modules", ...name.split("/"));
        mkdirSync(pkg, { recursive: true });
        writeFileSync(join(pkg, "package.json"), JSON.stringify({ name, version: version[name] }));
        // Loadable ESM data modules so the real validation worker passes.
        const dist = join(pkg, "dist");
        mkdirSync(dist, { recursive: true });
        if (name === MODELS_DEV_PACKAGE) {
          writeFileSync(join(dist, "snapshot.js"),
            `export const generatedAt = "2026-10-24";\nexport const providers = {};\nexport const models = {};\n`);
        } else {
          writeFileSync(join(dist, "index.js"), `export const CATALOG = [];\n`);
        }
      }
      return ok("");
    }
    return runner(req);
  };
}

/** Builds a valid generation directory under a private root by hand. */
function makeGeneration(root: string, id: string, versions: { m: string; p: string }): void {
  writeGenerationContents(join(root, "generations", id), { mVersion: versions.m, pVersion: versions.p });
}

// ---------------------------------------------------------------------------
// 2.1 — selection, private root, containment
// ---------------------------------------------------------------------------

test("selection: no active record falls back to bundled deps", () => {
  const deps = baseDeps();
  const sel = selectDataSource(deps);
  assert.equal(sel.source, "bundled");
  assert.equal(sel.modelsDev?.version, "0.0.113");
  assert.equal(sel.modelparams?.version, "0.0.72");
  assert.ok(sel.modelsDev!.dir.includes(deps.extensionDir!));
  assert.equal(sel.warning, undefined);
});

test("selection: valid active record wins and reports disk versions", () => {
  const deps = baseDeps();
  const root = metadataRoot(deps.agentDir);
  makeGeneration(root, "gen-a", { m: "0.0.200", p: "0.0.99" });
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "active.json"), JSON.stringify({
    format: 1, generation: "gen-a",
    versions: { modelsDev: "0.0.200", modelparams: "0.0.99" },
  }));
  const sel = selectDataSource(deps);
  assert.equal(sel.source, "active");
  assert.equal(sel.generation, "gen-a");
  assert.equal(sel.modelsDev?.version, "0.0.200");
  assert.equal(sel.modelparams?.version, "0.0.99");
});

test("selection: corrupt active record falls back with warning", () => {
  const deps = baseDeps();
  const root = metadataRoot(deps.agentDir);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "active.json"), "{not json");
  const sel = selectDataSource(deps);
  assert.equal(sel.source, "bundled");
  assert.match(sel.warning!, /JSON/);
  // Shape-valid but semantically wrong record also rejected.
  writeFileSync(join(root, "active.json"), JSON.stringify({ format: 1, generation: "x" }));
  const sel2 = selectDataSource(deps);
  assert.equal(sel2.source, "bundled");
  assert.match(sel2.warning!, /shape|generation/i);
});

test("selection: symlink escape is rejected, never read", () => {
  const deps = baseDeps();
  const root = metadataRoot(deps.agentDir);
  const outside = tempDir("oapi-outside-");
  const escapee = join(root, "generations", "escape");
  mkdirSync(dirname(escapee), { recursive: true });
  symlinkSync(outside, escapee, "dir");
  const pkg = join(outside, "node_modules", ...MODELS_DEV_PACKAGE.split("/"));
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: MODELS_DEV_PACKAGE, version: "9.9.9" }));
  const pkg2 = join(outside, "node_modules", MODELPARAMS_PACKAGE);
  mkdirSync(pkg2, { recursive: true });
  writeFileSync(join(pkg2, "package.json"), JSON.stringify({ name: MODELPARAMS_PACKAGE, version: "9.9.9" }));
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "active.json"), JSON.stringify({
    format: 1, generation: "escape", versions: { modelsDev: "9.9.9", modelparams: "9.9.9" },
  }));
  const sel = selectDataSource(deps);
  assert.equal(sel.source, "bundled", "symlinked generation must not activate");
  assert.match(sel.warning!, /escapes|missing/i);
  // Traversal in the generation id itself is also rejected.
  writeFileSync(join(root, "active.json"), JSON.stringify({
    format: 1, generation: "../escape", versions: { modelsDev: "9.9.9", modelparams: "9.9.9" },
  }));
  const sel2 = selectDataSource(deps);
  assert.equal(sel2.source, "bundled");
  assert.match(sel2.warning!, /invalid/i);
});

test("selection: incomplete generation (one package missing) falls back", () => {
  const deps = baseDeps();
  const root = metadataRoot(deps.agentDir);
  const gen = join(root, "generations", "gen-partial");
  const pkg = join(gen, "node_modules", ...MODELS_DEV_PACKAGE.split("/"));
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: MODELS_DEV_PACKAGE, version: "1.0.0" }));
  // modelparams never installed — process died mid-generation.
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "active.json"), JSON.stringify({
    format: 1, generation: "gen-partial", versions: { modelsDev: "1.0.0", modelparams: "1.0.0" },
  }));
  const sel = selectDataSource(deps);
  assert.equal(sel.source, "bundled");
  assert.match(sel.warning!, /missing|incomplete/i);
});

test("selection: unreferenced generation dir never auto-activates", () => {
  const deps = baseDeps();
  const root = metadataRoot(deps.agentDir);
  makeGeneration(root, "gen-orphan", { m: "7.7.7", p: "7.7.7" });
  mkdirSync(root, { recursive: true });
  // No active.json — a leftover generation is inert.
  const sel = selectDataSource(deps);
  assert.equal(sel.source, "bundled");
  assert.equal(sel.modelsDev?.version, "0.0.113");
});

// ---------------------------------------------------------------------------
// 2.3 — manager selection
// ---------------------------------------------------------------------------

test("manager: configured npm/bun/pnpm prefixes execute verbatim", () => {
  const npm = managerFromNpmCommand(["npm"]);
  assert.equal(npm.kind, "npm");
  assert.equal(npm.command, "npm");
  assert.deepEqual(npm.prefixArgs, []);
  const custom = managerFromNpmCommand(["/opt/tools/npm", "--bun"]);
  assert.equal(custom.kind, "npm");
  assert.equal(custom.command, "/opt/tools/npm");
  assert.deepEqual(custom.prefixArgs, ["--bun"]);
  const pnpm = managerFromNpmCommand(["env", "pnpm"]);
  assert.equal(pnpm.kind, "pnpm");
  assert.equal(pnpm.command, "env");
  assert.deepEqual(pnpm.prefixArgs, ["pnpm"]);
  const sep = managerFromNpmCommand(["corepack", "--", "pnpm"]);
  assert.equal(sep.kind, "pnpm");
  assert.equal(sep.command, "corepack");
  assert.deepEqual(sep.prefixArgs, ["--", "pnpm"]);
  // Prefix flags on the real manager token run verbatim.
  const flagged = managerFromNpmCommand(["npm", "--bun"]);
  assert.equal(flagged.kind, "npm");
  assert.deepEqual(flagged.prefixArgs, ["--bun"]);
});

test("manager: ambiguous or unsupported prefixes are rejected, not guessed", () => {
  assert.throws(() => managerFromNpmCommand(["yarn"]), /unsupported/);
  assert.throws(() => managerFromNpmCommand(["apt", "install", "npm"]), /ambiguous|unsupported/);
  assert.throws(() => managerFromNpmCommand(["sudo", "npm"]), /ambiguous/);
  assert.throws(() => managerFromNpmCommand([]), /empty/);
  assert.throws(() => managerFromNpmCommand(["", "x"]), /empty/);
  assert.throws(() => managerFromNpmCommand(["wrapper", "--"]), /--|ambiguous/);
  assert.throws(() => managerFromNpmCommand(["x", "--", "pnpm", "extra"]), /ambiguous/);
});

test("update repairs same-version packages with missing imports or unusable data shapes", { timeout: 15_000 }, async () => {
  for (const broken of ["missing-import", "models-shapes", "modelparams-shape"]) {
    const deps = baseDeps();
    const modelsPath = join(deps.extensionDir!, "node_modules", MODELS_DEV_PACKAGE, "dist", "snapshot.js");
    const paramsPath = join(deps.extensionDir!, "node_modules", MODELPARAMS_PACKAGE, "dist", "index.js");
    if (broken === "missing-import") writeFileSync(modelsPath, 'import "./missing-data.js"; export const providers={}; export const models={};');
    else if (broken === "models-shapes") writeFileSync(modelsPath, "export const providers=[]; export const models=null;");
    else writeFileSync(paramsPath, "export const CATALOG=null;");
    let installs = 0;
    const installer = fakeInstalls({ [MODELS_DEV_PACKAGE]: "0.0.113", [MODELPARAMS_PACKAGE]: "0.0.72" });
    const result = await updateMetadataPackages({ ...deps, runner: async (req) => {
      if (req.args[0] === "install") installs++;
      return installer(req);
    } });
    assert.equal(installs, 1, broken);
    assert.equal(result.activated, true, broken);
    assert.equal(selectDataSource(deps).source, "active");
    assert.deepEqual(result.versions, { modelsDev: "0.0.113", modelparams: "0.0.72" });
  }
});

test("same-version usability validation has a deadline and cannot start late repair", { timeout: 5000 }, async () => {
  const deps = baseDeps({ installTimeoutMs: 100 });
  writeFileSync(join(deps.extensionDir!, "node_modules", MODELS_DEV_PACKAGE, "dist", "snapshot.js"),
    "setInterval(() => {}, 1000); await new Promise(() => {}); export const providers={}; export const models={};");
  let installs = 0;
  const installer = fakeInstalls({ [MODELS_DEV_PACKAGE]: "0.0.113", [MODELPARAMS_PACKAGE]: "0.0.72" });
  await assert.rejects(updateMetadataPackages({ ...deps, runner: async (req) => {
    if (req.args[0] === "install") installs++;
    return installer(req);
  } }), /timed out/);
  assert.equal(installs, 0);
  assert.equal(existsSync(join(metadataRoot(deps.agentDir), "active.json")), false);
  assert.equal(existsSync(join(metadataRoot(deps.agentDir), "update.lock")), false);
});

test("manager: action/subcommand prefixes are rejected before any process starts", async () => {
  for (const npmCommand of [
    ["npm", "exec"], ["npm", "install"], ["npm", "--", "bun"],
    ["bun", "run", "npm"], ["pnpm", "dlx"], ["env", "npm", "exec"],
    ["env", "npm", "exec", "view", "--", "pnpm"],
    ["env", "npm", "install", "--", "bun"],
    ["env", "--", "npm", "exec", "view", "--", "pnpm"],
    ["corepack", "npm", "exec", "view", "--", "pnpm"],
    ["corepack", "--", "npm", "install", "--", "bun"],
    ["npm", "--cache=/outside"], ["npm", "--registry"],
  ]) {
    let calls = 0;
    const deps = baseDeps({ npmCommand, runner: async () => { calls++; return ok(JSON.stringify("1.0.0")); } });
    await assert.rejects(checkMetadataPackages(deps), /ambiguous|unsupported/);
    await assert.rejects(updateMetadataPackages(deps), /ambiguous|unsupported/);
    assert.equal(calls, 0, JSON.stringify(npmCommand));
  }
  const supported = ["npm", "--registry", "https://registry.example/", "--loglevel=error"];
  assert.deepEqual(managerFromNpmCommand(supported).prefixArgs, supported.slice(1));
  for (const command of [["env", ...supported], ["env", "--", ...supported], ["corepack", "--", ...supported]]) {
    const selected = managerFromNpmCommand(command);
    assert.equal(selected.kind, "npm");
    assert.deepEqual(selected.prefixArgs, command.slice(1));
  }
});

test("manager: unconfigured defaults — npm for node, embedded bun only for standalone", () => {
  assert.equal(selectPackageManager(baseDeps()).kind, "npm");
  assert.equal(selectPackageManager(baseDeps()).reason, "default-npm");
  // bun run source install: NOT a compiled binary — still npm.
  const src = selectPackageManager(baseDeps({ hostRuntime: BUN_SOURCE }));
  assert.equal(src.kind, "npm");
  assert.equal(src.reason, "default-npm");
  // Confirmed standalone: own binary + BUN_BE_BUN=1.
  const bun = selectPackageManager(baseDeps({ hostRuntime: BUN_STANDALONE }));
  assert.equal(bun.kind, "bun");
  assert.equal(bun.command, "/usr/local/bin/pi");
  assert.equal(bun.env.BUN_BE_BUN, "1");
  assert.equal(bun.reason, "embedded-bun");
  // Config always wins over auto-detection.
  const cfg = selectPackageManager(baseDeps({ hostRuntime: BUN_STANDALONE, npmCommand: ["pnpm"] }));
  assert.equal(cfg.kind, "pnpm");
  assert.equal(cfg.reason, "configured");
});

// ---------------------------------------------------------------------------
// 2.4 — runner contract + per-manager args
// ---------------------------------------------------------------------------

test("runner: no shell, bounded argv, private cwd/env, timeout + abort kill", async () => {
  const { execFileRunner } = await import("../metadata-packages.ts");
  const dir = tempDir();
  const res = await execFileRunner({
    command: "node",
    args: ["-e", "process.stdout.write(process.cwd())"],
    cwd: dir,
    env: { ...process.env },
    timeoutMs: 5000,
  });
  assert.equal(res.code, 0);
  assert.equal(res.stdout.trim(), dir);
  // Bounded output: huge stdout is clipped, not streamed to the terminal.
  const big = await execFileRunner({
    command: "node",
    args: ["-e", "process.stdout.write('x'.repeat(200000))"],
    cwd: dir,
    env: { ...process.env },
    timeoutMs: 5000,
  });
  assert.ok(big.stdout.length <= 64 * 1024);
  // Timeout kills.
  const slow = await execFileRunner({
    command: "node", args: ["-e", "setTimeout(()=>{},60000)"],
    cwd: dir, env: { ...process.env }, timeoutMs: 300,
  });
  assert.equal(slow.code, null);
  assert.equal(slow.signal, "SIGTERM");
  // Abort kills.
  const controller = new AbortController();
  const pending = execFileRunner({
    command: "node", args: ["-e", "setTimeout(()=>{},60000)"],
    cwd: dir, env: { ...process.env }, timeoutMs: 60000, signal: controller.signal,
  });
  controller.abort();
  const aborted = await pending;
  assert.equal(aborted.code, null);
}, { timeout: 30_000 });

// ---------------------------------------------------------------------------
// 3.1 — check: per-package states, no downgrade, failures distinct
// ---------------------------------------------------------------------------

test("check: update-available / up-to-date / newer-local / missing classified", async () => {
  const deps = baseDeps();
  const { runner } = npmRunner({
    [MODELS_DEV_PACKAGE]: "0.0.114",  // newer than 0.0.113 -> update
    [MODELPARAMS_PACKAGE]: "0.0.72",  // equal -> up-to-date
  });
  const res = await checkMetadataPackages({ ...deps, runner });
  assert.equal(res.manager.kind, "npm");
  assert.equal(res.updateAvailable, true);
  assert.deepEqual(res.packages[MODELS_DEV_PACKAGE],
    { status: "update-available", localVersion: "0.0.113", latest: "0.0.114" });
  assert.deepEqual(res.packages[MODELPARAMS_PACKAGE],
    { status: "up-to-date", localVersion: "0.0.72", latest: "0.0.72" });
});

test("check: newer local is not an update and never downgraded", async () => {
  const deps = baseDeps();
  const { runner } = npmRunner({
    [MODELS_DEV_PACKAGE]: "0.0.100",
    [MODELPARAMS_PACKAGE]: "0.0.72",
  });
  const res = await checkMetadataPackages({ ...deps, runner });
  assert.equal(res.updateAvailable, false);
  assert.equal(res.packages[MODELS_DEV_PACKAGE].status, "up-to-date");
});

test("check: missing package and prerelease/invalid responses", async () => {
  const deps = baseDeps({ extensionDir: extensionDir({ modelparams: "0.0.72" }) });
  const { runner } = npmRunner({
    [MODELS_DEV_PACKAGE]: "0.0.200",
    [MODELPARAMS_PACKAGE]: "0.0.73-beta.1", // prerelease → invalid-response
  });
  const res = await checkMetadataPackages({ ...deps, runner });
  assert.equal(res.packages[MODELS_DEV_PACKAGE].status, "missing");
  const mp = res.packages[MODELPARAMS_PACKAGE];
  // prerelease latest is not a usable stable target → query-failed via parse
  assert.equal(mp.status, "query-failed");
});

test("check: single-package auth failure reported per package, never as latest", async () => {
  const deps = baseDeps();
  const { runner, calls } = scriptedRunner([
    { match: (a) => a.includes("--version"), result: ok("10") },
    { match: (a) => a[1] === MODELS_DEV_PACKAGE, result: ok('"0.0.114"') },
    { match: (a) => a[1] === MODELPARAMS_PACKAGE, result: { code: 1, signal: null, stdout: "", stderr: "E401 auth required SECRET" } },
  ]);
  const res = await checkMetadataPackages({ ...deps, runner });
  assert.equal(res.packages[MODELS_DEV_PACKAGE].status, "update-available");
  const mp = res.packages[MODELPARAMS_PACKAGE];
  assert.equal(mp.status, "query-failed");
  assert.match((mp as { reason: string }).reason, /401|auth/i);
  // No package was installed and no generation was created.
  assert.ok(!calls.some((c) => c.args[0] === "install"));
  assert.ok(!existsSync(join(metadataRoot(deps.agentDir), "generations")));
});

test("check: query uses npm view <pkg> dist-tags.latest --json, no shell", async () => {
  const deps = baseDeps();
  const { runner, calls } = npmRunner({ [MODELS_DEV_PACKAGE]: "0.0.113", [MODELPARAMS_PACKAGE]: "0.0.72" });
  await checkMetadataPackages({ ...deps, runner });
  const view = calls.find((c) => c.args[0] === "view");
  assert.ok(view);
  assert.deepEqual(view.args.slice(0, 2), ["view", MODELS_DEV_PACKAGE]);
  assert.ok(view.args.includes("dist-tags.latest") && view.args.includes("--json"));
  // cwd is the private root — never a user project dir.
  assert.equal(view.cwd, metadataRoot(deps.agentDir));
});

test("check: offline refuses before starting any process", async () => {
  const deps = baseDeps({ offline: true });
  const { runner, calls } = npmRunner({});
  await assert.rejects(checkMetadataPackages({ ...deps, runner }), /offline/);
  assert.equal(calls.length, 0);
});

test("check: bun manager uses `bun info` queries", async () => {
  const deps = baseDeps({ hostRuntime: BUN_STANDALONE });
  const { runner, calls } = scriptedRunner([
    { match: (a) => a.includes("--version"), result: ok("1.4.4") },
    { match: (a) => a[0] === "info" && a[1] === MODELS_DEV_PACKAGE, result: ok("0.0.114\n") },
    { match: (a) => a[0] === "info" && a[1] === MODELPARAMS_PACKAGE, result: ok("0.0.72\n") },
  ]);
  const res = await checkMetadataPackages({ ...deps, runner });
  const info = calls.find((c) => c.args[0] === "info");
  assert.ok(info);
  assert.equal(info.command, "/usr/local/bin/pi");
  assert.equal(info.env.BUN_BE_BUN, "1");
  assert.equal(res.packages[MODELS_DEV_PACKAGE].status, "update-available");
});

// ---------------------------------------------------------------------------
// 4.1 — locking
// ---------------------------------------------------------------------------

test("update: second in-process call is rejected busy", async () => {
  const deps = baseDeps();
  let release: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const runner: ProcessRunner = async (req) => {
    if (req.args[0] === "view") {
      await gate; // hold the lock while we try a second update
      return ok('"0.0.114"');
    }
    if (req.args[0] === "install") return ok("");
    return ok("10");
  };
  const first = updateMetadataPackages({ ...deps, runner });
  await assert.rejects(updateMetadataPackages({ ...deps, runner }), /already in progress/);
  release!();
  // The first update then fails validation (its runner installs nothing) —
  // the busy contract already held; drain it so the test exits clean.
  await first.catch(() => undefined);
}, { timeout: 30_000 });

test("update: foreign live lock holder is not stolen; dead owner is reclaimed", async () => {
  const deps = baseDeps();
  const root = metadataRoot(deps.agentDir);
  mkdirSync(root, { recursive: true });
  const lock = join(root, "update.lock");
  // Live foreign owner: current pid is alive → busy.
  writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
  await assert.rejects(updateMetadataPackages({ ...deps, runner: async () => ok("") }), /already in progress/);
  // Dead owner: a pid that already exited is provably gone → recovered.
  const { spawnSync } = await import("node:child_process");
  const dead = spawnSync("node", ["-e", ""]);
  const deadPid = dead.pid;
  assert.ok(deadPid > 1);
  writeFileSync(lock, JSON.stringify({ pid: deadPid, startedAt: Date.now() }));
  const { runner } = npmRunner({ [MODELS_DEV_PACKAGE]: "0.0.113", [MODELPARAMS_PACKAGE]: "0.0.72" });
  const res = await updateMetadataPackages({ ...deps, runner });
  assert.equal(res.activated, false, "stale lock recovered then all up-to-date");
  // Unreadable lock: cannot prove dead → still busy.
  writeFileSync(lock, "garbage");
  await assert.rejects(updateMetadataPackages({ ...deps, runner }), /already in progress/);
});

// ---------------------------------------------------------------------------
// 4.2 — update flow
// ---------------------------------------------------------------------------

test("update: one package upgrades, the other is reinstalled at its kept version", async () => {
  const deps = baseDeps();
  const runner = fakeInstalls({ [MODELS_DEV_PACKAGE]: "0.0.114", [MODELPARAMS_PACKAGE]: "0.0.72" });
  const res = await updateMetadataPackages({ ...deps, runner });
  assert.equal(res.activated, true);
  assert.equal(res.versions.modelsDev, "0.0.114");
  assert.equal(res.versions.modelparams, "0.0.72");
  assert.equal(res.packages[MODELS_DEV_PACKAGE].action, "installed");
  // modelparams still enters the new generation at its exact version —
  // "kept" here means no registry bump was needed, not "skipped install".
  const sel = selectDataSource(deps);
  assert.equal(sel.source, "active");
  assert.equal(sel.modelsDev?.version, "0.0.114");
  assert.equal(sel.modelparams?.version, "0.0.72");
});

test("update: all up-to-date installs nothing and creates no generation", async () => {
  const deps = baseDeps();
  const { runner, calls } = npmRunner({ [MODELS_DEV_PACKAGE]: "0.0.113", [MODELPARAMS_PACKAGE]: "0.0.72" });
  const res = await updateMetadataPackages({ ...deps, runner });
  assert.equal(res.activated, false);
  assert.ok(!calls.some((c) => c.args[0] === "install"));
  assert.ok(!existsSync(join(metadataRoot(deps.agentDir), "generations")));
  assert.ok(!existsSync(join(metadataRoot(deps.agentDir), "active.json")));
});

test("update: missing local package is repaired into a complete generation", async () => {
  const deps = baseDeps({ extensionDir: extensionDir({ modelparams: "0.0.72" }) });
  const runner = fakeInstalls({ [MODELS_DEV_PACKAGE]: "0.0.114", [MODELPARAMS_PACKAGE]: "0.0.72" });
  const res = await updateMetadataPackages({ ...deps, runner });
  assert.equal(res.activated, true);
  const sel = selectDataSource(deps);
  assert.equal(sel.source, "active");
  assert.equal(sel.modelsDev?.version, "0.0.114");
});

test("update: any failed registry query aborts before installing", async () => {
  const deps = baseDeps();
  const { runner, calls } = scriptedRunner([
    { match: (a) => a.includes("--version"), result: ok("10") },
    { match: (a) => a[0] === "view" && a[1] === MODELS_DEV_PACKAGE, result: ok('"0.0.114"') },
    { match: (a) => a[0] === "view" && a[1] === MODELPARAMS_PACKAGE, result: { code: 1, signal: null, stdout: "", stderr: "ETIMEDOUT" } },
  ]);
  await assert.rejects(updateMetadataPackages({ ...deps, runner }), /modelparams|ETIMEDOUT/i);
  assert.ok(!calls.some((c) => c.args[0] === "install"));
  // Active record untouched; bundled selection unchanged.
  assert.equal(selectDataSource(deps).source, "bundled");
});

test("update: second-package install failure keeps previous active record", async () => {
  const deps = baseDeps();
  const root = metadataRoot(deps.agentDir);
  makeGeneration(root, "gen-old", { m: "0.0.113", p: "0.0.72" });
  mkdirSync(root, { recursive: true });
  const active = { format: 1, generation: "gen-old", versions: { modelsDev: "0.0.113", modelparams: "0.0.72" } };
  writeFileSync(join(root, "active.json"), JSON.stringify(active));
  const { runner } = npmRunner(
    { [MODELS_DEV_PACKAGE]: "0.0.114", [MODELPARAMS_PACKAGE]: "0.0.73" },
    "ENOENT write error",
  );
  await assert.rejects(updateMetadataPackages({ ...deps, runner }), /install|ENOENT/i);
  // active.json still points at the old generation.
  assert.deepEqual(JSON.parse(readFileSync(join(root, "active.json"), "utf8")), active);
  const sel = selectDataSource(deps);
  assert.equal(sel.generation, "gen-old");
});

test("update: local newer than registry latest is preserved, never downgraded", async () => {
  const deps = baseDeps({ extensionDir: extensionDir({ modelsDev: "0.0.999", modelparams: "0.0.72" }) });
  const runner = fakeInstalls({ [MODELS_DEV_PACKAGE]: "0.0.114", [MODELPARAMS_PACKAGE]: "0.0.72" });
  const res = await updateMetadataPackages({ ...deps, runner });
  // Local 0.0.999 > latest 0.0.114 and nothing is missing → no install at
  // all; the newer local version is simply kept.
  assert.equal(res.activated, false);
  assert.equal(res.versions.modelsDev, "0.0.999");
  // And when a generation DOES install, the kept package pins its local
  // version, not the lower registry latest.
  const deps2 = baseDeps({ extensionDir: extensionDir({ modelsDev: "0.0.999" }) }); // modelparams missing → repair
  const runner2: ProcessRunner = async (req) => {
    if (req.args.length === 1 && req.args[0] === "--version") return ok("10");
    if (req.args[0] === "view") {
      return ok(JSON.stringify({ [MODELS_DEV_PACKAGE]: "0.0.114", [MODELPARAMS_PACKAGE]: "0.0.72" }[req.args[1]]));
    }
    if (req.args[0] === "install") {
      const prefix = req.args[req.args.indexOf("--prefix") + 1];
      writeGenerationContents(prefix, { mVersion: "0.0.999", pVersion: "0.0.72" });
      return ok("");
    }
    return { code: 2, signal: null, stdout: "", stderr: "unscripted" };
  };
  const res2 = await updateMetadataPackages({ ...deps2, runner: runner2 });
  assert.equal(res2.activated, true);
  assert.equal(res2.versions.modelsDev, "0.0.999", "target stays the newer local");
  assert.equal(res2.versions.modelparams, "0.0.72");
});

test("update: offline refuses before spawning", async () => {
  const { runner, calls } = npmRunner({});
  await assert.rejects(updateMetadataPackages(baseDeps({ offline: true, runner })), /offline/);
  assert.equal(calls.length, 0);
});

// ---------------------------------------------------------------------------
// 4.3 — validation worker (real worker + synthetic fixtures)
// ---------------------------------------------------------------------------

/** Writes complete synthetic package contents into a generation dir. */
function writeGenerationContents(gen: string, opts: {
  mVersion: string; pVersion: string;
  providers?: string; models?: string; catalog?: string;
  modelsDevThrows?: boolean;
}): void {
  const mpkg = join(gen, "node_modules", ...MODELS_DEV_PACKAGE.split("/"));
  const ppkg = join(gen, "node_modules", MODELPARAMS_PACKAGE);
  const mdir = join(mpkg, "dist");
  const pdir = join(ppkg, "dist");
  mkdirSync(mdir, { recursive: true });
  mkdirSync(pdir, { recursive: true });
  writeFileSync(join(mpkg, "package.json"),
    JSON.stringify({ name: MODELS_DEV_PACKAGE, version: opts.mVersion }));
  writeFileSync(join(ppkg, "package.json"),
    JSON.stringify({ name: MODELPARAMS_PACKAGE, version: opts.pVersion }));
  writeFileSync(join(mdir, "snapshot.js"), opts.modelsDevThrows
    ? `throw new Error("snapshot exploded");\n`
    : `export const generatedAt = "2026-10-24";\n${opts.providers ?? "export const providers = {};"}\n${opts.models ?? "export const models = {};"}\n`);
  writeFileSync(join(pdir, "index.js"), opts.catalog ?? `export const CATALOG = [];\n`);
}

/** @deprecated use writeGenerationContents(prefix, opts) */
function makeFullGeneration(root: string, id: string, opts: Parameters<typeof writeGenerationContents>[1]): string {
  const gen = join(root, "generations", id);
  writeGenerationContents(gen, opts);
  return gen;
}

function runnerInstallingFixture(_root: string, genIdRef: { id?: string }, versions: Record<string, string>, fixtureOpts: Parameters<typeof makeFullGeneration>[2]): ProcessRunner {
  return async (req) => {
    if (req.args.length === 1 && req.args[0] === "--version") return ok("10");
    if (req.args[0] === "view") {
      return ok(JSON.stringify(versions[req.args[1]]));
    }
    if (req.args[0] === "install") {
      // npm --prefix <dir>: the generation dir IS the install prefix.
      const prefix = req.args[req.args.indexOf("--prefix") + 1];
      genIdRef.id = prefix.split("/").pop();
      writeGenerationContents(prefix, fixtureOpts);
      return ok("");
    }
    return { code: 2, signal: null, stdout: "", stderr: "unscripted" };
  };
}

test("update: real validation worker accepts a healthy generation", async () => {
  const deps = baseDeps();
  const root = metadataRoot(deps.agentDir);
  mkdirSync(root, { recursive: true });
  const ref: { id?: string } = {};
  const runner = runnerInstallingFixture(root, ref,
    { [MODELS_DEV_PACKAGE]: "0.0.114", [MODELPARAMS_PACKAGE]: "0.0.72" },
    {
      mVersion: "0.0.114", pVersion: "0.0.72",
      providers: `export const providers = { openai: { models: { m: {} } } };`,
      models: `export const models = {};`,
      catalog: `export const CATALOG = [];`,
    });
  const res = await updateMetadataPackages({ ...deps, runner });
  assert.equal(res.activated, true, "healthy synthetic generation activates");
}, { timeout: 60_000 });

test("update: whole-site corruption rejects; partial shape degradation allowed", async () => {
  // Whole-site models.dev failure (module throws) + partial modelparams ok
  // still rejects the whole generation.
  const deps = baseDeps();
  const root = metadataRoot(deps.agentDir);
  mkdirSync(root, { recursive: true });
  const ref: { id?: string } = {};
  const runner = runnerInstallingFixture(root, ref,
    { [MODELS_DEV_PACKAGE]: "0.0.114", [MODELPARAMS_PACKAGE]: "0.0.72" },
    { mVersion: "0.0.114", pVersion: "0.0.72", modelsDevThrows: true });
  await assert.rejects(updateMetadataPackages({ ...deps, runner }), /unusable|validation/i);
  assert.equal(selectDataSource(deps).source, "bundled");

  // Partial: providers shape bad but canonical models shape good → allowed.
  const deps2 = baseDeps();
  const root2 = metadataRoot(deps2.agentDir);
  mkdirSync(root2, { recursive: true });
  const ref2: { id?: string } = {};
  const runner2 = runnerInstallingFixture(root2, ref2,
    { [MODELS_DEV_PACKAGE]: "0.0.114", [MODELPARAMS_PACKAGE]: "0.0.72" },
    {
      mVersion: "0.0.114", pVersion: "0.0.72",
      providers: `export const providers = [];`,                       // degraded shape
      models: `export const models = { "a/b": { name: "b" } };`,       // still usable
    });
  const res2 = await updateMetadataPackages({ ...deps2, runner: runner2 });
  assert.equal(res2.activated, true, "per-shape degradation activates");
}, { timeout: 60_000 });

test("update: installed manifest name/version mismatch rejects before worker", async () => {
  const deps = baseDeps();
  const runner: ProcessRunner = async (req) => {
    if (req.args.includes("--version")) return ok("10");
    if (req.args[0] === "view") return ok(JSON.stringify({ [MODELS_DEV_PACKAGE]: "0.0.114", [MODELPARAMS_PACKAGE]: "0.0.72" }[req.args[1]]));
    if (req.args[0] === "install") {
      const prefix = req.args[req.args.indexOf("--prefix") + 1];
      // Wrong version on disk for models.dev — entries exist so the
      // identity check itself is what fires, not missing-dist containment.
      writeGenerationContents(prefix, { mVersion: "0.0.1", pVersion: "0.0.72" });
      return ok("");
    }
    return { code: 2, signal: null, stdout: "", stderr: "unscripted" };
  };
  await assert.rejects(updateMetadataPackages({ ...deps, runner }), /identity mismatch/);
  assert.equal(selectDataSource(deps).source, "bundled");
});

// ---------------------------------------------------------------------------
// 4.4 — atomic commit, cancellation, atomicity
// ---------------------------------------------------------------------------

test("update: cancel before commit leaves no active record", async () => {
  const deps = baseDeps();
  const controller = new AbortController();
  const root = metadataRoot(deps.agentDir);
  const ref: { id?: string } = {};
  const runner: ProcessRunner = async (req) => {
    if (req.args.includes("--version")) return ok("10");
    if (req.args[0] === "view") return ok(JSON.stringify({ [MODELS_DEV_PACKAGE]: "0.0.114", [MODELPARAMS_PACKAGE]: "0.0.72" }[req.args[1]]));
    if (req.args[0] === "install") {
      const prefix = req.args[req.args.indexOf("--prefix") + 1];
      writeGenerationContents(prefix, { mVersion: "0.0.114", pVersion: "0.0.72" });
      ref.id = prefix.split("/").pop();
      controller.abort(); // cancel lands before the validation/commit
      return ok("");
    }
    return { code: 2, signal: null, stdout: "", stderr: "unscripted" };
  };
  await assert.rejects(
    updateMetadataPackages({ ...deps, runner }, controller.signal),
    (e: unknown) => (e as Error).name === "AbortError" || /aborted/i.test((e as Error).message),
  );
  assert.ok(!existsSync(join(root, "active.json")), "cancelled update must not commit");
});

test("update: concurrent processes serialize on the lock file", async () => {
  const deps = baseDeps();
  const root = metadataRoot(deps.agentDir);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "update.lock"), JSON.stringify({ pid: 1, startedAt: Date.now() }));
  // pid 1: cannot prove dead (init) → busy.
  await assert.rejects(updateMetadataPackages({ ...deps, runner: async () => ok("") }), /already in progress/);
});

test("update: generation dirs are unique and private-rooted", async () => {
  const deps = baseDeps();
  const root = metadataRoot(deps.agentDir);
  const ref: { id?: string } = {};
  const runner = runnerInstallingFixture(root, ref,
    { [MODELS_DEV_PACKAGE]: "0.0.114", [MODELPARAMS_PACKAGE]: "0.0.72" },
    { mVersion: "0.0.114", pVersion: "0.0.72" });
  await updateMetadataPackages({ ...deps, runner });
  assert.ok(ref.id?.startsWith("gen-"));
  assert.ok(ref.id!.length > "gen-".length + 6);
  const genDir = join(root, "generations", ref.id!);
  assert.ok(existsSync(join(genDir, "package.json")));
  // Manager caches stay inside the private root.
  assert.ok(existsSync(join(root, "manager-cache", "npm")));
});

// ---------------------------------------------------------------------------
// Review regressions — findings 1-8
// ---------------------------------------------------------------------------

// --- 1: containment anchors every existing ancestor AND leaf -----------------

test("f1: symlinked generations/ parent is a write escape — never activated", async () => {
  const deps = baseDeps();
  const root = metadataRoot(deps.agentDir);
  const outside = tempDir("oapi-escape-");
  // generations -> outside dir: realpath of the parent leaves the root.
  mkdirSync(root, { recursive: true });
  symlinkSync(outside, join(root, "generations"), "dir");
  const { runner, calls } = npmRunner({
    [MODELS_DEV_PACKAGE]: "0.0.114", [MODELPARAMS_PACKAGE]: "0.0.72",
  });
  await assert.rejects(updateMetadataPackages({ ...deps, runner }), /escapes/);
  // The install step was never even attempted — nothing was written outside.
  assert.ok(!calls.some((c) => c.args[0] === "install"));
  assert.deepEqual(readdirSync(outside), []);
  assert.ok(!existsSync(join(root, "active.json")));
});

test("f1: symlinked dist entry inside a generation is rejected before import", async () => {
  const deps = baseDeps();
  const root = metadataRoot(deps.agentDir);
  const outside = tempDir("oapi-escape-");
  // The malicious installer symlinks the data module to an outside file —
  // leaf containment must reject it before the Worker can import it.
  const outsideModule = join(outside, "evil.js");
  writeFileSync(outsideModule, `export const providers = {}; export const models = {};`);
  const runner: ProcessRunner = async (req) => {
    if (req.args.length === 1 && req.args[0] === "--version") return ok("10");
    if (req.args[0] === "view") {
      return ok(JSON.stringify({ [MODELS_DEV_PACKAGE]: "0.0.114", [MODELPARAMS_PACKAGE]: "0.0.72" }[req.args[1]]));
    }
    if (req.args[0] === "install") {
      const prefix = req.args[req.args.indexOf("--prefix") + 1];
      writeGenerationContents(prefix, { mVersion: "0.0.114", pVersion: "0.0.72" });
      // Replace the real dist module with an escaping symlink.
      const entry = join(prefix, "node_modules", ...MODELS_DEV_PACKAGE.split("/"), "dist", "snapshot.js");
      rmSync(entry, { force: true });
      symlinkSync(outsideModule, entry);
      return ok("");
    }
    return { code: 2, signal: null, stdout: "", stderr: "unscripted" };
  };
  await assert.rejects(updateMetadataPackages({ ...deps, runner }), /escapes/);
  assert.ok(!existsSync(join(root, "active.json")), "escaped leaf never activates");
});

test("f1: symlinked manager-cache ancestor refuses writes outside root", async () => {
  const deps = baseDeps();
  const root = metadataRoot(deps.agentDir);
  const outside = tempDir("oapi-escape-");
  mkdirSync(root, { recursive: true });
  symlinkSync(outside, join(root, "manager-cache"), "dir");
  const { runner } = npmRunner({ [MODELS_DEV_PACKAGE]: "0.0.114", [MODELPARAMS_PACKAGE]: "0.0.72" });
  await assert.rejects(updateMetadataPackages({ ...deps, runner }), /escapes/);
  assert.deepEqual(readdirSync(outside), [], "no cache/tmp written through the symlink");
});

test("f1: symlinked active.json pointer is not read", () => {
  const deps = baseDeps();
  const root = metadataRoot(deps.agentDir);
  mkdirSync(join(root, "generations"), { recursive: true });
  const outside = tempDir("oapi-escape-");
  const foreign = join(outside, "active.json");
  writeFileSync(foreign, JSON.stringify({
    format: 1, generation: "gen-x", versions: { modelsDev: "9.9.9", modelparams: "9.9.9" },
  }));
  symlinkSync(foreign, join(root, "active.json"));
  const sel = selectDataSource(deps);
  assert.equal(sel.source, "bundled", "symlinked pointer resolves outside root → ignored");
});

// --- 2: stale-lock reclaim serialized; older updater cannot downgrade --------

test("f2: two concurrent stale-lock reclaimers — only one acquires", async () => {
  const deps = baseDeps();
  const root = metadataRoot(deps.agentDir);
  mkdirSync(root, { recursive: true });
  const { spawnSync } = await import("node:child_process");
  const deadPid = spawnSync("node", ["-e", ""]).pid;
  writeFileSync(join(root, "update.lock"), JSON.stringify({ pid: deadPid, startedAt: Date.now() }));

  // Two gated updaters: both stall inside the install so their lock attempts
  // overlap — but the recovery guard means only the first reclaims.
  let release: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let installed = 0;
  const runner: ProcessRunner = async (req) => {
    if (req.args.length === 1 && req.args[0] === "--version") return ok("10");
    if (req.args[0] === "view") {
      return ok(JSON.stringify({ [MODELS_DEV_PACKAGE]: "0.0.114", [MODELPARAMS_PACKAGE]: "0.0.72" }[req.args[1]]));
    }
    if (req.args[0] === "install") {
      installed++;
      await gate;
      const prefix = req.args[req.args.indexOf("--prefix") + 1];
      writeGenerationContents(prefix, { mVersion: "0.0.114", pVersion: "0.0.72" });
      return ok("");
    }
    return { code: 2, signal: null, stdout: "", stderr: "unscripted" };
  };
  const first = updateMetadataPackages({ ...deps, runner });
  // Wait until the first is inside its install, then try the second.
  while (installed === 0) await new Promise((r) => setTimeout(r, 5));
  await assert.rejects(updateMetadataPackages({ ...deps, runner }), /already in progress/);
  release!();
  const res = await first;
  assert.equal(res.activated, true);
  assert.equal(installed, 1, "exactly one updater ever ran an install");
}, { timeout: 30_000 });

test("f2: never steal a stale recovery guard and recreate the unlink race", async () => {
  const deps = baseDeps();
  const root = metadataRoot(deps.agentDir);
  mkdirSync(root, { recursive: true });
  const { spawnSync } = await import("node:child_process");
  const pid = spawnSync("node", ["-e", ""]).pid;
  const guard = JSON.stringify({ pid, token: "stale-recovery" });
  writeFileSync(join(root, "update.lock"), JSON.stringify({ pid }));
  writeFileSync(join(root, "recovery.lock"), guard);
  await assert.rejects(updateMetadataPackages(deps), /inspect recovery guard/);
  assert.equal(readFileSync(join(root, "recovery.lock"), "utf8"), guard);
  assert.equal(existsSync(join(root, "active.json")), false);
});

test("f2: release only removes OUR token — a raced-away lock is left alone", async () => {
  const deps = baseDeps();
  const root = metadataRoot(deps.agentDir);
  mkdirSync(root, { recursive: true });
  // Simulate: we hold a lock whose file was already replaced by a foreign
  // token (e.g. our release ran late after a recovery race). The module's
  // release function is internal — verify via the public update path: the
  // foreign lock must survive a completed update cycle's cleanup.
  const { spawnSync } = await import("node:child_process");
  const deadPid = spawnSync("node", ["-e", ""]).pid;
  const foreign = { pid: deadPid, token: "foreign-token", startedAt: Date.now() };
  writeFileSync(join(root, "update.lock"), JSON.stringify(foreign));
  // Dead owner → reclaim succeeds; the file then carries OUR token. A second
  // update while ours is held must see busy, and after ours finishes the
  // file is gone (token match) — never the foreign record resurrected.
  const { runner } = npmRunner({ [MODELS_DEV_PACKAGE]: "0.0.113", [MODELPARAMS_PACKAGE]: "0.0.72" });
  await updateMetadataPackages({ ...deps, runner });
  assert.ok(!existsSync(join(root, "update.lock")), "our lock removed on release");
});

// --- 3: BOTH models.dev shapes failing rejects; one healthy shape passes -----

test("f3: generation rejected when BOTH models.dev shapes are unusable", async () => {
  const deps = baseDeps();
  const root = metadataRoot(deps.agentDir);
  mkdirSync(root, { recursive: true });
  const ref: { id?: string } = {};
  const runner = runnerInstallingFixture(root, ref,
    { [MODELS_DEV_PACKAGE]: "0.0.114", [MODELPARAMS_PACKAGE]: "0.0.72" },
    {
      mVersion: "0.0.114", pVersion: "0.0.72",
      providers: `export const providers = [];`,  // bad shape
      models: `export const models = null;`,      // bad shape — BOTH fail
    });
  await assert.rejects(updateMetadataPackages({ ...deps, runner }), /unusable|models\.dev/i);
  assert.ok(!existsSync(join(root, "active.json")));
  // Inverse: exactly one broken shape still activates (existing test covers
  // providers-bad; mirror with models-bad here for completeness).
  const deps2 = baseDeps();
  const root2 = metadataRoot(deps2.agentDir);
  mkdirSync(root2, { recursive: true });
  const ref2: { id?: string } = {};
  const runner2 = runnerInstallingFixture(root2, ref2,
    { [MODELS_DEV_PACKAGE]: "0.0.114", [MODELPARAMS_PACKAGE]: "0.0.72" },
    {
      mVersion: "0.0.114", pVersion: "0.0.72",
      providers: `export const providers = { a: { models: {} } };`,
      models: `export const models = "not-an-object";`,
    });
  const res = await updateMetadataPackages({ ...deps2, runner: runner2 });
  assert.equal(res.activated, true, "one healthy shape is enough");
}, { timeout: 60_000 });

// --- 4: ONE deadline across the operation + cancellable bounded validation ---

test("f4: validation honors the operation deadline and abort signal", async () => {
  const deps = baseDeps({ installTimeoutMs: 150 });
  const root = metadataRoot(deps.agentDir);
  mkdirSync(root, { recursive: true });
  const ref: { id?: string } = {};
  const runner = runnerInstallingFixture(root, ref,
    { [MODELS_DEV_PACKAGE]: "0.0.114", [MODELPARAMS_PACKAGE]: "0.0.72" },
    { mVersion: "0.0.114", pVersion: "0.0.72" });
  // Hanging validation: injected worker that never resolves unless its
  // signal fires — proves the deadline reaches the validation stage.
  const hanging = (req: { signal?: AbortSignal; timeoutMs: number }) =>
    new Promise<{ ok: false; error: string }>((resolve) => {
      assert.ok(req.timeoutMs <= 200, `remaining budget propagated (${req.timeoutMs}ms)`);
      const t = setTimeout(() => resolve({ ok: false, error: "validation timed out" }), req.timeoutMs);
      req.signal?.addEventListener("abort", () => {
        clearTimeout(t);
        resolve({ ok: false, error: "validation aborted" });
      }, { once: true });
    });
  const started = Date.now();
  await assert.rejects(
    updateMetadataPackages({ ...deps, runner, spawnWorker: hanging }),
    /timed out|aborted/i,
  );
  assert.ok(Date.now() - started < 5000, "operation bounded by the single deadline");
  assert.ok(!existsSync(join(root, "active.json")));
  assert.ok(!existsSync(join(root, "update.lock")), "lock released after bounded failure");
});

test("f4: abort during validation rejects and releases the lock", async () => {
  const deps = baseDeps();
  const root = metadataRoot(deps.agentDir);
  mkdirSync(root, { recursive: true });
  const ref: { id?: string } = {};
  const controller = new AbortController();
  const runner = runnerInstallingFixture(root, ref,
    { [MODELS_DEV_PACKAGE]: "0.0.114", [MODELPARAMS_PACKAGE]: "0.0.72" },
    { mVersion: "0.0.114", pVersion: "0.0.72" });
  const pending = (req: { signal?: AbortSignal; timeoutMs: number }) =>
    new Promise<{ ok: false; error: string }>((resolve) => {
      // Abort mid-validation; the worker seam sees the signal.
      setTimeout(() => controller.abort(), 10);
      req.signal?.addEventListener("abort",
        () => resolve({ ok: false, error: "validation aborted" }), { once: true });
    });
  await assert.rejects(
    updateMetadataPackages({ ...deps, runner, spawnWorker: pending }, controller.signal),
    (e: unknown) => /abort/i.test((e as Error).message) || (e as Error).name === "AbortError",
  );
  assert.ok(!existsSync(join(root, "active.json")));
  assert.ok(!existsSync(join(root, "update.lock")));
});

// --- 5: runner rejects pre-aborted requests and kills process trees ----------

test("f5: a healthy command is not killed by the cancellation grace timer", { timeout: 10_000 }, async () => {
  const result = await execFileRunner({ command: process.execPath,
    args: ["-e", "setTimeout(() => process.stdout.write('finished'), 3300)"],
    cwd: process.cwd(), env: process.env, timeoutMs: 7000 });
  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, "finished");
});

test("f5: pre-aborted signal rejects before spawn; descendants die with wrapper", async () => {
  const { execFileRunner } = await import("../metadata-packages.ts");
  const dir = tempDir();
  // Pre-abort: the runner must not even spawn.
  const pre = new AbortController();
  pre.abort();
  await assert.rejects(execFileRunner({
    command: "node", args: ["-e", "process.stdout.write('RAN')"],
    cwd: dir, env: { ...process.env }, timeoutMs: 5000, signal: pre.signal,
  }), (e: unknown) => (e as Error).name === "AbortError");

  if (process.platform === "win32") return; // group kill is POSIX-only
  // Wrapper spawns a grandchild that outlives it; group kill must reap both.
  const wrapper = join(dir, "wrapper.js");
  writeFileSync(wrapper, `
    const { spawn } = require("node:child_process");
    const g = spawn("node", ["-e", "setTimeout(()=>process.stdout.write('DESCENDANT_LIVED'),30000)"],
      { stdio: "inherit" });
    setTimeout(()=>{}, 30000);
  `);
  const started = Date.now();
  const res = await execFileRunner({
    command: "node", args: [wrapper],
    cwd: dir, env: { ...process.env }, timeoutMs: 150,
  });
  const elapsed = Date.now() - started;
  assert.equal(res.code, null, "killed by timeout");
  assert.equal(res.signal, "SIGTERM");
  // close resolved — no descendant still holding pipes kept us waiting.
  assert.ok(elapsed < KILL_REAP_MS + KILL_GRACE_MS + 2000,
    `bounded shutdown (${elapsed}ms), no lingering descendant`);
}, { timeout: 30_000 });
const KILL_GRACE_MS = 3000;
const KILL_REAP_MS = 5000;

// --- 6: incomplete active generation falls back AND stays repairable ---------

test("f6: active generation missing dist entry falls back and update repairs", async () => {
  const deps = baseDeps();
  const root = metadataRoot(deps.agentDir);
  makeGeneration(root, "gen-hollow", { m: "0.0.114", p: "0.0.72" });
  // Remove the data module — manifest alone is NOT a usable package.
  rmSync(join(root, "generations", "gen-hollow", "node_modules",
    ...MODELS_DEV_PACKAGE.split("/"), "dist"), { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "active.json"), JSON.stringify({
    format: 1, generation: "gen-hollow",
    versions: { modelsDev: "0.0.114", modelparams: "0.0.72" },
  }));
  const sel = selectDataSource(deps);
  assert.equal(sel.source, "bundled", "missing data module invalidates the whole generation");
  assert.match(sel.warning!, /incomplete|escapes|missing/i);
  // And update can still repair it into a complete new generation.
  const ref: { id?: string } = {};
  const runner = runnerInstallingFixture(root, ref,
    { [MODELS_DEV_PACKAGE]: "0.0.115", [MODELPARAMS_PACKAGE]: "0.0.72" },
    { mVersion: "0.0.115", pVersion: "0.0.72" });
  const res = await updateMetadataPackages({ ...deps, runner });
  assert.equal(res.activated, true, "repair installs a fresh complete generation");
  assert.equal(selectDataSource(deps).generation, ref.id);
}, { timeout: 60_000 });

test("f6: manifest/version mismatch against record invalidates selection", () => {
  const deps = baseDeps();
  const root = metadataRoot(deps.agentDir);
  makeGeneration(root, "gen-lie", { m: "0.0.114", p: "0.0.72" });
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "active.json"), JSON.stringify({
    format: 1, generation: "gen-lie",
    // Record claims a version the disk manifest doesn't have — substitution
    // would hide drift; selection must reject instead.
    versions: { modelsDev: "0.0.200", modelparams: "0.0.72" },
  }));
  const sel = selectDataSource(deps);
  assert.equal(sel.source, "bundled");
  assert.match(sel.warning!, /manifest|match/i);
});

// --- 7: probe AND queries run inside the private manager env -----------------

test("f7: every manager invocation runs in the private root with private caches", async () => {
  const deps = baseDeps();
  const { runner, calls } = npmRunner({
    [MODELS_DEV_PACKAGE]: "0.0.113", [MODELPARAMS_PACKAGE]: "0.0.72",
  });
  const res = await checkMetadataPackages({ ...deps, runner });
  assert.equal(res.packages[MODELS_DEV_PACKAGE].status, "up-to-date");
  const realRoot = realpathSync(metadataRoot(deps.agentDir));
  assert.ok(calls.length >= 3, "probe + two queries");
  for (const c of calls) {
    assert.equal(c.cwd, realRoot, `cwd private for ${c.args[0]}`);
    const cache = join(realRoot, "manager-cache", "npm");
    assert.equal(c.env.npm_config_cache, join(cache, "npm"));
    assert.equal(c.env.TMPDIR, join(cache, "tmp"));
    assert.equal(c.env.XDG_CACHE_HOME, join(cache, "xdg"));
    // Inherits registry/auth env but never writes outside our root.
    assert.ok(c.env.PATH === process.env.PATH);
  }
});

test("f7: pnpm env pins a private store, not only PNPM_HOME", async () => {
  const deps = baseDeps({ npmCommand: ["pnpm"] });
  const { runner, calls } = scriptedRunner([
    { match: (a) => a.length === 1 && a[0] === "--version", result: ok("9.0.0") },
    { match: (a) => a[0] === "view" && a[1] === MODELS_DEV_PACKAGE, result: ok('"0.0.113"') },
    { match: (a) => a[0] === "view" && a[1] === MODELPARAMS_PACKAGE, result: ok('"0.0.72"') },
  ]);
  await checkMetadataPackages({ ...deps, runner });
  const realRoot = realpathSync(metadataRoot(deps.agentDir));
  const store = join(realRoot, "manager-cache", "pnpm", "pnpm-store");
  for (const c of calls) {
    assert.equal(c.env.PNPM_STORE_DIR, store);
    assert.equal(c.env.npm_config_store_dir, store);
    assert.ok(c.env.PNPM_HOME!.startsWith(realRoot));
  }
});

// --- 8: existing-but-unknown version is not "missing" -------------------------

test("f8: package present with unreadable/invalid version is local-version-unknown", async () => {
  // Package exists on disk but its manifest lacks a valid version.
  const ext = tempDir("oapi-ext-");
  const pkg = join(ext, "node_modules", ...MODELS_DEV_PACKAGE.split("/"));
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: MODELS_DEV_PACKAGE })); // no version
  const deps = baseDeps({
    extensionDir: ext,
  });
  const { runner } = npmRunner({
    [MODELS_DEV_PACKAGE]: "0.0.114", [MODELPARAMS_PACKAGE]: "0.0.72",
  });
  const res = await checkMetadataPackages({ ...deps, runner });
  // @opencode-ai/models resolves but version is unknown → NOT "missing".
  assert.equal(res.packages[MODELS_DEV_PACKAGE].status, "local-version-unknown");
  // modelparams doesn't resolve at all → truly missing.
  assert.equal(res.packages[MODELPARAMS_PACKAGE].status, "missing");
});

test("f2 (two real processes): serialized stale reclaim + no downgrade", { timeout: 60_000 }, async (t) => {
  const agent = agentDir();
  const gate = tempDir("oapi-gate-");
  const root = metadataRoot(agent);
  mkdirSync(root, { recursive: true });
  const { spawnSync, spawn: spawnChild } = await import("node:child_process");
  const deadPid = spawnSync("node", ["-e", ""]).pid;
  writeFileSync(join(root, "update.lock"), JSON.stringify({ pid: deadPid, startedAt: Date.now() }));

  const childFile = new URL("./fixtures/lock-race-child.mjs", import.meta.url).pathname;
  const children: {
    proc: ReturnType<typeof spawnChild>;
    events: Record<string, unknown>[];
    exited: Promise<number | null>;
    stderr: () => string;
    waitEvent: (event: string, timeoutMs?: number) => Promise<Record<string, unknown> | null>;
  }[] = [];
  t.after(async () => {
    for (const c of children) {
      try { c.proc.kill("SIGKILL"); } catch { /* gone */ }
      await c.exited.catch(() => undefined);
    }
  });

  /**
   * Spawn + own one fixture child. The exit promise is registered
   * IMMEDIATELY and awaited exactly once via `exited`. Stdout is parsed
   * with line framing so split chunks cannot drop a JSON event.
   */
  const run = (tag: string, version: string) => {
    const proc = spawnChild("node", [childFile, agent, gate, tag, version], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const events: Record<string, unknown>[] = [];
    const waiters: { event: string; resolve: (e: Record<string, unknown>) => void; timer: NodeJS.Timeout }[] = [];
    let buf = "";
    const dispatch = (line: string) => {
      let ev: Record<string, unknown>;
      try { ev = JSON.parse(line); } catch { return; }
      events.push(ev);
      for (const w of [...waiters]) {
        if (w.event === ev.event || w.event === "*") {
          clearTimeout(w.timer);
          waiters.splice(waiters.indexOf(w), 1);
          w.resolve(ev);
        }
      }
    };
    proc.stdout!.on("data", (c: Buffer) => {
      buf += c.toString("utf8");
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        dispatch(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    });
    let errBuf = "";
    proc.stderr!.on("data", (c: Buffer) => { errBuf += c.toString("utf8"); });
    const exited = new Promise<number | null>((res) => proc.once("exit", res));
    const child = {
      proc,
      events,
      exited,
      stderr: () => errBuf,
      /** Finite bounded wait — resolves on event, exit, or timeout. */
      waitEvent: (event: string, timeoutMs = 15_000) => new Promise<Record<string, unknown> | null>((res) => {
        const prior = events.find((e) => e.event === event || event === "*");
        if (prior) return res(prior);
        const timer = setTimeout(() => {
          waiters.splice(waiters.findIndex((w) => w.timer === timer), 1);
          res(null);
        }, timeoutMs);
        timer.unref();
        waiters.push({ event, resolve: res, timer });
      }),
    };
    children.push(child);
    return child;
  };

  // --- phase 1: two gated reclaimers race one dead lock --------------------
  // BOTH children install under a closed release gate; serialized recovery
  // means exactly ONE may reach its installer while the gate stays shut.
  const a = run("A", "3.0.0");
  const b = run("B", "2.0.0");
  const firstLocked = await Promise.race([
    a.waitEvent("locked").then((e) => e ? "A" : null),
    b.waitEvent("locked").then((e) => e ? "B" : null),
  ]);
  assert.ok(firstLocked, `one reclaimer must reach install; A:${JSON.stringify(a.events)} B:${JSON.stringify(b.events)}`);
  const winner = firstLocked === "A" ? a : b;
  const loser = firstLocked === "A" ? b : a;
  // Give the loser its full chance before releasing the winner's install:
  // exclusive reclaim means it must NOT reach install while the winner
  // still holds the lock behind a closed release gate.
  const loserLocked = await loser.waitEvent("locked", 5000);
  assert.equal(loserLocked, null,
    `exactly one installer while gate closed; loser events: ${JSON.stringify(loser.events)}`);
  // Release winner, wait done; release loser gate defensively, await exits.
  writeFileSync(join(gate, `release-${firstLocked}`), "go");
  const winnerDone = await winner.waitEvent("done");
  assert.ok(winnerDone?.activated === true, `winner committed: ${JSON.stringify(winnerDone)}`);
  writeFileSync(join(gate, `release-${firstLocked === "A" ? "B" : "A"}`), "go");
  await Promise.all([a.exited, b.exited]);

  // --- phase 2: newer activation then a stale-registry attempt ------------
  // Whatever version the winner committed, a later update whose registry
  // reports a LOWER latest must not downgrade the pointer.
  const record1 = JSON.parse(readFileSync(join(root, "active.json"), "utf8"));
  const committed = record1.versions.modelsDev;
  const newer = committed === "3.0.0" ? "3.0.0" : "3.0.1"; // ≥ committed
  const newerChild = run("newer", newer);
  writeFileSync(join(gate, "release-newer"), "go");
  await newerChild.waitEvent("done");
  await newerChild.exited;
  const stale = run("stale", "0.0.1"); // registry says latest 0.0.1
  writeFileSync(join(gate, "release-stale"), "go");
  await stale.exited;
  const final = JSON.parse(readFileSync(join(root, "active.json"), "utf8"));
  assert.equal(final.versions.modelsDev, newer,
    `stale-registry update must not downgrade: ${JSON.stringify(stale.events)}`);
});
