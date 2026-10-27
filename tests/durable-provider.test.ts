import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { createModels, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { discoverAndLoadExtensions, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { createOpenAIApiProvider } from "../index.ts";
import { closeResponsesWebSockets, createResponsesWebSocketBridge } from "../src/responses-websocket-fetch.ts";
import { openAIResponsesApi } from "@earendil-works/pi-ai/compat";
import { readJsonBody } from "./fixtures/wire-decode.ts";

const user = (text: string) => ({ role: "user" as const, content: text, timestamp: 1 });
const input = (text: string) => ({ role: "user", content: [{ type: "input_text", text }] });
// Compare complete JSON wire semantics, not SDK-only undefined properties.
const wireBody = (body: unknown) => JSON.parse(JSON.stringify(body));
const message = (id: string) => ({ id: `msg_${id}`, type: "message", role: "assistant", status: "completed",
  content: [{ type: "output_text", text: "ok", annotations: [] }] });
function events(id: string, items: any[] = [message(id)]) {
  const result: any[] = [{ type: "response.created", response: { id } }];
  items.forEach((item, output_index) => {
    result.push({ type: "response.output_item.added", output_index, item: item.type === "function_call" ? { ...item, arguments: "" } : item });
    if (item.type === "message") result.push({ type: "response.output_text.delta", output_index, content_index: 0, delta: "ok" });
    if (item.type === "function_call") result.push({ type: "response.function_call_arguments.delta", output_index, delta: item.arguments });
    result.push({ type: "response.output_item.done", output_index, item });
  });
  result.push({ type: "response.completed", response: { id, status: "completed", output: items,
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
  return result;
}
async function harness(t: any) {
  const dir = await mkdtemp(join(tmpdir(), "plugin-durable-"));
  const frames: any[] = [];
  const headers: any[] = [];
  const urls: (string | undefined)[] = [];
  let accountHeader = "x-tenant";
  const httpFrames: any[] = [];
  const http = createServer(async (request, response) => {
    httpFrames.push(await readJsonBody(request));
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of events(`opaque_${++generations}`)) response.write(`data: ${JSON.stringify(event)}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  let handshakeStatus: number | undefined;
  const wss = new WebSocketServer({ server: http,
    verifyClient: (_info, done) => done(handshakeStatus === undefined, handshakeStatus) });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  let generations = 0;
  let behavior: ((socket: any, frame: any) => boolean) | undefined;
  const stored = new Map<string, { account: string; full: any[] }>();
  wss.on("connection", (socket, request) => {
    headers.push(request.headers);
    urls.push(request.url);
    const account = `${request.headers.authorization}/${request.headers[accountHeader] ?? ""}`;
    const connectionStored = new Map<string, { account: string; full: any[] }>();
    socket.on("message", (raw) => {
      const frame = JSON.parse(String(raw)); frames.push(frame);
      if (behavior?.(socket, frame)) return;
      const parent = connectionStored.get(frame.previous_response_id) ?? stored.get(frame.previous_response_id);
      if (frame.previous_response_id && (!parent || parent.account !== account)) {
        socket.send(JSON.stringify({ type: "error", error: { type: "invalid_request_error", code: "previous_response_not_found", message: "Previous response not found" } }));
        return;
      }
      const id = `opaque_${++generations}`;
      const items = outputItems?.(id) ?? [message(id)];
      const state = { account, full: [...(parent?.full ?? []), ...frame.input, ...items] };
      connectionStored.set(id, state);
      if (frame.store) stored.set(id, state);
      for (const event of events(id, items)) socket.send(JSON.stringify(mutateEvent?.(event) ?? event));
    });
  });
  let outputItems: ((id: string) => any[]) | undefined;
  let mutateEvent: ((event: any) => any) | undefined;
  let cleanup: (() => Promise<void>) | undefined;
  t.after(async () => {
    if (cleanup) {
      // Prove host-owned lifecycle closes pooled sockets before fixture termination.
      const closed = Promise.all([...wss.clients].map((socket) => new Promise<void>((resolve) => socket.once("close", () => resolve()))));
      await cleanup();
      await closed;
    }
    closeResponsesWebSockets();
    for (const socket of wss.clients) socket.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => http.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });
  const model: any = { id: "mock/nested", name: "Mock", provider: "openai-api-extension", api: "openai-responses",
    baseUrl, compat: { supportsResponseCheckpoints: true }, reasoning: true, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024 };
  const options: any = { apiKey: "dummy-durable-key", env: { OPENAI_API_EXTENSION_BASE_URL: baseUrl }, transport: "auto", sessionId: "durable", maxRetries: 0, maxTokens: 1024 };
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("openai-api-extension", async () => ({ type: "api_key", key: options.apiKey,
    env: { OPENAI_API_EXTENSION_BASE_URL: baseUrl } }));
  const makeModels = (getRawCheckpointExclude?: () => unknown) => {
    const models = createModels({ credentials });
    models.setProvider(createOpenAIApiProvider([], undefined, getRawCheckpointExclude)); return models;
  };
  return { dir, frames, httpFrames, headers, urls, model, options, stored, wss, makeModels,
    set handshakeStatus(value: number | undefined) { handshakeStatus = value; },
    set accountHeader(value: string) { accountHeader = value; },
    recordGeneration: () => `opaque_${++generations}`,
    get generations() { return generations; },
    set cleanup(value: typeof cleanup) { cleanup = value; },
    set behavior(value: typeof behavior) { behavior = value; },
    set outputItems(value: typeof outputItems) { outputItems = value; },
    set mutateEvent(value: typeof mutateEvent) { mutateEvent = value; } };
}

for (const method of ["stream", "streamSimple"] as const) for (const transport of ["sse", "auto", "websocket", "websocket-cached"] as const) {
  test(`${method}/${transport}: local ancestry persists with checkpoints off and stays off provider wire`, async (t) => {
    const h = await harness(t);
    const session = SessionManager.create(h.dir, h.dir);
    session.appendMessage(user("one"));
    const options = { ...h.options, transport, responseCheckpointExclude: ["*"] };
    const first: any = await h.makeModels()[method](h.model, { messages: session.buildSessionContext().messages }, options).result();
    assert.equal(first.stopReason, "stop", first.errorMessage);
    assert.equal(first.responseAncestry, "local");
    assert.equal(first.responseCheckpoint, undefined);
    const leaf = session.appendMessage(first);
    const jsonl = await readFile(session.getSessionFile()!, "utf8");
    assert.ok(jsonl.includes('"responseAncestry":"local"'));
    const forkFile = session.createBranchedSession(leaf);
    assert.ok(forkFile);
    assert.equal((SessionManager.open(forkFile).buildSessionContext().messages.at(-1) as any).responseAncestry, "local");
    closeResponsesWebSockets();
    const reopened = SessionManager.open(session.getSessionFile()!);
    reopened.appendMessage(user("two"));
    const second: any = await h.makeModels()[method](h.model, { messages: reopened.buildSessionContext().messages }, options).result();
    assert.equal(second.stopReason, "stop", second.errorMessage);
    assert.equal(second.responseAncestry, "local");
    const frames = transport === "sse" ? h.httpFrames : h.frames;
    assert.equal(frames.length, 2);
    assert.equal(frames[1].previous_response_id, undefined);
    assert.deepEqual(frames[1].input, [input("one"), message(first.responseId), input("two")]);
    assert.equal(JSON.stringify(frames).includes("responseAncestry"), false);
    assert.equal(h.headers.length, transport === "sse" ? 0 : 2, "SSE never opens WS for ancestry");
  });
}

for (const method of ["stream", "streamSimple"] as const) test(`${method}: genuine legacy absence keeps cold full fallback without laundering local proof`, async (t) => {
  const h = await harness(t);
  const first: any = await h.makeModels()[method](h.model, { messages: [user("one")] }, h.options).result();
  const legacy = structuredClone(first);
  delete legacy.responseAncestry;
  delete legacy.responseCheckpoint;
  closeResponsesWebSockets();
  const second: any = await h.makeModels()[method](h.model, { messages: [user("one"), legacy, user("two")] }, h.options).result();
  assert.equal(second.stopReason, "stop", second.errorMessage);
  assert.equal(Object.hasOwn(second, "responseAncestry"), false, "compatibility trust is not independently local");
  assert.ok(second.responseCheckpoint, "legacy capture eligibility preserved");
  assert.equal(h.frames[1].previous_response_id, undefined);
  assert.deepEqual(h.frames[1].input, [input("one"), message(first.responseId), input("two")]);
});

for (const method of ["stream", "streamSimple"] as const) test(`${method}: JSONL reload/new provider/socket and old active branch send exact delta`, async (t) => {
  const h = await harness(t);
  const session = SessionManager.create(h.dir, h.dir);
  session.appendMessage(user("one"));
  const models = h.makeModels();
  const first: any = await models[method](h.model, { messages: session.buildSessionContext().messages }, h.options).result();
  assert.equal(first.stopReason, "stop", first.errorMessage);
  assert.ok(first.responseCheckpoint, "actual SDK completion gets checkpoint");
  const branch = session.appendMessage(first);
  const jsonl = await readFile(session.getSessionFile()!, "utf8");
  assert.ok(jsonl.includes('"responseCheckpoint"'));
  assert.ok(!jsonl.includes(h.options.apiKey));
  assert.ok(JSON.stringify(first.responseCheckpoint).length < 400);
  closeResponsesWebSockets();
  const reopened = SessionManager.open(session.getSessionFile()!);
  reopened.appendMessage(user("two"));
  const second: any = await h.makeModels()[method](h.model, { messages: reopened.buildSessionContext().messages }, h.options).result();
  assert.ok(second.responseCheckpoint, second.errorMessage);
  reopened.appendMessage(second);
  assert.deepEqual(h.frames[1], { ...h.frames[0], previous_response_id: first.responseId, input: [input("two")] });
  assert.deepEqual(h.stored.get(second.responseId)?.full, [input("one"), message(first.responseId), input("two"), message(second.responseId)]);
  reopened.branch(branch);
  reopened.appendMessage(user("branch"));
  closeResponsesWebSockets();
  const third = await h.makeModels()[method](h.model, { messages: reopened.buildSessionContext().messages }, h.options).result();
  assert.equal(third.stopReason, "stop", third.errorMessage);
  assert.deepEqual(h.frames[2], { ...h.frames[0], previous_response_id: first.responseId, input: [input("branch")] });
  assert.equal(h.generations, 3);
  assert.equal(h.headers.length, 3);
});

test("function call, encrypted reasoning and tool result survive JSONL and resume with exact encoded bytes", async (t) => {
  const h = await harness(t);
  const reasoning = { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "encrypted+/opaque==" };
  const call = { type: "function_call", id: "fc_1", call_id: "call_server_1", name: "lookup", arguments: '{"query":"a\\nb","limit":2}' };
  h.outputItems = () => [reasoning, { ...call, status: "completed" }];
  const tools = [{ name: "lookup", description: "Look up value", parameters: {
    type: "object", properties: { query: { type: "string" }, limit: { type: "number" } }, required: ["query", "limit"],
  } }];
  const session = SessionManager.create(h.dir, h.dir);
  session.appendMessage(user("call the tool"));
  const first: any = await h.makeModels().stream(h.model, { tools, messages: session.buildSessionContext().messages }, h.options).result();
  assert.equal(first.stopReason, "toolUse", first.errorMessage);
  assert.ok(first.responseCheckpoint);
  const toolCall = first.content.find((block: any) => block.type === "toolCall");
  assert.equal(toolCall.id, "call_server_1|fc_1");
  assert.deepEqual(toolCall.arguments, { query: "a\nb", limit: 2 });
  assert.deepEqual(JSON.parse(first.content.find((block: any) => block.type === "thinking").thinkingSignature), reasoning);
  session.appendMessage(first);
  closeResponsesWebSockets();
  const reopened = SessionManager.open(session.getSessionFile()!);
  reopened.appendMessage({ role: "toolResult", toolCallId: toolCall.id, toolName: "lookup",
    content: [{ type: "text", text: "result\nwith exact bytes: \"ok\"" }], isError: false, timestamp: 2 });
  const toolOutput = { type: "function_call_output", call_id: "call_server_1", output: "result\nwith exact bytes: \"ok\"" };
  let fullRequest: any;
  h.outputItems = undefined;
  const second: any = await h.makeModels().streamSimple(h.model, { tools, messages: reopened.buildSessionContext().messages }, {
    ...h.options, onPayload: (payload: unknown) => { fullRequest = JSON.parse(JSON.stringify(payload)); },
  }).result();
  assert.equal(second.stopReason, "stop", second.errorMessage);
  assert.ok(second.responseCheckpoint);
  assert.deepEqual(h.frames[0].input, [input("call the tool")]);
  assert.deepEqual(h.frames[0].tools[0].parameters, tools[0].parameters);
  const { type: _type, ...envelope } = h.frames[0];
  assert.deepEqual(fullRequest, { ...envelope, stream: true,
    input: [input("call the tool"), reasoning, call, toolOutput] });
  assert.deepEqual(h.frames[1], { ...h.frames[0], previous_response_id: first.responseId, input: [toolOutput] });
  assert.deepEqual(h.stored.get(second.responseId)?.full,
    [input("call the tool"), reasoning, { ...call, status: "completed" }, toolOutput, message(second.responseId)]);
  assert.equal(h.frames.length, 2);
  assert.equal(h.generations, 2);
  assert.equal(h.headers.length, 2);
});

test("unused apiKey changes preserve socket/checkpoint; effective Authorization changes isolate both", async (t) => {
  const h = await harness(t);
  const headers = { Authorization: "Bearer identical-http-override" };
  const first: any = await h.makeModels().stream(h.model, { messages: [user("one")] }, { ...h.options, headers }).result();
  assert.ok(first.responseCheckpoint, first.errorMessage);
  const second: any = await h.makeModels().stream(h.model, { messages: [user("one"), first, user("two")] },
    { ...h.options, headers, apiKey: "different-dummy-ws-key" }).result();
  assert.equal(second.stopReason, "stop", second.errorMessage);
  assert.ok(second.responseCheckpoint);
  assert.deepEqual(h.frames[1], { ...h.frames[0], previous_response_id: first.responseId, input: [input("two")] });
  assert.deepEqual(h.headers.map((entry) => entry.authorization), ["Bearer identical-http-override"]);
  assert.equal(h.headers.length, 1, "unused key must not invalidate pooled socket");
  const third: any = await h.makeModels().stream(h.model, { messages: [user("one"), first, user("three")] },
    { ...h.options, headers: { authorization: "Bearer different-actual-credential" } }).result();
  assert.ok(third.responseCheckpoint, third.errorMessage);
  assert.deepEqual(h.frames[2], { ...h.frames[0], input: [input("one"), message(first.responseId), input("three")] });
  assert.deepEqual(h.headers.map((entry) => entry.authorization), ["Bearer identical-http-override", "Bearer different-actual-credential"]);
  assert.equal(h.frames.length, 3);
  assert.equal(h.generations, 3);
});

for (const method of ["stream", "streamSimple"] as const) test(`${method}: model/options Authorization precedence is case-insensitive on wire`, async (t) => {
  const h = await harness(t);
  const model = { ...h.model, headers: { Authorization: "Bearer model-credential" } };
  const first: any = await createOpenAIApiProvider()[method](model, { messages: [user("one")] }, h.options).result();
  assert.ok(first.responseCheckpoint, first.errorMessage);
  const second: any = await createOpenAIApiProvider()[method](model, { messages: [user("two")] },
    { ...h.options, headers: { authorization: "Bearer option-credential" } }).result();
  assert.ok(second.responseCheckpoint, second.errorMessage);
  assert.deepEqual(h.headers.map((entry) => entry.authorization), ["Bearer model-credential", "Bearer option-credential"]);
});

test("cf-aig-authorization is sent without unused automatic Authorization", async (t) => {
  const h = await harness(t);
  const output: any = await h.makeModels().stream(h.model, { messages: [user("one")] },
    { ...h.options, headers: { "cf-aig-authorization": "Bearer cloudflare-credential" } }).result();
  assert.ok(output.responseCheckpoint, output.errorMessage);
  assert.equal(h.headers[0]["cf-aig-authorization"], "Bearer cloudflare-credential");
  assert.equal(h.headers[0].authorization, undefined);
});

test("malformed truthy capability never enables storage through real provider", async (t) => {
  const h = await harness(t);
  // declared mode keeps the exact-true contract; always would legitimately try.
  const options = { ...h.options, responseCheckpointMode: "declared" };
  for (const capability of ["true", 1, {}, [true]]) {
    const output: any = await h.makeModels().stream({ ...h.model, compat: { supportsResponseCheckpoints: capability } },
      { messages: [user("one")] }, options).result();
    assert.equal(output.stopReason, "stop", output.errorMessage);
    assert.notEqual(h.frames.at(-1).store, true);
    assert.equal(output.responseCheckpoint, undefined);
  }
  assert.equal(h.frames.length, 4);
  assert.equal(h.generations, 4);
});

test("real provider raw policy and incoming override precedence never materialize defaults", async (t) => {
  const h = await harness(t);
  const cases: { label: string; raw?: unknown; incoming?: Record<string, unknown>; enabled: boolean }[] = [
    { label: "absent", enabled: true },
    { label: "empty", raw: [], enabled: true },
    { label: "slash model star", raw: ["*"], enabled: false },
    { label: "combined glob", raw: ["OPENAI-API-EXTENSION/mock/*"], enabled: false },
    { label: "null", raw: null, enabled: false },
    { label: "mixed", raw: ["other", 1], enabled: false },
    { label: "sparse", raw: Array(1), enabled: false },
    { label: "incoming empty wins", raw: ["*"], incoming: { responseCheckpointExclude: [] }, enabled: true },
    { label: "incoming undefined wins", raw: ["*"], incoming: { responseCheckpointExclude: undefined }, enabled: true },
    { label: "incoming star wins", raw: [], incoming: { responseCheckpointExclude: ["*"] }, enabled: false },
    { label: "incoming null wins", raw: [], incoming: { responseCheckpointExclude: null }, enabled: false },
  ];
  for (const entry of cases) {
    closeResponsesWebSockets();
    let reads = 0;
    const options = { ...h.options, ...entry.incoming };
    const before = structuredClone(options);
    let payload: any;
    const output: any = await h.makeModels(() => { reads++; return entry.raw; }).streamSimple(h.model,
      { messages: [user(entry.label)] }, { ...options, onPayload: (body: any) => { payload = wireBody(body); } }).result();
    assert.equal(output.stopReason, "stop", output.errorMessage);
    assert.equal(output.responseAncestry, "local", "checkpoint policy never controls persisted ancestry");
    assert.equal(reads, entry.incoming ? 0 : 1, entry.label);
    assert.deepEqual(options, before, "raw options unchanged, including own undefined/absence");
    assert.equal(Object.hasOwn(options, "responseCheckpointExclude"), !!entry.incoming);
    assert.equal(payload.store, entry.enabled, entry.label);
    assert.equal(!!output.responseCheckpoint, entry.enabled, entry.label);
    assert.equal(Object.hasOwn(payload, "responseCheckpointExclude"), false);
    assert.deepEqual(h.frames.at(-1), { type: "response.create", ...payload });
    assert.deepEqual(payload.input, [input(entry.label)]);
  }
  assert.equal(h.frames.length, cases.length); assert.equal(h.generations, cases.length);
  assert.equal(h.headers.length, cases.length); assert.equal(h.httpFrames.length, 0);
});

test("unknown/false capability and SSE/uncached WS retain non-storage behavior", async (t) => {
  const h = await harness(t);
  // declared mode pins the strict capability contract; hard gates apply to every mode.
  const cases = [
    { capability: undefined, transport: "auto", mode: "declared" },
    { capability: false, transport: "auto", mode: "auto" },
    { capability: true, transport: "sse" },
    { capability: true, transport: "websocket" },
  ];
  for (const entry of cases) {
    closeResponsesWebSockets();
    let payload: any;
    const output: any = await h.makeModels().stream({ ...h.model, compat: { supportsResponseCheckpoints: entry.capability } },
      { messages: [user("one")] }, { ...h.options, transport: entry.transport,
        ...(entry.mode ? { responseCheckpointMode: entry.mode } : {}),
        onPayload: (body: any) => { payload = wireBody(body); } }).result();
    assert.equal(output.stopReason, "stop", output.errorMessage);
    assert.equal(output.responseAncestry, "local");
    assert.equal(output.responseCheckpoint, undefined); assert.equal(payload.store, false);
    assert.equal(payload.previous_response_id, undefined);
    assert.deepEqual(payload.input, [input("one")]);
    assert.deepEqual(entry.transport === "sse" ? h.httpFrames.at(-1) : h.frames.at(-1),
      entry.transport === "sse" ? payload : { type: "response.create", ...payload });
  }
  assert.equal(h.frames.length, 3); assert.equal(h.headers.length, 3);
  assert.equal(h.httpFrames.length, 1); assert.equal(h.generations, 4);
});

test("real captured prefix edits and request envelope changes send complete semantic payload", async (t) => {
  const h = await harness(t);
  const reasoning = { type: "reasoning", id: "rs_edit", summary: [], encrypted_content: "opaque+/original==" };
  const call = { type: "function_call", id: "fc_edit", call_id: "call_edit", name: "lookup", arguments: '{"query":"original"}' };
  const tools = [{ name: "lookup", description: "Lookup", parameters: {
    type: "object", properties: { query: { type: "string" } }, required: ["query"],
  } }];
  h.outputItems = () => [reasoning, { ...call, status: "completed" }];
  const first: any = await h.makeModels().stream(h.model, { tools, messages: [user("one")] }, h.options).result();
  assert.equal(first.stopReason, "toolUse", first.errorMessage); assert.ok(first.responseCheckpoint);
  const toolResult: any = { role: "toolResult", toolCallId: "call_edit|fc_edit", toolName: "lookup",
    content: [{ type: "text", text: "original tool result" }], isError: false, timestamp: 2 };
  h.outputItems = undefined;
  closeResponsesWebSockets();
  const second: any = await h.makeModels().stream(h.model, { tools, messages: [user("one"), first, toolResult] }, h.options).result();
  assert.ok(second.responseCheckpoint, second.errorMessage);
  assert.deepEqual(h.frames[1], { ...h.frames[0], previous_response_id: first.responseId,
    input: [{ type: "function_call_output", call_id: "call_edit", output: "original tool result" }] });
  const original = { tools, messages: [user("one"), first, toolResult, second, user("next")] };
  const baseline = structuredClone(original);
  for (const change of ["user", "assistant", "tool-result", "opaque-reasoning", "tool-schema", "maxTokens"]) {
    closeResponsesWebSockets();
    const context: any = structuredClone(original);
    const options = { ...h.options };
    const expectedInput = [input("one"), structuredClone(reasoning), structuredClone(call),
      { type: "function_call_output", call_id: "call_edit", output: "original tool result" }, message(second.responseId), input("next")];
    if (change === "user") { context.messages[0].content = "edited user"; expectedInput[0] = input("edited user"); }
    if (change === "assistant") {
      context.messages[3].content.find((b: any) => b.type === "text").text = "edited assistant";
      (expectedInput[4] as any).content[0].text = "edited assistant";
    }
    if (change === "tool-result") { context.messages[2].content[0].text = "edited result"; (expectedInput[3] as any).output = "edited result"; }
    if (change === "opaque-reasoning") {
      const edited = { ...reasoning, encrypted_content: "opaque+/edited==" };
      context.messages[1].content.find((b: any) => b.type === "thinking").thinkingSignature = JSON.stringify(edited);
      expectedInput[1] = edited;
    }
    if (change === "tool-schema") context.tools[0].parameters.properties.query.description = "changed schema";
    if (change === "maxTokens") options.maxTokens = 512;
    const before = structuredClone(context);
    let payload: any;
    const output: any = await h.makeModels().stream(h.model, context, {
      ...options, onPayload: (body: any) => { payload = wireBody(body); },
    }).result();
    assert.equal(output.stopReason, "stop", output.errorMessage); assert.ok(output.responseCheckpoint);
    assert.deepEqual(payload.input, expectedInput, change);
    assert.deepEqual(payload.tools[0].parameters, context.tools[0].parameters);
    assert.equal(payload.max_output_tokens, options.maxTokens);
    assert.equal(payload.previous_response_id, undefined);
    assert.deepEqual(h.frames.at(-1), { type: "response.create", ...payload }, change);
    assert.deepEqual(context, before, "canonical input and original hash metadata retained");
    assert.deepEqual(context.messages[3].responseCheckpoint, second.responseCheckpoint);
  }
  assert.deepEqual(original, baseline);
  assert.equal(h.frames.length, 8); assert.equal(h.generations, 8);
  assert.equal(h.headers.length, 8); assert.equal(h.httpFrames.length, 0);
});

test("corrupt, unknown-version and explicitly expired metadata invalidate genuine SDK capture", async (t) => {
  const h = await harness(t);
  const first: any = await h.makeModels().stream(h.model, { messages: [user("one")] }, h.options).result();
  assert.ok(first.responseCheckpoint, first.errorMessage);
  const original = structuredClone(first);
  const mutations = [
    { prefixHash: "not-a-hash" }, { version: 999 }, { expiresAt: Date.now() - 1 },
  ];
  for (const mutation of mutations) {
    closeResponsesWebSockets();
    const invalid = structuredClone(first);
    Object.assign(invalid.responseCheckpoint, mutation); // Negative invalidation only, never positive fabricated metadata.
    const context = { messages: [user("one"), invalid, user("two")] };
    const before = structuredClone(context);
    let payload: any;
    const output: any = await h.makeModels().streamSimple(h.model, context, {
      ...h.options, onPayload: (body: any) => { payload = wireBody(body); },
    }).result();
    assert.equal(output.stopReason, "stop", output.errorMessage); assert.ok(output.responseCheckpoint);
    assert.deepEqual(payload.input, [input("one"), message(first.responseId), input("two")]);
    assert.equal(payload.previous_response_id, undefined);
    assert.deepEqual(h.frames.at(-1), { type: "response.create", ...payload });
    assert.deepEqual(context, before);
  }
  assert.deepEqual(first, original);
  assert.equal(h.frames.length, 4); assert.equal(h.generations, 4);
  assert.equal(h.headers.length, 4); assert.equal(h.httpFrames.length, 0);
});

for (const header of ["x-tenant", "x-client-request-id"]) test(`actual caller ${header} scopes checkpoint, including framing-like identity`, async (t) => {
  const h = await harness(t);
  h.accountHeader = header;
  const first: any = await h.makeModels().stream(h.model, { messages: [user("one")] },
    { ...h.options, headers: { [header]: "account-A" } }).result();
  assert.ok(first.responseCheckpoint, first.errorMessage);
  assert.equal(h.headers[0][header], "account-A", "actual wire identity, not assumed option value");
  closeResponsesWebSockets();
  let full: any;
  const same: any = await h.makeModels().stream(h.model, { messages: [user("one"), first, user("same")] },
    { ...h.options, headers: { [header]: "account-A" }, onPayload: (body: any) => { full = wireBody(body); } }).result();
  assert.ok(same.responseCheckpoint, same.errorMessage);
  assert.deepEqual(h.frames[1], { type: "response.create", ...full, previous_response_id: first.responseId, input: [input("same")] });
  // Keep A's socket pooled: changing caller identity must also choose a distinct connection.
  const changed: any = await h.makeModels().stream(h.model, { messages: [user("one"), first, user("other")] },
    { ...h.options, headers: { [header]: "account-B" }, onPayload: (body: any) => { full = wireBody(body); } }).result();
  assert.ok(changed.responseCheckpoint, changed.errorMessage);
  assert.deepEqual(full.input, [input("one"), message(first.responseId), input("other")]);
  assert.equal(full.previous_response_id, undefined);
  assert.deepEqual(h.frames[2], { type: "response.create", ...full });
  assert.deepEqual(h.headers.map((entry) => entry[header]), ["account-A", "account-A", "account-B"]);
  assert.equal(h.frames.length, 3); assert.equal(h.generations, 3); assert.equal(h.httpFrames.length, 0);
});

test("endpoint change cannot send old backend parent or mask it with repair", async (t) => {
  const a = await harness(t), b = await harness(t);
  const first: any = await a.makeModels().stream(a.model, { messages: [user("one")] }, a.options).result();
  assert.ok(first.responseCheckpoint, first.errorMessage);
  closeResponsesWebSockets();
  let payload: any;
  const next: any = await b.makeModels().stream(b.model, { messages: [user("one"), first, user("two")] },
    { ...b.options, onPayload: (body: any) => { payload = wireBody(body); } }).result();
  assert.ok(next.responseCheckpoint, next.errorMessage);
  assert.deepEqual(payload.input, [input("one"), message(first.responseId), input("two")]);
  assert.equal(payload.previous_response_id, undefined);
  assert.deepEqual(b.frames[0], { type: "response.create", ...payload });
  for (const h of [a, b]) {
    assert.deepEqual(h.urls, ["/v1/responses"]);
    assert.equal(h.frames.length, 1); assert.equal(h.generations, 1);
    assert.equal(h.headers.length, 1); assert.equal(h.httpFrames.length, 0);
  }
});

function rejectMissing(socket: any) {
  socket.send(JSON.stringify({ type: "error", error: { type: "invalid_request_error",
    code: "previous_response_not_found", message: "Previous response not found" } }));
}

for (const method of ["stream", "streamSimple"] as const) test(`${method}: missing persisted reference repairs once, then new checkpoint resumes`, async (t) => {
  const h = await harness(t);
  const first: any = await h.makeModels()[method](h.model, { messages: [user("one")] }, h.options).result();
  assert.ok(first.responseCheckpoint, first.errorMessage);
  h.stored.clear();
  closeResponsesWebSockets();
  const second: any = await h.makeModels()[method](h.model, { messages: [user("one"), first, user("two")] }, h.options).result();
  assert.equal(second.stopReason, "stop", second.errorMessage);
  assert.equal(second.responseCheckpoint, undefined, "repair without store captures no checkpoint");
  const full = { ...h.frames[0], input: [input("one"), message(first.responseId), input("two")] };
  assert.deepEqual(h.frames[1], { ...h.frames[0], previous_response_id: first.responseId, input: [input("two")] });
  // Reference repair resends full history without checkpoint fields and opens cooldown.
  const { store: _s1, ...repair } = full;
  assert.deepEqual(h.frames[2], repair);
  // Cooldown: the next request also stays full-history without store. Sockets
  // stay pooled: closeResponsesWebSockets() is session cleanup and would also
  // clear the cooldown (asserted in checkpoint-cooldown.test.ts).
  const third: any = await h.makeModels()[method](h.model, { messages: [user("one"), first, user("two"), second, user("three")] }, h.options).result();
  assert.equal(third.stopReason, "stop", third.errorMessage);
  const { store: _s2, ...cooled } = { ...h.frames[0], input: [input("one"), message(first.responseId), input("two"), message(second.responseId), input("three")] };
  assert.deepEqual(h.frames[3], cooled);
  assert.equal(h.frames.length, 4);
  assert.equal(h.generations, 3);
  assert.equal(h.httpFrames.length, 0);
});

function executionFault(h: Awaited<ReturnType<typeof harness>>, socket: any, mode: string) {
  if (mode === "auth" || mode === "policy") {
    socket.send(JSON.stringify({ type: "error", error: { type: mode === "auth" ? "authentication_error" : "permission_error",
      code: mode === "auth" ? "invalid_api_key" : "policy_violation", message: "Denied previous_response_id access" } }));
  } else {
    const id = h.recordGeneration();
    if (mode === "partial") for (const event of events(id).slice(0, 3)) socket.send(JSON.stringify(event));
    socket.close(1011, "unknown execution");
  }
}

for (const transport of ["auto", "websocket-cached"] as const) for (const maxRetries of [0, 1, 2]) {
  for (const mode of ["ambiguous", "partial", "auth", "policy"]) test(`durable initial full ${mode}/${transport}/retries${maxRetries}: no replay`, async (t) => {
    const h = await harness(t);
    h.behavior = (socket) => { executionFault(h, socket, mode); return true; };
    const output: any = await h.makeModels()[maxRetries % 2 ? "streamSimple" : "stream"](h.model,
      { messages: [user("one")] }, { ...h.options, transport, maxRetries, maxRetryDelayMs: 1 }).result();
    assert.equal(output.stopReason, "error");
    assert.equal(output.responseCheckpoint, undefined);
    assert.deepEqual(h.frames[0].input, [input("one")]);
    assert.equal(h.frames[0].previous_response_id, undefined);
    assert.equal(h.frames[0].store, true);
    assert.equal(h.frames.length, 1);
    assert.equal(h.generations, mode === "auth" || mode === "policy" ? 0 : 1);
    assert.equal(h.httpFrames.length, 0);
  });
  for (const mode of ["ambiguous", "partial", "auth"]) test(`failed durable repair ${mode}/${transport}/retries${maxRetries} is terminal only for this request`, async (t) => {
    const h = await harness(t);
    const options = { ...h.options, transport, maxRetries, maxRetryDelayMs: 1 };
    const first: any = await h.makeModels().stream(h.model, { messages: [user("one")] }, options).result();
    assert.ok(first.responseCheckpoint);
    closeResponsesWebSockets();
    h.behavior = (socket, frame) => {
      if (frame.previous_response_id) rejectMissing(socket);
      else executionFault(h, socket, mode);
      return true;
    };
    const failed: any = await h.makeModels().streamSimple(h.model, { messages: [user("one"), first, user("two")] }, options).result();
    assert.equal(failed.stopReason, "error");
    assert.equal(failed.responseCheckpoint, undefined);
    assert.deepEqual(h.frames[1], { ...h.frames[0], previous_response_id: first.responseId, input: [input("two")] });
    const { store: _repairStore, ...repairFrame } = { ...h.frames[0], input: [input("one"), message(first.responseId), input("two")] };
    assert.deepEqual(h.frames[2], repairFrame);
    assert.equal(h.frames.length, 3);
    assert.equal(h.generations, mode === "auth" ? 1 : 2);
    assert.equal(h.httpFrames.length, 0);
    h.behavior = undefined;
    // Sockets stay pooled: session cleanup would also clear the cooldown.
    const later: any = await h.makeModels().stream(h.model, { messages: [user("independent")] }, options).result();
    assert.equal(later.stopReason, "stop", later.errorMessage);
    const { store: _cooledStore, ...cooledFrame } = { ...h.frames[0], input: [input("independent")] };
    assert.deepEqual(h.frames[3], cooledFrame, "cooldown keeps checkpoints off");
    assert.equal(later.responseCheckpoint, undefined);
    assert.equal(h.frames.length, 4);
    assert.equal(h.generations, mode === "auth" ? 2 : 3);
    assert.equal(h.httpFrames.length, 0);
  });
}

for (const transport of ["auto", "websocket-cached"] as const) for (const maxRetries of [0, 1, 2]) test(`owned durable delta ambiguous/${transport}/retries${maxRetries}: no repair or replay`, async (t) => {
  const h = await harness(t);
  const options = { ...h.options, transport, maxRetries };
  const first: any = await h.makeModels().stream(h.model, { messages: [user("one")] }, options).result();
  assert.ok(first.responseCheckpoint);
  closeResponsesWebSockets();
  h.behavior = (socket) => { executionFault(h, socket, "ambiguous"); return true; };
  const failed: any = await h.makeModels().streamSimple(h.model, { messages: [user("one"), first, user("two")] }, options).result();
  assert.equal(failed.stopReason, "error");
  assert.equal(failed.responseCheckpoint, undefined);
  assert.deepEqual(h.frames[1], { ...h.frames[0], previous_response_id: first.responseId, input: [input("two")] });
  assert.equal(h.frames.length, 2);
  assert.equal(h.generations, 2);
  assert.equal(h.httpFrames.length, 0);
});

test("store:false descendant cannot reuse connection state as durable proof on later opt-in", async (t) => {
  const h = await harness(t);
  h.mutateEvent = (event) => event.type === "response.completed" ? { ...event,
    response: { ...event.response, output: [...event.response.output, { type: "server_only", id: "opaque-extra" }] } } : event;
  const local = { ...h.options, onPayload: (payload: any) => ({ ...payload, store: false }) };
  const first: any = await h.makeModels().stream(h.model, { messages: [user("one")] }, local).result();
  assert.equal(first.responseCheckpoint, undefined);
  h.mutateEvent = undefined;
  const second: any = await h.makeModels().streamSimple(h.model, { messages: [user("one"), first, user("two")] }, local).result();
  assert.equal(second.responseCheckpoint, undefined);
  const third: any = await h.makeModels().stream(h.model, { messages: [user("one"), first, user("two"), second, user("three")] }, h.options).result();
  assert.equal(third.stopReason, "stop", third.errorMessage);
  assert.deepEqual(h.frames[2], { ...h.frames[0], store: true,
    input: [input("one"), message(first.responseId), input("two"), message(second.responseId), input("three")] });
  assert.ok(third.responseCheckpoint, "genuinely independent full input may establish proof");
  assert.equal(h.frames.length, 3);
  assert.equal(h.generations, 3);
  assert.equal(h.httpFrames.length, 0);
});

test("hook store:false retains connection-local continuation without durable metadata", async (t) => {
  const h = await harness(t);
  const options = { ...h.options, onPayload: (payload: any) => ({ ...payload, store: false }) };
  const first: any = await h.makeModels().stream(h.model, { messages: [user("one")] }, options).result();
  const second: any = await h.makeModels().streamSimple(h.model, { messages: [user("one"), first, user("two")] }, options).result();
  assert.equal(first.stopReason, "stop", first.errorMessage);
  assert.equal(second.stopReason, "stop", second.errorMessage);
  assert.equal(first.responseCheckpoint, undefined);
  assert.equal(second.responseCheckpoint, undefined);
  assert.equal(h.frames[0].store, false);
  assert.deepEqual(h.frames[1], { ...h.frames[0], previous_response_id: first.responseId, input: [input("two")] });
  assert.equal(h.headers.length, 1);
  assert.equal(h.frames.length, 2);
  assert.equal(h.generations, 2);
  assert.equal(h.stored.size, 0);
  assert.equal(h.httpFrames.length, 0);
});

for (const rejection of ["missing", "strict-message"]) test(`caller-supplied rejected parent/input survive unchanged (${rejection})`, async (t) => {
  const h = await harness(t);
  const first: any = await h.makeModels().stream(h.model, { messages: [user("one")] }, h.options).result();
  assert.ok(first.responseCheckpoint);
  h.behavior = (socket) => {
    if (rejection === "missing") rejectMissing(socket);
    else socket.close(1008, "previous_response_id must be a response.id (resp_*), not a message id");
    return true;
  };
  const failed: any = await h.makeModels().streamSimple(h.model, { messages: [user("one"), first, user("two")] }, {
    ...h.options, maxRetries: 2, onPayload: (payload: any) => ({ ...payload, previous_response_id: "external-root", input: [input("caller delta")] }),
  }).result();
  assert.equal(failed.stopReason, "error");
  assert.equal(failed.responseAncestry, "server-dependent", "actual caller parent persists even when pending attempt is discarded");
  assert.equal(failed.responseCheckpoint, undefined);
  assert.deepEqual(h.frames[1], { ...h.frames[0], previous_response_id: "external-root", input: [input("caller delta")] });
  assert.equal(h.frames.length, 2);
  assert.equal(h.generations, 1);
  assert.equal(h.httpFrames.length, 0);
});

for (const method of ["stream", "streamSimple"] as const) test(`${method}: R1 ordinary user/local cannot erase caller-owned dependence`, async (t) => {
  const h = await harness(t);
  const models = h.makeModels();
  const first: any = await models[method](h.model, { messages: [user("one")] }, h.options).result();
  h.stored.set("external", { account: "Bearer dummy-durable-key/", full: [input("hidden server ancestor")] });
  const caller: any = await models[method](h.model, { messages: [user("one"), first, user("two")] }, {
    ...h.options, onPayload: (payload: any) => ({ ...payload, previous_response_id: "external" }),
  }).result();
  assert.equal(caller.stopReason, "stop", caller.errorMessage);
  assert.equal(caller.responseAncestry, "server-dependent");
  assert.equal(caller.responseCheckpoint, undefined);
  for (const empty of [false, true]) {
    closeResponsesWebSockets();
    const messages = [user("one"), first, user("two"), empty ? { ...caller, content: [] } : caller,
      { ...user("ordinary follow-up, not summary"), responseAncestry: "local" }];
    const before = structuredClone(messages);
    const count = h.frames.length;
    const output: any = await models[method](h.model, { messages }, h.options).result();
    assert.deepEqual({ stop: output.stopReason, checkpoint: !!output.responseCheckpoint,
      newFrames: h.frames.length - count, http: h.httpFrames.length },
    { stop: "error", checkpoint: false, newFrames: 0, http: 0 }, `empty dependent=${empty}`);
    assert.equal(output.responseAncestry, "server-dependent");
    assert.deepEqual(messages, before, "ordinary user/local cannot rewrite raw history, including filtered negative output");
  }
});

for (const method of ["stream", "streamSimple"] as const) test(`${method}: R1 ordinary user/local cannot erase malformed ancestry`, async (t) => {
  const h = await harness(t);
  const first: any = await h.makeModels()[method](h.model, { messages: [user("one")] }, h.options).result();
  for (const value of [null, undefined, "", "LOCAL", 1, {}, ["local"]]) {
    closeResponsesWebSockets();
    const malformed = { ...first, responseAncestry: value };
    delete malformed.responseCheckpoint;
    const messages = [user("one"), malformed, { ...user("ordinary follow-up"), responseAncestry: "local" }];
    const before = structuredClone(messages);
    const count = h.frames.length;
    const output: any = await h.makeModels()[method](h.model, { messages }, h.options).result();
    assert.deepEqual({ stop: output.stopReason, checkpoint: !!output.responseCheckpoint,
      newFrames: h.frames.length - count, http: h.httpFrames.length },
    { stop: "error", checkpoint: false, newFrames: 0, http: 0 }, `malformed=${JSON.stringify(value)}`);
    assert.equal(output.responseAncestry, "server-dependent");
    assert.deepEqual(messages, before, "malformed presence must survive without normalization to absence");
  }
});

for (const method of ["stream", "streamSimple"] as const) test(`${method}: R1 ordinary user/local cannot launder genuinely absent legacy ancestry`, async (t) => {
  const h = await harness(t);
  const first: any = await h.makeModels()[method](h.model, { messages: [user("one")] }, h.options).result();
  const legacy = structuredClone(first);
  delete legacy.responseAncestry;
  delete legacy.responseCheckpoint;
  assert.equal(Object.hasOwn(legacy, "responseAncestry"), false);
  closeResponsesWebSockets();
  const baseline: any = await h.makeModels()[method](h.model, { messages: [user("one"), legacy, user("ordinary follow-up")] }, h.options).result();
  assert.equal(baseline.stopReason, "stop", baseline.errorMessage);
  assert.equal(Object.hasOwn(baseline, "responseAncestry"), false);
  assert.ok(baseline.responseCheckpoint, "approved legacy compatibility keeps existing capture eligibility");
  closeResponsesWebSockets();
  const messages = [user("one"), legacy, { ...user("ordinary follow-up"), responseAncestry: "local" }];
  const before = structuredClone(messages);
  const output: any = await h.makeModels()[method](h.model, { messages }, h.options).result();
  assert.equal(output.stopReason, "stop", output.errorMessage);
  assert.equal(Object.hasOwn(output, "responseAncestry"), false, "user/local cannot upgrade compatibility trust to independently local");
  assert.equal(!!output.responseCheckpoint, !!baseline.responseCheckpoint, "no new capture privilege beyond approved legacy behavior");
  assert.deepEqual(h.frames[2], h.frames[1], "legacy cold full-input behavior unchanged by ordinary user metadata");
  assert.equal(h.frames.length, 3);
  assert.equal(h.httpFrames.length, 0);
  assert.deepEqual(messages, before, "legacy absence remains absent in raw history");
});

test("empty malformed latest assistant cannot reuse an older dependent checkpoint after filtering", async (t) => {
  const h = await harness(t);
  h.stored.set("external-root", { account: "Bearer dummy-durable-key/", full: [input("server-only")] });
  const caller: any = await h.makeModels().stream(h.model, { messages: [user("delta")] }, {
    ...h.options, onPayload: (payload: any) => ({ ...payload, previous_response_id: "external-root" }),
  }).result();
  assert.equal(caller.stopReason, "stop", caller.errorMessage);
  const empty = { ...caller, content: [], responseId: "unconfirmed-latest", responseAncestry: null };
  const next: any = await h.makeModels().streamSimple(h.model, { messages: [user("delta"), caller, empty, user("two")] }, h.options).result();
  assert.equal(next.stopReason, "error", "filtering must not restore an older active-branch candidate");
  assert.equal(next.responseAncestry, "server-dependent");
  assert.equal(next.responseCheckpoint, undefined);
  assert.equal(h.frames.length, 1);
  assert.equal(h.httpFrames.length, 0);
});

for (const method of ["stream", "streamSimple"] as const) for (const transport of ["sse", "auto", "websocket", "websocket-cached"] as const) {
  test(`${method}/${transport}: present malformed ancestry never enters legacy fallback`, async (t) => {
    const h = await harness(t);
    const first: any = await h.makeModels()[method](h.model, { messages: [user("one")] }, h.options).result();
    closeResponsesWebSockets();
    for (const value of [null, undefined, "", "LOCAL", 1, {}, ["local"]]) {
      const malformed = { ...first, responseAncestry: value };
      delete malformed.responseCheckpoint;
      const next: any = await h.makeModels()[method](h.model, { messages: [user("one"), malformed, user("two")] }, {
        ...h.options, transport, maxRetries: 0, responseCheckpointExclude: ["*"],
      }).result();
      assert.equal(next.stopReason, "error", JSON.stringify(value));
      assert.equal(next.responseAncestry, "server-dependent");
      assert.equal(next.responseCheckpoint, undefined);
    }
    assert.equal(h.frames.length, 1);
    assert.equal(h.httpFrames.length, 0);
  });
}

for (const reject of [false, true]) test(`malformed latest fact uses independently valid cold chain without capture or repair, rejected=${reject}`, async (t) => {
  const h = await harness(t);
  const first: any = await h.makeModels().stream(h.model, { messages: [user("one")] }, h.options).result();
  assert.ok(first.responseCheckpoint);
  const malformed = { ...first, responseAncestry: null };
  closeResponsesWebSockets();
  if (reject) h.behavior = (socket) => { rejectMissing(socket); return true; };
  const next: any = await h.makeModels().streamSimple(h.model, { messages: [user("one"), malformed, user("two")] }, h.options).result();
  assert.equal(next.stopReason, reject ? "error" : "stop", next.errorMessage);
  assert.equal(next.responseAncestry, "server-dependent");
  assert.equal(next.responseCheckpoint, undefined);
  assert.equal(h.frames[1].previous_response_id, first.responseId);
  assert.deepEqual(h.frames[1].input, [input("two")]);
  assert.equal(h.frames.length, 2, "unknown history cannot use parent-free repair");
  assert.equal(h.httpFrames.length, 0);
});

let hostPrepareRequest: Promise<boolean> | undefined;
function supportsPrepareRequest(t: any): Promise<boolean> {
  return hostPrepareRequest ??= (async () => {
    const h = await harness(t);
    let supported = false;
    const output = await openAIResponsesApi().stream(h.model, { messages: [user("probe")] }, {
      ...h.options, transport: "sse",
      onPayload: (_payload: unknown, _model: unknown, prepareRequest: unknown) => {
        supported = typeof prepareRequest === "function";
      },
    }).result();
    assert.equal(output.stopReason, "stop", output.errorMessage);
    return supported;
  })();
}

test("cold preparation without a host preparer leaves the payload unchanged", async (t) => {
  const h = await harness(t);
  const first: any = await h.makeModels().stream(h.model, { messages: [user("one")] }, h.options).result();
  assert.ok(first.responseCheckpoint);
  closeResponsesWebSockets();
  const bridge = createResponsesWebSocketBridge(h.model, { ...h.options, responseAncestry: "unknown",
    checkpoints: { enabled: true, candidate: { responseId: first.responseId, responseCheckpoint: first.responseCheckpoint } } });
  const payload = { store: true, input: [input("two")] };
  const original = structuredClone(payload);
  assert.equal(bridge.prepare(payload), payload);
  assert.deepEqual(payload, original);
  assert.equal(Object.hasOwn(payload, "previous_response_id"), false);
  assert.equal(h.frames.length, 1);
  assert.equal(h.httpFrames.length, 0);
});

test("provider payload hook forwards the host preparer for cold checkpoint continuation", async (t) => {
  if (!await supportsPrepareRequest(t)) return t.skip("host lacks prepareRequest");
  const h = await harness(t);
  const first: any = await h.makeModels().stream(h.model, { messages: [user("one")] }, h.options).result();
  assert.ok(first.responseCheckpoint);
  closeResponsesWebSockets();
  const second: any = await h.makeModels().stream(h.model,
    { messages: [user("one"), { ...first, responseAncestry: null }, user("two")] }, h.options).result();
  assert.equal(second.stopReason, "stop", second.errorMessage);
  assert.equal(h.frames.length, 2);
  assert.equal(h.frames[1].previous_response_id, first.responseId);
  assert.deepEqual(h.frames[1].input, [input("two")]);
  assert.equal(h.httpFrames.length, 0);
});

for (const mutation of ["url", "body", "credential", "sdk-header", "candidate", "abort"] as const) {
  test(`cold preparation rejects late ${mutation} change before any WS/HTTP send`, async (t) => {
    if (!await supportsPrepareRequest(t)) return t.skip("host lacks prepareRequest");
    const h = await harness(t);
    const first: any = await h.makeModels().stream(h.model, { messages: [user("one")] }, h.options).result();
    assert.ok(first.responseCheckpoint);
    closeResponsesWebSockets();
    const candidate = { responseId: first.responseId, responseCheckpoint: structuredClone(first.responseCheckpoint) };
    const bridge = createResponsesWebSocketBridge(h.model, { ...h.options, responseAncestry: "unknown",
      checkpoints: { enabled: true, candidate } });
    let prepared = false;
    const cancellation = new AbortController();
    const output: any = await openAIResponsesApi().stream(h.model,
      { messages: [user("one"), { ...first, responseAncestry: null }, user("two")] } as any, {
        ...h.options, transport: "sse", signal: cancellation.signal,
        onPayload: async (payload: any, _model: any, prepareRequest: any) => {
          payload.store = true;
          const next: any = await bridge.prepare(payload, prepareRequest);
          assert.equal(next.previous_response_id, first.responseId, "actual client prepared a valid cold parent");
          prepared = true;
          return next;
        },
        fetch: async (input: any, init: any) => {
          let request = new Request(input, init);
          if (mutation === "url") request = new Request(`${request.url}?changed=1`, request);
          if (mutation === "body") request = new Request(request, { body: JSON.stringify({ ...await request.clone().json(), instructions: "changed" }) });
          if (mutation === "credential" || mutation === "sdk-header") {
            const headers = new Headers(request.headers);
            headers.set(mutation === "credential" ? "authorization" : "x-stainless-retry-count", mutation === "credential" ? "Bearer other" : "1");
            request = new Request(request, { headers });
          }
          if (mutation === "candidate") candidate.responseCheckpoint.createdAt += 1;
          if (mutation === "abort") { cancellation.abort(); request = new Request(request, { signal: cancellation.signal }); }
          return bridge.fetch(request);
        },
      }).result();
    assert.equal(prepared, true);
    assert.equal(output.stopReason, mutation === "abort" ? "aborted" : "error",
      JSON.stringify({ stopReason: output.stopReason, error: output.errorMessage, frames: h.frames.length, httpFrames: h.httpFrames.length }));
    assert.equal(h.frames.length, 1, "no followup frame after preparation evidence changes");
    assert.equal(h.httpFrames.length, 0, "no HTTP escape");
  });
}

for (const method of ["stream", "streamSimple"] as const) test(`${method}: SSE caller dependence survives switching to WS and auto cooldown`, async (t) => {
  const h = await harness(t);
  h.handshakeStatus = 503;
  const options = { ...h.options, maxRetries: 0, responseCheckpointExclude: ["*"] };
  for (let i = 0; i < 4; i++) {
    const output: any = await h.makeModels()[method](h.model, { messages: [user(`auto ${i}`)] }, options).result();
    assert.equal(output.stopReason, i === 3 ? "stop" : "error");
    assert.equal(output.responseAncestry, "local");
  }
  assert.equal(h.httpFrames.length, 1, "ordinary local auto request keeps allowed SSE fallback");
  const caller: any = await h.makeModels()[method](h.model, { messages: [user("delta")] }, {
    ...options, transport: "sse", onPayload: (payload: any) => ({ ...payload, previous_response_id: "external-root", store: false }),
  }).result();
  assert.equal(caller.stopReason, "stop", caller.errorMessage);
  assert.equal(caller.responseAncestry, "server-dependent");
  assert.equal(caller.responseCheckpoint, undefined);
  assert.equal(h.httpFrames[1].previous_response_id, "external-root");
  assert.equal(h.httpFrames[1].store, false);
  h.handshakeStatus = undefined;
  const context = { messages: [user("delta"), caller, user("next")] };
  for (const transport of ["websocket", "websocket-cached", "auto", "sse"] as const) {
    const next: any = await h.makeModels()[method](h.model, context, { ...options, transport }).result();
    assert.equal(next.stopReason, "error", transport);
    assert.equal(next.responseAncestry, "server-dependent");
    assert.equal(next.responseCheckpoint, undefined);
  }
  assert.equal(h.frames.length, 0);
  assert.equal(h.httpFrames.length, 2, "cooldown cannot turn known dependence into parent-free HTTP");
  assert.equal(JSON.stringify([...h.frames, ...h.httpFrames, ...h.headers]).includes("responseAncestry"), false);
});

for (const boundary of ["compaction", "branch-summary"] as const) test(`${boundary} projected Context adopts retained old dependent output; later takeover survives same summary and reload`, async (t) => {
  const h = await harness(t);
  const old: any = await h.makeModels().stream(h.model, { messages: [user("old")] }, h.options).result();
  const stored = { ...old, responseAncestry: "server-dependent" };
  const before = structuredClone(stored);
  // Expected typed host projection: user baseline fact plus local copies of retained pre-boundary messages.
  // Actual supported-host summary projection/loader propagation is a separate integration gate.
  const summary = { ...user(`${boundary} summary`), responseAncestry: "local" };
  const retained = { ...stored, responseAncestry: "local" };
  const projected = [summary, user("retained user"), retained, user("next")];
  closeResponsesWebSockets();
  const adopted: any = await h.makeModels().streamSimple(h.model, { messages: projected }, h.options).result();
  assert.equal(adopted.stopReason, "stop", adopted.errorMessage);
  assert.equal(adopted.responseAncestry, "local");
  assert.ok(adopted.responseCheckpoint);
  assert.equal(h.frames[1].previous_response_id, undefined, "pre-rebase checkpoint gets no validation exemption");
  assert.deepEqual(h.frames[1].input, [input(`${boundary} summary`), input("retained user"), message(old.responseId), input("next")]);
  assert.deepEqual(stored, before, "projection never rewrites stored dependent assistant");
  h.stored.set("external-root", { account: "Bearer dummy-durable-key/", full: [input("new hidden ancestry")] });
  const caller: any = await h.makeModels().stream(h.model, { messages: [...projected, adopted, user("takeover")] }, {
    ...h.options, onPayload: (payload: any) => ({ ...payload, previous_response_id: "external-root", input: [input("takeover")] }),
  }).result();
  assert.equal(caller.responseAncestry, "server-dependent");
  assert.equal(caller.responseCheckpoint, undefined);
  const session = SessionManager.create(h.dir, h.dir);
  for (const entry of [...projected, adopted, user("takeover"), caller]) session.appendMessage(entry);
  closeResponsesWebSockets();
  const reopened = SessionManager.open(session.getSessionFile()!);
  reopened.appendMessage(user("after reload"));
  const next: any = await h.makeModels().streamSimple(h.model, { messages: reopened.buildSessionContext().messages }, h.options).result();
  assert.equal(next.stopReason, "error", "old summary is not a perpetual reset of later caller dependence");
  assert.equal(next.responseAncestry, "server-dependent");
  assert.equal(h.frames.length, 3);
  assert.equal(h.httpFrames.length, 0);
});

for (const change of ["edit", "empty", "fork", "rollback", "credential", "headers", "session", "endpoint", "shutdown", "expiry", "eviction"] as const) {
  test(`${change} never rebases new dependent history or resurrects older local anchor`, async (t) => {
    let now = Date.now(); t.mock.method(Date, "now", () => now);
    const h = await harness(t);
    h.mutateEvent = (event) => event.type === "response.completed" ? { ...event, response: { ...event.response, store: true } } : event;
    const first: any = await h.makeModels().stream(h.model, { messages: [user("one")] }, h.options).result();
    h.stored.set("external-root", { account: "Bearer dummy-durable-key/", full: [input("hidden ancestry")] });
    const caller: any = await h.makeModels().streamSimple(h.model, { messages: [user("one"), first, user("delta")] }, {
      ...h.options, onPayload: (payload: any) => ({ ...payload, previous_response_id: "external-root" }),
    }).result();
    assert.equal(caller.responseAncestry, "server-dependent");
    assert.equal(caller.responseCheckpoint, undefined);
    let messages = [user("one"), first, user("delta"), caller, user("two")];
    let model = h.model;
    const options = { ...h.options, maxRetries: 0 };
    if (change === "edit") messages[0] = user("edited");
    if (change === "empty") messages[3] = { ...caller, content: [] };
    if (change === "fork") {
      const session = SessionManager.create(h.dir, h.dir);
      let leaf: string | undefined;
      for (const entry of messages) leaf = session.appendMessage(entry);
      const forkFile = session.createBranchedSession(leaf!);
      assert.ok(forkFile);
      messages = SessionManager.open(forkFile).buildSessionContext().messages;
      assert.equal((messages.find((entry: any) => entry.responseId === caller.responseId) as any).responseAncestry, "server-dependent");
      closeResponsesWebSockets();
    }
    if (change === "rollback") {
      const session = SessionManager.create(h.dir, h.dir);
      let dependentLeaf: string | undefined;
      for (const entry of messages.slice(0, -1)) dependentLeaf = session.appendMessage(entry);
      session.appendMessage({ ...first, responseId: "unselected-local" });
      session.branch(dependentLeaf!);
      session.appendMessage(user("two"));
      messages = session.buildSessionContext().messages;
      assert.equal((messages.at(-2) as any).responseAncestry, "server-dependent");
      assert.equal(messages.some((entry: any) => entry.responseId === "unselected-local"), false);
      closeResponsesWebSockets();
    }
    if (change === "credential") options.apiKey = "different-account";
    if (change === "headers") options.headers = { "x-tenant": "changed" };
    if (change === "session") options.sessionId = "different-session";
    if (change === "endpoint") {
      model = { ...model, baseUrl: `${model.baseUrl}/changed` };
      options.env = { OPENAI_API_EXTENSION_BASE_URL: model.baseUrl };
    }
    if (change === "shutdown") closeResponsesWebSockets(h.options.sessionId);
    if (change === "expiry" || change === "eviction") {
      const closed = [...h.wss.clients].map((socket) => new Promise<void>((resolve) => socket.once("close", () => resolve())));
      for (const socket of h.wss.clients) socket.close(1000, "idle");
      await Promise.all(closed);
      if (change === "expiry") now += 10 * 60_000;
      else for (let i = 0; i < 32; i++) await h.makeModels().stream(h.model, { messages: [user(`other ${i}`)] }, { ...h.options, sessionId: `other-${i}` }).result();
    }
    const before = h.frames.length;
    const next: any = await h.makeModels().streamSimple(model, { messages }, options).result();
    assert.equal(next.stopReason, "error", change);
    assert.equal(next.responseAncestry, "server-dependent");
    assert.equal(next.responseCheckpoint, undefined);
    assert.equal(h.frames.length, before, "no unsafe WS send");
    assert.equal(h.httpFrames.length, 0, "no unsafe SSE escape");
  });
}

for (const method of ["stream", "streamSimple"] as const) test(`${method}: new dependent JSONL survives shutdown and cold reload without checkpoint or unsafe fallback`, async (t) => {
  const h = await harness(t);
  const session = SessionManager.create(h.dir, h.dir);
  session.appendMessage(user("delta"));
  h.stored.set("external-root", { account: "Bearer dummy-durable-key/", full: [input("hidden server history")] });
  const caller: any = await h.makeModels()[method](h.model, { messages: session.buildSessionContext().messages }, {
    ...h.options, responseCheckpointExclude: ["*"],
    onPayload: (payload: any) => ({ ...payload, store: true, previous_response_id: "external-root" }),
  }).result();
  assert.equal(caller.stopReason, "stop", caller.errorMessage);
  assert.equal(caller.responseAncestry, "server-dependent");
  assert.equal(caller.responseCheckpoint, undefined);
  session.appendMessage(caller);
  const raw = await readFile(session.getSessionFile()!, "utf8");
  assert.ok(raw.includes('"responseAncestry":"server-dependent"'));
  closeResponsesWebSockets();
  const reopened = SessionManager.open(session.getSessionFile()!);
  reopened.appendMessage(user("two"));
  const next: any = await h.makeModels()[method](h.model, { messages: reopened.buildSessionContext().messages }, { ...h.options, maxRetries: 2, maxRetryDelayMs: 1 }).result();
  assert.equal(next.stopReason, "error", "cold dependent history cannot become full local input");
  assert.equal(next.responseAncestry, "server-dependent");
  assert.equal(next.responseCheckpoint, undefined);
  assert.equal(h.frames.length, 1);
  assert.equal(h.httpFrames.length, 0);
});

for (const rejection of ["missing", "strict-message"]) test(`caller-owned lineage stays unknown through descendants and ${rejection} rejection`, async (t) => {
  const h = await harness(t);
  const known: any = await h.makeModels().stream(h.model, { messages: [user("known")] }, h.options).result();
  assert.ok(known.responseCheckpoint);
  h.stored.set("external-root", { account: "Bearer dummy-durable-key/", full: [input("server-only")] });
  const caller: any = await h.makeModels().streamSimple(h.model, { messages: [user("known"), known, user("delta")] }, {
    ...h.options, onPayload: (payload: any) => ({ ...payload, previous_response_id: "external-root", input: [input("delta")] }),
  }).result();
  assert.equal(caller.stopReason, "stop", caller.errorMessage);
  assert.equal(caller.responseAncestry, "server-dependent");
  assert.equal(caller.responseCheckpoint, undefined);
  assert.deepEqual(h.frames[1], { ...h.frames[0], previous_response_id: "external-root", input: [input("delta")] });
  const descendant: any = await h.makeModels().stream(h.model, { messages: [user("delta"), caller, user("two")] }, h.options).result();
  assert.equal(descendant.stopReason, "stop", descendant.errorMessage);
  assert.equal(descendant.responseAncestry, "server-dependent");
  assert.equal(descendant.responseCheckpoint, undefined, "server-only ancestry cannot be certified");
  assert.deepEqual(h.frames[2], { ...h.frames[0], previous_response_id: caller.responseId, input: [input("two")] });
  assert.equal(h.headers.length, 1);
  h.behavior = (socket) => {
    if (rejection === "missing") rejectMissing(socket);
    else socket.close(1008, "previous_response_id must be a response.id (resp_*), not a message id");
    return true;
  };
  const failed: any = await h.makeModels().streamSimple(h.model, { messages: [user("delta"), caller, user("two"), descendant, user("three")] },
    { ...h.options, maxRetries: 2 }).result();
  assert.equal(failed.stopReason, "error");
  assert.equal(failed.responseCheckpoint, undefined);
  assert.deepEqual(h.frames[3], { ...h.frames[0], previous_response_id: descendant.responseId, input: [input("three")] });
  assert.equal(h.frames.length, 4);
  assert.equal(h.generations, 3);
  assert.equal(h.httpFrames.length, 0);
  h.behavior = undefined;
  const independent: any = await h.makeModels().stream(h.model, { messages: [user("independent")] }, h.options).result();
  assert.ok(independent.responseCheckpoint, independent.errorMessage);
  assert.deepEqual(h.frames[4], { ...h.frames[0], input: [input("independent")] });
  assert.equal(h.frames.length, 5);
  assert.equal(h.generations, 4);
  assert.equal(h.httpFrames.length, 0);
});

for (const complete of [false, true]) test(`excluded cached turn -> enabled: ${complete ? "complete" : "unrepresented"} output provenance`, async (t) => {
  const h = await harness(t);
  if (!complete) h.mutateEvent = (event) => event.type === "response.completed"
    ? { ...event, response: { ...event.response, output: [...event.response.output, { type: "server_only", id: "opaque-extra" }] } } : event;
  const first: any = await h.makeModels().stream(h.model, { messages: [user("one")] }, {
    ...h.options, responseCheckpointExclude: ["*"], onPayload: (payload: any) => ({ ...payload, store: true }),
  }).result();
  assert.equal(first.stopReason, "stop", first.errorMessage);
  assert.equal(first.responseCheckpoint, undefined);
  h.mutateEvent = undefined;
  const second: any = await h.makeModels().streamSimple(h.model, { messages: [user("one"), first, user("two")] }, h.options).result();
  assert.equal(second.stopReason, "stop", second.errorMessage);
  assert.ok(second.responseCheckpoint, "independent full request establishes a fresh checkpoint");
  assert.deepEqual(h.frames[1], { ...h.frames[0], input: [input("one"), message(first.responseId), input("two")] });
  assert.equal(h.headers.length, 1);
  assert.equal(h.frames.length, 2);
  assert.equal(h.generations, 2);
  assert.equal(h.httpFrames.length, 0);
});

for (const mode of ["incomplete", "failed", "aborted", "missing-output", "hook-store-false", "server-store-false"]) test(`${mode}: never capture, retain useful parsed content`, async (t) => {
  const h = await harness(t);
  const controller = new AbortController();
  if (mode === "aborted") {
    h.behavior = (socket) => {
      const id = h.recordGeneration();
      for (const event of events(id).slice(0, 4)) socket.send(JSON.stringify(event));
      return true;
    };
  } else h.mutateEvent = (event) => {
    if (event.type !== "response.completed") return event;
    if (mode === "incomplete" || mode === "failed") return { ...event, type: `response.${mode}`,
      response: { ...event.response, status: mode, ...(mode === "failed" ? { error: { message: "failed" } } : { incomplete_details: { reason: "max_output_tokens" } }) } };
    if (mode === "missing-output") return { ...event, response: { ...event.response, output: undefined } };
    if (mode === "server-store-false") return { ...event, response: { ...event.response, store: false } };
    return event;
  };
  const stream = h.makeModels().stream(h.model, { messages: [user("one")] }, {
    ...h.options, signal: controller.signal,
    ...(mode === "hook-store-false" ? { onPayload: (payload: any) => ({ ...payload, store: false }) } : {}),
  });
  if (mode === "aborted") for await (const event of stream) if (event.type === "text_delta") controller.abort();
  const output: any = await stream.result();
  assert.equal(output.responseCheckpoint, undefined);
  assert.equal(output.responseAncestry, "local", "storage, completion and cancellation do not erase local request ancestry");
  if (mode === "aborted") assert.equal(output.stopReason, "aborted");
  assert.equal(output.content.find((block: any) => block.type === "text")?.text, "ok");
  assert.equal(h.frames[0].store, mode !== "hook-store-false");
  assert.deepEqual(h.frames[0].input, [input("one")]);
  assert.equal(h.frames.length, 1);
  assert.equal(h.generations, 1);
  assert.equal(h.httpFrames.length, 0);
});

test("stock/fork models.json capability survives real runtime and real extension loader captures", async (t) => {
  const h = await harness(t);
  await writeFile(join(h.dir, "models.json"), JSON.stringify({ providers: { "openai-api-extension": {
    baseUrl: h.model.baseUrl, apiKey: h.options.apiKey, api: "openai-responses", models: [h.model],
  } } }));
  const loaded = await discoverAndLoadExtensions([resolve("index.ts"), resolve("tests/fixtures/checkpoint-cleanup-extension.ts")], h.dir, h.dir);
  assert.deepEqual(loaded.errors, []);
  const cleanup = loaded.extensions[1].commands.get("checkpoint-test-cleanup")!;
  assert.ok(cleanup);
  h.cleanup = () => cleanup.handler(h.options.sessionId, undefined as never);
  const provider = loaded.runtime.pendingNativeProviderRegistrations[0].provider;
  await writeFile(join(h.dir, "auth.json"), JSON.stringify({ "openai-api-extension": { type: "api_key", key: h.options.apiKey,
    env: { OPENAI_API_EXTENSION_BASE_URL: h.model.baseUrl } } }));
  const runtime = await ModelRuntime.create({ authPath: join(h.dir, "auth.json"), modelsPath: join(h.dir, "models.json"), refreshOnCreate: false,
    modelsStore: { read: async (id: string) => id === "openai-api-extension" ? { models: [{ ...h.model, compat: undefined }], checkedAt: Date.now() } : undefined,
      write: async () => {}, delete: async () => {} } });
  runtime.registerNativeProvider(provider);
  await runtime.refresh({ allowNetwork: false });

  const configured: any = runtime.getModel("openai-api-extension", h.model.id);
  assert.ok(configured, "configured model published");
  assert.equal(configured.compat.supportsResponseCheckpoints, true);
  const output: any = await runtime.models.stream(configured, { messages: [user("one")] }, h.options).result();
  assert.equal(output.stopReason, "stop", output.errorMessage);
  assert.ok(output.responseCheckpoint, "loader path must run public codec too");
  const second: any = await runtime.models.streamSimple(configured, { messages: [user("one"), output, user("two")] }, h.options).result();
  assert.equal(second.stopReason, "stop", second.errorMessage);
  assert.ok(second.responseCheckpoint);
  assert.deepEqual(h.frames[1], { ...h.frames[0], previous_response_id: output.responseId, input: [input("two")] });
  assert.equal(h.headers.length, 1, "original sessionId retains pooled connection");
  assert.equal(h.frames.length, 2);
  assert.equal(h.generations, 2);
});
