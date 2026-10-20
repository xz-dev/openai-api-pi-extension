import assert from "node:assert/strict";
import { test } from "node:test";
import { checkpointsEnabled } from "../checkpoint-adapter.ts";

test("checkpoint policy: raw validation and minimatch identity/segment semantics", () => {
  const model: any = { provider: "openai-api-extension", id: "mock/nested", name: "Display Only",
    baseUrl: "http://127.0.0.1/v1", compat: { supportsResponseCheckpoints: true } };
  const options: any = { transport: "auto", apiKey: "dummy" };
  const cases: [string, unknown, boolean][] = [
    ["absent", undefined, true], ["empty", [], true], ["star includes slash", ["*"], false],
    ["provider", ["OPENAI-API-*"], false], ["model", ["MOCK/*"], false],
    ["combined", ["OPENAI-API-EXTENSION/MOCK/*"], false],
    ["braces", ["{other,mock}/nested"], false], ["class", ["mock/[no]ested"], false],
    ["globstar", ["openai-api-extension/**"], false],
    ["segment is not globstar", ["openai-api-extension/*"], true],
    ["display name ignored", ["Display Only"], true], ["unrelated", ["other/**"], true],
    ["null", null, false], ["string", "*", false], ["object", {}, false],
    ["invalid member", ["unrelated", 1], false], ["null member", [null], false],
    ["sparse", Array(1), false],
  ];
  for (const [label, raw, enabled] of cases) {
    assert.equal(checkpointsEnabled(model, options, raw), enabled, label);
  }
});

test("checkpoint policy: responseCheckpointMode matrix over compat declaration and service", () => {
  const base: any = { provider: "openai-api-extension", id: "mock/nested", name: "Display Only",
    baseUrl: "http://127.0.0.1/v1" };
  const official: any = { ...base, provider: "openai", id: "official", baseUrl: "https://api.openai.com/v1" };
  const options = (mode: unknown): any => ({ transport: "auto", apiKey: "sk-test",
    ...(mode === undefined ? {} : { responseCheckpointMode: mode }) });
  for (const capability of [undefined, true, false]) {
    const custom = { ...base, compat: capability === undefined ? {} : { supportsResponseCheckpoints: capability } };
    const declared = { ...official, compat: capability === undefined ? {} : { supportsResponseCheckpoints: capability } };
    // always: try regardless of compat, even explicit false.
    assert.equal(checkpointsEnabled(custom, options("always"), []), true, `always/custom/${capability}`);
    assert.equal(checkpointsEnabled(declared, options("always"), []), true, `always/official/${capability}`);
    // auto: only an explicit false declaration skips.
    assert.equal(checkpointsEnabled(custom, options("auto"), []), capability !== false, `auto/custom/${capability}`);
    assert.equal(checkpointsEnabled(declared, options("auto"), []), capability !== false, `auto/official/${capability}`);
    // declared: exact true, or the official service default.
    assert.equal(checkpointsEnabled(custom, options("declared"), []), capability === true, `declared/custom/${capability}`);
    assert.equal(checkpointsEnabled(declared, options("declared"), []),
      capability === true || capability === undefined, `declared/official/${capability}`);
    // Absent mode behaves as always.
    assert.equal(checkpointsEnabled(custom, options(undefined), []), true, `absent/custom/${capability}`);
  }
  // Malformed modes fail closed.
  for (const bad of [null, "", "on", true, 1, ["always"], {}]) {
    assert.equal(checkpointsEnabled({ ...base, compat: { supportsResponseCheckpoints: true } },
      options(bad), []), false, `malformed ${JSON.stringify(bad)}`);
  }
  // Hard gates still apply in always mode.
  const custom = { ...base, compat: { supportsResponseCheckpoints: true } };
  for (const [label, gate] of [
    ["sse", { transport: "sse" }],
    ["websocket uncached", { transport: "websocket" }],
    ["cacheRetention none", { transport: "auto", cacheRetention: "none" }],
  ] as const) {
    assert.equal(checkpointsEnabled(custom, { ...options("always"), ...gate }, []), false, label);
  }
  assert.equal(checkpointsEnabled({ ...custom, provider: "openai-codex" }, options("always"), []), false, "codex");
  assert.equal(checkpointsEnabled({ ...custom, baseUrl: "https://chatgpt.com/backend-api/codex/responses" },
    options("always"), []), false, "chatgpt");
  assert.equal(checkpointsEnabled({ ...custom, baseUrl: "https://CHATGPT.COM/backend-api/codex" },
    options("always"), []), false, "uppercase chatgpt host");
  assert.equal(checkpointsEnabled({ ...custom, baseUrl: "https://api.chatgpt.com/v1" },
    options("always"), []), false, "chatgpt subdomain");
});

test("checkpoint policy uses effective model/options Authorization, not unused apiKey", () => {
  const model: any = { provider: "openai", id: "mock", baseUrl: "https://api.openai.com/v1" };
  const options: any = { transport: "auto", apiKey: "sk-unused" };
  assert.equal(checkpointsEnabled(model, { ...options, transport: undefined }, []), true, "absent transport defaults to auto");
  assert.equal(checkpointsEnabled(model, { ...options, headers: { Authorization: "Bearer chatgpt-token" } }, []), false);
  assert.equal(checkpointsEnabled({ ...model, headers: { Authorization: "Bearer chatgpt-token" } }, options, []), false);
  assert.equal(checkpointsEnabled({ ...model, headers: { Authorization: "Bearer chatgpt-token" } },
    { ...options, apiKey: "unused", headers: { authorization: "Bearer sk-effective" } }, []), true);
  assert.equal(checkpointsEnabled({ ...model, headers: { authorization: "Bearer sk-model" } },
    { ...options, headers: { Authorization: "Bearer chatgpt-token" } }, []), false);
  assert.equal(checkpointsEnabled(model, { ...options, headers: { "cf-aig-authorization": "Bearer cf-token" } }, []), false);
});
