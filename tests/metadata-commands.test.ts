import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createMetadataCommands, metadataHostRuntime, metadataOffline, type MetadataCommandOptions } from "../metadata-commands.ts";
import { MANAGED_PACKAGES, type CheckResult, type UpdateResult } from "../metadata-packages.ts";
import { OUTPUT_PREFIX } from "../notification.ts";

const originalOffline = process.env.PI_OFFLINE;
afterEach(() => {
  if (originalOffline === undefined) delete process.env.PI_OFFLINE;
  else process.env.PI_OFFLINE = originalOffline;
});

function checked(updates = true): CheckResult {
  return { manager: { kind: "npm", reason: "test" }, updateAvailable: updates, packages: {
    [MANAGED_PACKAGES[0]]: { status: updates ? "update-available" : "up-to-date", localVersion: "1.0.0", latest: updates ? "2.0.0" : "1.0.0" },
    [MANAGED_PACKAGES[1]]: { status: "up-to-date", localVersion: "1.0.0", latest: "1.0.0" },
  } };
}

function fixture(overrides: MetadataCommandOptions = {}) {
  const notices: { message: string; level?: string }[] = [];
  const refreshes: unknown[] = [];
  let authReads = 0;
  const ctx = {
    hasUI: true, mode: "rpc", cwd: process.cwd(), isProjectTrusted: () => false,
    signal: undefined as AbortSignal | undefined,
    ui: { notify: (message: string, level?: string) => notices.push({ message, level }) },
    modelRegistry: {
      getProviderAuth: async () => { authReads++; return { auth: { apiKey: "sk-local-secret", baseUrl: "https://gateway.invalid/v1" } }; },
      refresh: async (options: unknown) => { refreshes.push(options); return { aborted: false, errors: new Map() }; },
    },
  };
  const update: UpdateResult = { activated: true, versions: { modelsDev: "2.0.0", modelparams: "1.0.0" }, manager: "npm", packages: {
    [MANAGED_PACKAGES[0]]: { previous: "1.0.0", target: "2.0.0", action: "installed" },
    [MANAGED_PACKAGES[1]]: { previous: "1.0.0", target: "1.0.0", action: "kept" },
  } };
  const commands = createMetadataCommands({
    getDeps: () => ({ agentDir: "/unused-test-root", hostRuntime: { bunRuntime: false, bunBinary: false, execPath: process.execPath } }),
    automaticState: { started: false },
    check: async () => checked(), update: async () => update, ...overrides,
  });
  return { commands, ctx, notices, refreshes, authReads: () => authReads };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("check requires no gateway, renders versions and does not refresh or export", async () => {
  const f = fixture();
  assert.equal(await f.commands.handle("check", f.ctx as never), true);
  assert.equal(f.authReads(), 0);
  assert.deepEqual(f.refreshes, []);
  assert.ok(f.notices[0].message.startsWith(`${OUTPUT_PREFIX} `));
  assert.match(f.notices[0].message, /@opencode-ai\/models: 1\.0\.0 -> 2\.0\.0/);
  assert.match(f.notices[0].message, /\/provider-metadata update/);
});

test("empty args retain export; unknown and extra args are usage only", async () => {
  const f = fixture({ getDeps: () => assert.fail("must not read settings") });
  assert.equal(await f.commands.handle("  ", f.ctx as never), false);
  for (const args of ["unknown", "check extra", "update @arbitrary/package"]) {
    assert.equal(await f.commands.handle(args, f.ctx as never), true);
  }
  assert.equal(f.authReads(), 0);
  assert.ok(f.notices.every((n) => n.level === "warning" && /Usage:/.test(n.message)));
});

test("offline commands never call registry or installer", async () => {
  process.env.PI_OFFLINE = "yes";
  assert.equal(metadataOffline(), true);
  const f = fixture({ check: async () => assert.fail("registry"), update: async () => assert.fail("installer") });
  await f.commands.handle("check", f.ctx as never);
  await f.commands.handle("update", f.ctx as never);
  assert.equal(f.authReads(), 0);
  assert.ok(f.notices.every((n) => /Offline:/.test(n.message)));
});

test("registry failure stays a warning and secrets are redacted", async () => {
  const result = checked(false);
  result.packages[MANAGED_PACKAGES[1]] = { status: "query-failed", reason: "401 Bearer npm-secret" };
  const f = fixture({ check: async () => result });
  await f.commands.handle("check", f.ctx as never);
  assert.equal(f.notices[0].level, "warning");
  assert.match(f.notices[0].message, /query-failed/);
  assert.doesNotMatch(f.notices[0].message, /npm-secret/);
});

test("scoped npm authentication diagnostics never leak through check notifications", async () => {
  for (const reason of ["//registry.example/:_authToken=npm-FAKE-COMMAND", "_auth=BASE64-FAKE-COMMAND"]) {
    const result = checked(false);
    result.packages[MANAGED_PACKAGES[0]] = { status: "query-failed", reason };
    const f = fixture({ check: async () => result });
    await f.commands.handle("check", f.ctx as never);
    assert.match(f.notices[0].message, /query-failed/);
    assert.match(f.notices[0].message, /\[REDACTED\]/);
    assert.doesNotMatch(f.notices[0].message, /FAKE-COMMAND/);
  }
});

test("successful activation refreshes exactly this provider without restart", async () => {
  const f = fixture();
  await f.commands.handle("update", f.ctx as never);
  assert.equal(f.refreshes.length, 1);
  const options = f.refreshes[0] as { providers: string[]; allowNetwork: boolean; force: boolean; signal: AbortSignal };
  assert.deepEqual(options.providers, ["openai-api-extension"]);
  assert.equal(options.allowNetwork, true);
  assert.equal(options.force, true);
  assert.ok(options.signal instanceof AbortSignal);
  assert.match(f.notices[0].message, /models\.dev 2\.0\.0, modelparams\.dev 1\.0\.0/);
  assert.match(f.notices[0].message, /model catalog refreshed/);
});

test("no-op update neither authenticates nor refreshes", async () => {
  const f = fixture({ update: async () => ({ activated: false, versions: {}, manager: "npm", packages: {} } as UpdateResult) });
  await f.commands.handle("update", f.ctx as never);
  assert.equal(f.authReads(), 0);
  assert.deepEqual(f.refreshes, []);
  assert.match(f.notices[0].message, /already current/);
});

test("activation is retained when gateway is absent, fails or refresh aborts", async () => {
  for (const state of ["absent", "failed", "aborted", "throw"] as const) {
    const f = fixture();
    if (state === "absent") f.ctx.modelRegistry.getProviderAuth = async () => undefined as never;
    else f.ctx.modelRegistry.refresh = async () => {
      if (state === "throw") throw new Error("cannot refresh sk-local-secret");
      return { aborted: state === "aborted", errors: state === "failed" ? new Map([["openai-api-extension", new Error("bad YAML sk-local-secret")]]) : new Map() };
    };
    await f.commands.handle("update", f.ctx as never);
    assert.match(f.notices[0].message, /Data packages updated/);
    assert.doesNotMatch(f.notices[0].message, /sk-local-secret|model catalog refreshed\./);
    assert.match(f.notices[0].message, /after configuring|not refreshed|cancelled/);
  }
});

test("cancel before activation reports cancellation and never refreshes", async () => {
  const controller = new AbortController();
  const f = fixture({ update: async (_deps, signal) => {
    await new Promise<void>((_resolve, reject) => signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }));
    return assert.fail("cancelled");
  } });
  f.ctx.signal = controller.signal;
  const pending = f.commands.handle("update", f.ctx as never);
  controller.abort();
  await pending;
  assert.deepEqual(f.refreshes, []);
  assert.match(f.notices[0].message, /cancelled/);
});

