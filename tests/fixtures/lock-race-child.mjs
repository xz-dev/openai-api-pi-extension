/**
 * Two-process stale-lock race fixture. Spawned as:
 *   node lock-race-child.mjs <agentDir> <gateDir> <tag> <registryLatest>
 *
 * Runs updateMetadataPackages with an injected runner. "view" answers
 * <registryLatest> as latest for both packages; "install" reads the exact
 * pinned targets from the generation's own package.json (written by the
 * update itself) and installs THOSE versions — never a hard-coded fake, so
 * the real manifest-identity validation can still fire. The child then
 * reports "locked" and waits for <gateDir>/release-<tag> (poll bounded by
 * a deadline) before letting the install return.
 *
 * Prints JSON lines: {tag, event:"locked"|"done"|"error", ...}.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [root, gateDir, tag, registryLatest] = process.argv.slice(2);
const { updateMetadataPackages } = await import(new URL("../../metadata-packages.ts", import.meta.url).href);

const ok = (stdout = "") => ({ code: 0, signal: null, stdout, stderr: "" });
const PACKAGES = ["@opencode-ai/models", "modelparams"];
const RELEASE_DEADLINE_MS = 50_000;

function writePackages(prefix) {
  // Exact targets come from the generation manifest the update wrote —
  // this is what a real manager would install, so identity checks are real.
  const manifest = JSON.parse(readFileSync(join(prefix, "package.json"), "utf8"));
  for (const name of PACKAGES) {
    const version = manifest.dependencies?.[name];
    if (!version) throw new Error(`no pinned dep for ${name}`);
    const pkg = join(prefix, "node_modules", ...name.split("/"));
    mkdirSync(join(pkg, "dist"), { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name, version }));
    const file = name === PACKAGES[0] ? "snapshot.js" : "index.js";
    const body = name === PACKAGES[0]
      ? `export const providers = {}; export const models = {};`
      : `export const CATALOG = [];`;
    writeFileSync(join(pkg, "dist", file), body + "\n");
  }
}

const runner = async (req) => {
  if (req.args.length === 1 && req.args[0] === "--version") return ok("10");
  if (req.args[0] === "view") return ok(JSON.stringify(registryLatest));
  if (req.args[0] === "install") {
    const prefix = req.args[req.args.indexOf("--prefix") + 1];
    writePackages(prefix);
    console.log(JSON.stringify({ tag, event: "locked" }));
    // Bounded release wait: honors abort signal and an absolute deadline.
    const releaseFile = join(gateDir, `release-${tag}`);
    const deadline = Date.now() + RELEASE_DEADLINE_MS;
    while (!existsSync(releaseFile)) {
      req.signal?.throwIfAborted?.();
      if (Date.now() > deadline) throw new Error("release gate timed out");
      await new Promise((r) => setTimeout(r, 10));
    }
    return ok("");
  }
  return { code: 2, signal: null, stdout: "", stderr: "unscripted" };
};

try {
  const res = await updateMetadataPackages({
    agentDir: root,
    extensionDir: join(gateDir, "no-bundled"), // force "missing" → always install
    hostRuntime: { bunRuntime: false, bunBinary: false, execPath: process.execPath },
    runner,
    installTimeoutMs: 60_000,
    queryTimeoutMs: 10_000,
  });
  let activeVersion;
  try {
    const rec = JSON.parse(readFileSync(join(root, "cache/openai-api-pi-extension/metadata/active.json"), "utf8"));
    activeVersion = rec.versions.modelsDev;
  } catch { /* none */ }
  console.log(JSON.stringify({ tag, event: "done", activated: res.activated, activeVersion }));
} catch (error) {
  console.log(JSON.stringify({ tag, event: "error", message: String(error && error.message || error) }));
}
