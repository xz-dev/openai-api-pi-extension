import assert from "node:assert/strict";
import { test } from "node:test";
import { adoptResponseAncestry, checkpointsEnabled, responseAncestry } from "../checkpoint-adapter.ts";
import extension from "../index.ts";

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

function projectionFixture(boundary: "compaction" | "branch_summary" | false = "compaction") {
  const before: any = { id: "before", type: "message", message: { role: "assistant", content: [{ type: "text", text: "retained" }],
    responseId: "old-id", responseCheckpoint: { version: 1 }, responseAncestry: "server-dependent" } };
  const summary: any = { id: "summary", type: boundary, summary: "not inspected", firstKeptEntryId: "before", fromId: "before" };
  const after: any = { id: "after", type: "message", message: { role: "assistant", content: [{ type: "text", text: "later" }],
    responseId: "later-id", responseAncestry: "server-dependent" } };
  const entries: any[] = boundary ? [{ sourceEntry: summary, messages: [{ role: boundary === "compaction" ? "compactionSummary" : "branchSummary", summary: "not inspected" }] },
    { sourceEntry: before, messages: [before.message] }, { sourceEntry: after, messages: [after.message] }]
    : [{ sourceEntry: before, messages: [before.message] }, { sourceEntry: after, messages: [after.message] }];
  const branch = boundary ? [before, summary, after] : [before, after];
  return { before, after, branch, entries, manager: { getBranch: () => branch, buildSessionProjection: () => ({ entries }) },
    messages: () => structuredClone(entries.flatMap((entry) => entry.messages)) };
}

for (const boundary of ["compaction", "branch_summary"] as const) test(`context adoption uses canonical source provenance for ${boundary}, not projected order`, () => {
  const f = projectionFixture(boundary);
  const input = f.messages(), inputBefore = structuredClone(input), rawBefore = structuredClone(f.branch);
  const result: any = adoptResponseAncestry(input, f.manager);
  assert.ok(result);
  assert.equal(result[1].responseAncestry, "local");
  assert.equal(Object.hasOwn(result[1], "responseId"), false);
  assert.equal(Object.hasOwn(result[1], "responseCheckpoint"), false);
  assert.equal(result[2].responseAncestry, "server-dependent", "later output is not adopted by old summary");
  assert.equal(result[2].responseId, "later-id");
  assert.deepEqual(input, inputBefore, "event input remains unchanged");
  assert.deepEqual(f.branch, rawBefore, "raw entries remain unchanged");
  // A corrected host already supplies these copies: another hook pass is a no-op.
  f.entries[1].messages = [result[1]];
  assert.equal(adoptResponseAncestry(f.messages(), f.manager), undefined);
  f.entries[1].messages = [];
  assert.equal(adoptResponseAncestry(f.messages(), f.manager), undefined, "already omitted adopted content needs no extra marker");
});

test("context adoption declines untraceable/reordered/filtered/replaced/ambiguous input", () => {
  const f = projectionFixture();
  for (const transform of [
    (input: any[]) => input.reverse(),
    (input: any[]) => input.slice(1),
    (input: any[]) => input.map((message) => message.role === "assistant" ? { ...message, content: [] } : message),
  ]) {
    const input = transform(f.messages()), before = structuredClone(input);
    assert.equal(adoptResponseAncestry(input, f.manager), undefined);
    assert.deepEqual(input, before);
  }
  f.after.message = structuredClone(f.before.message);
  f.entries[2].messages = [f.after.message];
  assert.equal(adoptResponseAncestry(f.messages(), f.manager), undefined, "duplicate equal messages from different sources are ambiguous");
});

test("context association preserves malformed own-property presence, including own undefined", () => {
  for (const value of [undefined, null, "", 1, {}]) {
    const f = projectionFixture();
    f.before.message.responseAncestry = value;
    const input = f.messages();
    delete input[1].responseAncestry;
    assert.equal(adoptResponseAncestry(input, f.manager), undefined, "absence cannot equal present malformed data");
    const associated: any = adoptResponseAncestry(f.messages(), f.manager);
    assert.equal(associated[1].responseAncestry, "local", "actual associated pre-boundary malformed copy is adopted");
    assert.equal(Object.hasOwn(f.before.message, "responseAncestry"), true);
    assert.deepEqual(f.before.message.responseAncestry, value);
  }
});

test("ordinary user/local and plain edits are not boundaries; omitted unsafe/legacy facts survive", () => {
  for (const fact of ["server-dependent", null, undefined, "absent"]) {
    const f = projectionFixture(false);
    if (fact === "absent") delete f.before.message.responseAncestry;
    else f.before.message.responseAncestry = fact;
    f.entries.pop(); f.branch.pop();
    const followup: any = { id: "user", type: "message", message: { role: "user", content: "ordinary", responseAncestry: "local" } };
    f.branch.push(followup); f.entries.push({ sourceEntry: followup, messages: [followup.message] });
    assert.equal(adoptResponseAncestry(f.messages(), f.manager), undefined);
    f.entries[0].messages = [];
    const result: any = adoptResponseAncestry(f.messages(), f.manager);
    assert.deepEqual(result[0].content, []);
    assert.equal(Object.hasOwn(result[0], "responseAncestry"), fact !== "absent");
    assert.equal(responseAncestry({ messages: result } as any), fact === "absent" ? "legacy" : fact === "server-dependent" ? "server-dependent" : "unknown");
    assert.equal(f.before.message.content[0].text, "retained");
  }
});

test("factory registers distinct context/session hooks and returns only copied adopted messages", async (t) => {
  const saved = process.env.PI_OFFLINE; process.env.PI_OFFLINE = "1";
  t.after(() => { if (saved === undefined) delete process.env.PI_OFFLINE; else process.env.PI_OFFLINE = saved; });
  const handlers = new Map<string, Function[]>();
  await extension({ on(name: string, handler: Function) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    registerEntryRenderer() {}, registerCommand() {}, registerProvider() {} } as any);
  assert.equal(handlers.get("session_start")?.length, 1);
  assert.equal(handlers.get("context")?.length, 1);
  const f = projectionFixture();
  const input = f.messages(), before = structuredClone(input);
  const result = handlers.get("context")![0]({ type: "context", messages: input }, { sessionManager: f.manager });
  assert.equal(result.messages[1].responseAncestry, "local");
  assert.deepEqual(input, before);
  const otherModel = { sessionManager: f.manager, model: { provider: "another-provider" } };
  const crossProvider = handlers.get("context")![0]({ type: "context", messages: input }, otherModel);
  assert.equal(crossProvider.messages[1].responseAncestry, "local", "structured host baseline is model-neutral");
  assert.equal(crossProvider.messages[2].responseAncestry, "server-dependent", "later negative survives provider switch");
  const rewritten = input.map((message: any) => message.role === "assistant"
    ? { ...message, content: [{ type: "text", text: "earlier extension rewrite" }] } : message);
  const rewrittenBefore = structuredClone(rewritten);
  assert.equal(handlers.get("context")![0]({ type: "context", messages: rewritten }, otherModel), undefined);
  assert.deepEqual(rewritten, rewrittenBefore, "unassociated third-party rewrites are not adopted or mutated");
  assert.deepEqual(input, before);
});