test("background is detached, once per process state, and suppresses stale results", async () => {
  let resolveCheck!: (value: CheckResult) => void;
  let checks = 0;
  const state = { started: false };
  const f = fixture({ automaticState: state, check: () => { checks++; return new Promise((resolve) => { resolveCheck = resolve; }); } });
  f.ctx.mode = "tui";
  f.commands.setSession(f.ctx as never);
  f.commands.backgroundCheck();
  f.commands.backgroundCheck();
  await tick();
  assert.equal(checks, 1);
  assert.deepEqual(f.notices, [], "pending check does not block or notify");
  f.commands.shutdown();
  resolveCheck(checked());
  await tick();
  assert.deepEqual(f.notices, [], "old session must not be notified");
  const replacement = fixture({ automaticState: state, check: async () => assert.fail("already scheduled") });
  replacement.ctx.mode = "tui";
  replacement.commands.setSession(replacement.ctx as never);
  replacement.commands.backgroundCheck();
  await tick();
});

test("background notifies only updates; CLI, failure and current versions stay quiet", async () => {
  for (const mode of ["print", "rpc", "tui-current", "tui-error", "tui-update"]) {
    const f = fixture({ check: async () => {
      if (mode === "print" || mode === "rpc") assert.fail("non-interactive network");
      if (mode === "tui-error") throw new Error("registry unreachable");
      return checked(mode === "tui-update");
    } });
    f.ctx.mode = mode.startsWith("tui") ? "tui" : mode;
    f.commands.setSession(f.ctx as never);
    f.commands.backgroundCheck();
    await tick();
    assert.equal(f.notices.length, mode === "tui-update" ? 1 : 0);
    f.commands.shutdown();
  }
});

test("shutdown aborts and awaits owned operation cleanup before returning", async () => {
  let cleaned = false;
  const f = fixture({ update: async (_deps, signal) => {
    await new Promise<void>((_resolve, reject) => signal!.addEventListener("abort", () => {
      setTimeout(() => { cleaned = true; reject(signal!.reason); }, 10);
    }, { once: true }));
    return assert.fail("cancelled");
  } });
  const running = f.commands.handle("update", f.ctx as never);
  const stopped = f.commands.shutdown();
  assert.equal(cleaned, false);
  await stopped;
  await running;
  assert.equal(cleaned, true);
  assert.deepEqual(f.notices, [], "shutdown cannot notify an expired session");
});

test("runtime detection does not mistake disk extension or source paths for standalone", () => {
  assert.equal(metadataHostRuntime(process.cwd()).bunBinary, false);
});
