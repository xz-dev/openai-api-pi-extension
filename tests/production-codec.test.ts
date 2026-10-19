import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { registerHooks } from "node:module";
import { WebSocketServer } from "ws";
import { discoverAndLoadExtensions, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { openAIResponsesApi } from "@earendil-works/pi-ai/compat";
import { encodeCheckpointOutput } from "../checkpoint-adapter.ts";
import { readJsonBody } from "./fixtures/wire-decode.ts";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const input = (text: string) => ({ role: "user", content: [{ type: "input_text", text }] });
const user = (text: string) => ({ role: "user" as const, content: text, timestamp: 1 });
const textItem = (id: string) => ({ type: "message", id: `msg_${id}`, role: "assistant", status: "completed",
  content: [{ type: "output_text", text: "ok", annotations: [] }] });
const reasoning = { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "encrypted+/opaque==" };
const call = { type: "function_call", id: "fc_1", call_id: "call_1", name: "lookup", arguments: '{"query":"a\\nb"}' };
const grammar = { type: "custom_tool_call", id: "ctc_1", call_id: "custom_1", name: "calculate", input: "1 + 2\n" };
const tools: any[] = [
  { name: "lookup", description: "Lookup", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
  { name: "calculate", description: "Calculate", parameters: { type: "object", properties: { expression: { type: "string" } }, required: ["expression"] },
    constrainedSampling: { type: "grammar", variants: { openai_regex: "[0-9 +\\n]+" } } },
];
function events(id: string, items: any[]) {
  const result: any[] = [{ type: "response.created", response: { id } }];
  for (const [output_index, item] of items.entries()) {
    result.push({ type: "response.output_item.added", output_index,
      item: item.type === "function_call" ? { ...item, arguments: "" } : item.type === "custom_tool_call" ? { ...item, input: "" } : item });
    if (item.type === "message") result.push({ type: "response.output_text.delta", output_index, content_index: 0, delta: "ok" });
    if (item.type === "function_call") result.push({ type: "response.function_call_arguments.delta", output_index, delta: item.arguments });
    if (item.type === "custom_tool_call") result.push({ type: "response.custom_tool_call_input.delta", output_index, delta: item.input });
    result.push({ type: "response.output_item.done", output_index, item });
  }
  result.push({ type: "response.completed", response: { id, status: "completed", output: items,
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
  return result;
}
async function fixture(t: any, toolTurn = false) {
  const dir = await mkdtemp(join(tmpdir(), "production-codec-"));
  const source = join(dir, "plugin");
  const pkg = JSON.parse(await readFile(join(project, "package.json"), "utf8"));
  await mkdir(source);
  for (const file of pkg.files) await cp(join(project, file), join(source, file), { recursive: true });
  await mkdir(join(source, "tests/fixtures"), { recursive: true });
  await cp(join(project, "tests/fixtures/checkpoint-cleanup-extension.ts"), join(source, "tests/fixtures/checkpoint-cleanup-extension.ts"));
  const packages = ["balanced-match", "brace-expansion", "minimatch", "openai", "ws"];
  for (const name of packages) await cp(join(project, "node_modules", name), join(source, "node_modules", name), { recursive: true });
  assert.deepEqual((await readdir(join(source, "node_modules"))).sort(), packages.sort());
  const prohibited: string[] = [];
  const hook = registerHooks({ resolve(specifier, context, next) {
    if (context.parentURL?.startsWith(pathToFileURL(source).href) && specifier.startsWith("@earendil-works/pi-ai/api/")) {
      prohibited.push(specifier);
      throw new Error(`External plugin codec subpath unavailable: ${specifier}`);
    }
    return next(specifier, context);
  } });
  const frames: any[] = [], httpFrames: any[] = [], headers: any[] = [];
  let generations = 0;
  const http = createServer(async (request, response) => {
    httpFrames.push(await readJsonBody(request));
    response.writeHead(500); response.end("unexpected HTTP inference");
  });
  const wss = new WebSocketServer({ server: http });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address(); assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  const stored = new Map<string, any[]>();
  wss.on("connection", (socket, request) => {
    headers.push(request.headers);
    const local = new Map<string, any[]>();
    socket.on("message", (raw) => {
      const frame = JSON.parse(String(raw)); frames.push(frame);
      const prior = stored.get(frame.previous_response_id) ?? local.get(frame.previous_response_id);
      assert.ok(!frame.previous_response_id || prior, "parent must exist on this backend");
      const id = `opaque_${++generations}`;
      const items = toolTurn && generations === 1 ? [reasoning, { ...call, status: "completed" }, { ...grammar, status: "completed" }] : [textItem(id)];
      const full = [...(prior ?? []), ...frame.input, ...items];
      local.set(id, full); if (frame.store) stored.set(id, full);
      for (const event of events(id, items)) socket.send(JSON.stringify(event));
    });
  });
  let cleanup: (() => Promise<void>) | undefined;
  t.after(async () => {
    const closed = Promise.all([...wss.clients].map((socket) => new Promise<void>((resolve) => socket.once("close", () => resolve()))));
    await cleanup?.(); await closed;
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => http.close(() => resolve()));
    hook.deregister(); await rm(dir, { recursive: true, force: true });
  });
  const model: any = { id: "production/nested", name: "Production", provider: "openai-api-extension", api: "openai-responses",
    baseUrl, compat: { supportsResponseCheckpoints: true, supportsOpenAIGrammarTools: true }, reasoning: true, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024 };
  const options: any = { apiKey: "dummy-production-key", env: { OPENAI_API_EXTENSION_BASE_URL: baseUrl },
    transport: "auto", sessionId: "production-codec", maxRetries: 2, maxTokens: 1024 };
  await writeFile(join(dir, "models.json"), JSON.stringify({ providers: { "openai-api-extension": { baseUrl, api: "openai-responses", models: [model] } } }));
  await writeFile(join(dir, "auth.json"), JSON.stringify({ "openai-api-extension": { type: "api_key", key: options.apiKey, env: options.env } }));
  const runtime = async () => {
    const loaded = await discoverAndLoadExtensions([join(source, "index.ts"), join(source, "tests/fixtures/checkpoint-cleanup-extension.ts")], dir, dir);
    assert.deepEqual(loaded.errors, []);
    cleanup = () => loaded.extensions[1].commands.get("checkpoint-test-cleanup")!.handler(options.sessionId, undefined as never);
    const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: join(dir, "models.json"), refreshOnCreate: false,
      modelsStore: { read: async (id: string) => id === model.provider ? { models: [{ ...model, compat: undefined }], checkedAt: Date.now() } : undefined,
        write: async () => {}, delete: async () => {} } });
    runtime.registerNativeProvider(loaded.runtime.pendingNativeProviderRegistrations[0].provider);
    await runtime.refresh({ allowNetwork: false });
    const configured = runtime.getModel(model.provider, model.id)!;
    assert.equal((configured.compat as any).supportsResponseCheckpoints, true);
    return { runtime, configured };
  };
  return { dir, source, frames, httpFrames, headers, stored, prohibited, options, runtime,
    cleanup: () => cleanup!(), get generations() { return generations; } };
}

for (const toolTurn of [false, true]) test(`production-only loader: ${toolTurn ? "function/grammar/encrypted reasoning" : "text"} JSONL resumes, preparation has no side effects`, { timeout: 20000 }, async (t) => {
  const h = await fixture(t, toolTurn);
  const session = SessionManager.create(h.dir, h.dir);
  session.appendMessage(user("one"));
  const context = { messages: session.buildSessionContext().messages, ...(toolTurn ? { tools } : {}) };
  const beforeContext = structuredClone(context);
  let payloads: any[] = [], responseCalls = 0;
  const labels: string[] = [];
  const options = { ...h.options, onPayload: (payload: any) => { payloads.push(JSON.parse(JSON.stringify(payload))); },
    onResponse: () => { responseCalls++; }, onTransport: (label: string) => { labels.push(label); } };
  const initial = await h.runtime();
  const first: any = await initial.runtime.models.stream(initial.configured, context, options).result();
  assert.equal(first.stopReason, toolTurn ? "toolUse" : "stop", first.errorMessage);
  assert.ok(first.responseCheckpoint, "must capture without physical plugin SDK or public codec subpaths");
  assert.deepEqual(context, beforeContext, "preparation must not mutate session input");
  session.appendMessage(first);
  const original = structuredClone(first);
  // Observe the real public SDK preparation call; no fake model response or encoder.
  const raw = openAIResponsesApi();
  let preparations = 0, fetches = 0;
  const preparationResults: Promise<any>[] = [];
  const originalModel = structuredClone(initial.configured);
  const api = { ...raw, stream: (model: any, context: any, options: any) => {
    preparations++;
    assert.deepEqual(Object.keys(options).sort(), ["apiKey", "cacheRetention", "fetch", "maxRetries", "onPayload", "transport"]);
    assert.equal(options.transport, "sse"); assert.equal(options.maxRetries, 0);
    const stream = raw.stream(model, context, { ...options, fetch: async (...args: any[]) => { fetches++; return options.fetch(...args); } });
    preparationResults.push(stream.result());
    return stream;
  } };
  const encoded = JSON.parse(JSON.stringify(await encodeCheckpointOutput(api as any, initial.configured as any, context as any, first)));
  assert.deepEqual(encoded, toolTurn ? [reasoning, call, grammar] : [textItem(first.responseId)]);
  assert.equal(preparations, 1); assert.equal(fetches, 0);
  for (const result of await Promise.all(preparationResults)) {
    assert.equal(result.stopReason, "error", "preparation is stopped, never a fake successful model response");
    assert.equal(result.responseId, undefined);
  }
  assert.deepEqual(initial.configured, originalModel);
  assert.deepEqual(session.buildSessionContext().messages, [user("one"), first]);
  assert.deepEqual(first, original); assert.deepEqual(context, beforeContext);
  assert.equal(h.frames.length, 1); assert.equal(h.httpFrames.length, 0); assert.equal(h.generations, 1);
  assert.equal(payloads.length, 1); assert.equal(responseCalls, 1); assert.deepEqual(labels, ["WS/full"]);
  await h.cleanup();
  const reopened = SessionManager.open(session.getSessionFile()!);
  const tails: any[] = [];
  if (toolTurn) {
    for (const [toolCallId, toolName, text, type] of [["call_1|fc_1", "lookup", "result\nexact", "function_call_output"], ["custom_1|ctc_1", "calculate", "3", "custom_tool_call_output"]]) {
      reopened.appendMessage({ role: "toolResult", toolCallId, toolName, content: [{ type: "text", text }], isError: false, timestamp: 2 });
      tails.push({ type, call_id: toolCallId.split("|")[0], output: text });
    }
  } else { reopened.appendMessage(user("two")); tails.push(input("two")); }
  const next = await h.runtime();
  const second: any = await next.runtime.models.streamSimple(next.configured,
    { messages: reopened.buildSessionContext().messages, ...(toolTurn ? { tools } : {}) }, options).result();
  assert.ok(second.responseCheckpoint, second.errorMessage);
  assert.deepEqual(payloads[1].input, [input("one"), ...encoded, ...tails]);
  assert.deepEqual(h.frames[1], { ...h.frames[0], previous_response_id: first.responseId, input: tails });
  reopened.appendMessage(second); reopened.appendMessage(user("three"));
  const third: any = await next.runtime.models.stream(next.configured,
    { messages: reopened.buildSessionContext().messages, ...(toolTurn ? { tools } : {}) }, options).result();
  assert.ok(third.responseCheckpoint, third.errorMessage);
  assert.deepEqual(h.frames[2], { ...h.frames[0], previous_response_id: second.responseId, input: [input("three")] });
  assert.equal(h.frames.length, 3); assert.equal(h.generations, 3); assert.equal(h.headers.length, 2); assert.equal(h.httpFrames.length, 0);
  assert.equal(payloads.length, 3); assert.equal(responseCalls, 3); assert.deepEqual(labels, ["WS/full", "WS/continuation", "WS/continuation"]);
  assert.deepEqual(h.prohibited, [], "production plugin must only use loader-supported root/compat");
});

for (const mode of ["store-false", "payload-error", "response-error", "observer-error"]) test(`production-only loader preserves ${mode} semantics`, { timeout: 20000 }, async (t) => {
  const h = await fixture(t);
  const { runtime, configured } = await h.runtime();
  let payloads = 0, responses = 0, notifications = 0;
  const output: any = await runtime.models.stream(configured, { messages: [user("one")] }, {
    ...h.options,
    onPayload: (payload: any) => { payloads++; if (mode === "payload-error") throw new Error("caller payload failed");
      return mode === "store-false" ? { ...payload, store: false } : undefined; },
    onResponse: () => { responses++; if (mode === "response-error") throw new Error("caller response failed"); },
    onTransport: () => { notifications++; if (mode === "observer-error") throw new Error("observer failed"); },
  }).result();
  const requestCount = mode === "payload-error" ? 0 : 1;
  assert.equal(h.frames.length, requestCount); assert.equal(h.generations, requestCount); assert.equal(h.httpFrames.length, 0);
  assert.equal(payloads, 1); assert.equal(responses, requestCount); assert.equal(notifications, requestCount);
  assert.equal(output.stopReason, mode === "payload-error" || mode === "response-error" ? "error" : "stop");
  if (mode === "observer-error") assert.ok(output.responseCheckpoint);
  else assert.equal(output.responseCheckpoint, undefined);
  if (mode === "store-false") assert.equal(h.frames[0].store, false);
  assert.deepEqual(h.prohibited, []);
});
