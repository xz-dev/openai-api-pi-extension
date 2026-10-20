import assert from "node:assert/strict";
import { once } from "node:events";
import { test, type TestContext } from "node:test";
import { WebSocketServer, type WebSocket } from "ws";
import { createResponsesWebSocketBridge, closeResponsesWebSockets } from "../responses-websocket-fetch.ts";

const user = (content: string) => ({ role: "user", content });
const assistant = (id: string) => ({ type: "message", id: `msg_${id}`, role: "assistant", status: "completed",
  content: [{ type: "output_text", text: "ok", annotations: [] }] });
const body = (input: any[] = [user("one")]) => ({ model: "mock", store: true, stream: true, input });
const extended = (id: string) => body([user("one"), assistant(id), user("two")]);
const missing = { type: "error", error: { type: "invalid_request_error", code: "previous_response_not_found", message: "Missing stored response" } };

async function harness(t: TestContext, perMessageDeflate = false) {
  let handshakeStatus: number | undefined;
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1", perMessageDeflate,
    verifyClient: (_info, done) => done(handshakeStatus === undefined, handshakeStatus) });
  await once(wss, "listening");
  const address = wss.address(); assert.ok(address && typeof address === "object");
  const frames: Array<{ body: any; connection: number }> = [];
  const sockets: WebSocket[] = [];
  const labels: string[] = [];
  let behavior: ((socket: WebSocket, frame: any) => boolean) | undefined;
  let store: boolean | undefined = true;
  let httpRequests = 0;
  let lastBridge: ReturnType<typeof createResponsesWebSocketBridge>;
  wss.on("connection", (socket) => {
    sockets.push(socket); const connection = sockets.length;
    socket.on("message", (raw) => {
      const frame = JSON.parse(String(raw)); frames.push({ body: frame, connection });
      if (behavior?.(socket, frame)) return;
      const id = `resp_${frames.length}`;
      socket.send(JSON.stringify({ type: "response.completed", response: {
        id, status: "completed", store, output: [assistant(id)],
      } }));
    });
  });
  t.after(async () => {
    closeResponsesWebSockets();
    for (const socket of wss.clients) socket.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });
  const model: any = { id: "mock", api: "openai-responses", provider: "openai-api-extension",
    baseUrl: `http://127.0.0.1:${address.port}/v1` };
  const options: any = { apiKey: "test-key", sessionId: "cross-socket", transport: "websocket-cached",
    checkpoints: { enabled: false, encodeOutput: async (output: any) => [assistant(output.responseId)] },
    onTransport: (label: string) => { labels.push(label); },
    fetch: async () => { httpRequests++; throw new Error("unexpected HTTP replay"); } };
  async function turn(request = body(), overrides: any = {}, headers: Record<string, string> = {}) {
    const bridge = createResponsesWebSocketBridge(model, { ...options, ...overrides });
    lastBridge = bridge;
    try {
      const response = await bridge.fetch(`${model.baseUrl}/responses`, {
        method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(request),
      });
      const events = (await response.text()).split("\n").filter((line) => line.startsWith("data: {")).map((line) => JSON.parse(line.slice(6)));
      const completed = events.find((event) => event.type === "response.completed");
      if (!completed) throw new Error("turn did not complete");
      const output: any = { stopReason: "stop", responseId: completed.response.id };
      await bridge.finish(output);
      return output;
    } catch (error) {
      await bridge.finish({ stopReason: "error" } as any);
      throw error;
    }
  }
  async function disconnect() {
    const socket = sockets.at(-1)!;
    const closed = once(socket, "close"); socket.close(1000, "server idle timeout"); await closed;
  }
  return { frames, sockets, labels, model, options, turn, disconnect,
    retryLast: (request = body()) => lastBridge.fetch(`${model.baseUrl}/responses`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request),
    }),
    get httpRequests() { return httpRequests; },
    set store(value: boolean | undefined) { store = value; },
    set handshakeStatus(value: number | undefined) { handshakeStatus = value; },
    set behavior(value: typeof behavior) { behavior = value; } };
}

test("idle close reconnect sends confirmed stored ID and exact delta, reporting WS/continuation", { timeout: 10_000 }, async (t) => {
  const h = await harness(t);
  const first = await h.turn();
  await h.disconnect();
  await h.turn(extended(first.responseId));
  assert.deepEqual(h.frames.map((frame) => frame.connection), [1, 2]);
  assert.deepEqual(h.frames[1].body, { ...h.frames[0].body, previous_response_id: first.responseId, input: [user("two")] });
  assert.deepEqual(h.labels, ["WS/full", "WS/continuation"]);
});

for (const store of [undefined, false]) test(`completion store=${store} never seeds a new socket`, async (t) => {
  const h = await harness(t); h.store = store;
  const first = await h.turn(); await h.disconnect();
  await h.turn(extended(first.responseId));
  assert.equal(h.frames[1].body.previous_response_id, undefined);
  assert.deepEqual(h.frames[1].body.input, extended(first.responseId).input);
});

test("request store:false cannot gain a cross-socket anchor from server store:true", async (t) => {
  const h = await harness(t);
  const first = await h.turn({ ...body(), store: false }); await h.disconnect();
  await h.turn({ ...extended(first.responseId), store: false });
  assert.equal(h.frames[1].body.previous_response_id, undefined);
});

for (const changed of ["credential", "headers", "session", "endpoint"] as const) test(`stored anchor isolates ${changed}`, async (t) => {
  const h = await harness(t);
  const headers = { authorization: "Bearer identical-http-override", "x-tenant": "first" };
  const first = await h.turn(body(), {}, headers); await h.disconnect();
  const overrides = changed === "session" ? { sessionId: "different-session" } : {};
  if (changed === "endpoint") h.model.baseUrl += "/other";
  await h.turn(extended(first.responseId), overrides, changed === "credential"
    ? { ...headers, authorization: "Bearer different-actual-credential" }
    : changed === "headers" ? { ...headers, "x-tenant": "second" } : headers);
  assert.equal(h.frames[1].body.previous_response_id, undefined);
  assert.deepEqual(h.frames[1].body.input, extended(first.responseId).input);
});

for (const changed of ["input", "output", "envelope", "caller-parent"] as const) test(`stored anchor refuses changed ${changed}`, async (t) => {
  const h = await harness(t); const first = await h.turn(); await h.disconnect();
  const request: any = extended(first.responseId);
  if (changed === "input") request.input[0] = user("edited one");
  if (changed === "output") request.input[1].content[0].text = "edited answer";
  if (changed === "envelope") request.model = "other";
  if (changed === "caller-parent") request.previous_response_id = "caller-owned";
  await h.turn(request);
  assert.deepEqual(h.frames[1].body, { type: "response.create", ...request });
});

test("anchor expires after ten minutes without refreshing its age on reconnect", async (t) => {
  let now = Date.now(); t.mock.method(Date, "now", () => now);
  const h = await harness(t); const first = await h.turn(); await h.disconnect();
  now += 9 * 60_000;
  h.behavior = (socket) => { socket.send(JSON.stringify({ type: "error", error: { type: "server_error", code: "server_error" } })); return true; };
  await assert.rejects(h.turn(extended(first.responseId)));
  assert.equal(h.frames[1].body.previous_response_id, first.responseId);
  h.behavior = undefined; now += 60_000;
  await h.turn(extended(first.responseId));
  assert.equal(h.frames[2].body.previous_response_id, undefined);
});

test("anchor storage evicts oldest identity at its 32-entry bound", async (t) => {
  const h = await harness(t);
  for (let i = 0; i < 33; i++) {
    await h.turn(body(), { sessionId: `bounded-${i}` }); await h.disconnect();
  }
  await h.turn(extended("resp_1"), { sessionId: "bounded-0" });
  assert.equal(h.frames[33].body.previous_response_id, undefined);
  await h.turn(extended("resp_33"), { sessionId: "bounded-32" });
  assert.equal(h.frames[34].body.previous_response_id, "resp_33");
});

test("partial failed turn retains last confirmed anchor, never the failed response", async (t) => {
  const h = await harness(t); const first = await h.turn(); await h.disconnect();
  h.behavior = (socket) => {
    socket.send(JSON.stringify({ type: "response.created", response: { id: "resp_failed" } }));
    socket.send(JSON.stringify({ type: "response.output_text.delta", delta: "partial" }));
    socket.send(JSON.stringify(missing));
    return true;
  };
  await assert.rejects(h.turn(extended(first.responseId)));
  assert.equal(h.frames.length, 2, "partial output never repairs");
  await assert.rejects(h.retryLast(extended(first.responseId)));
  assert.equal(h.frames.length, 2, "provider retry never resends a partially executed turn");
  h.behavior = undefined;
  await h.turn(extended(first.responseId));
  assert.equal(h.frames[2].body.previous_response_id, first.responseId);
  assert.deepEqual(h.frames[2].body.input, [user("two")]);
});

for (const rejection of ["missing", "missing-failed-frame", "legacy"] as const) test(`${rejection} stored-anchor rejection repairs once on a fresh socket with full history`, async (t) => {
  const h = await harness(t); const first = await h.turn(); await h.disconnect();
  h.behavior = (socket, frame) => {
    if (!frame.previous_response_id) return false;
    if (rejection === "missing") socket.send(JSON.stringify(missing));
    else if (rejection === "missing-failed-frame") socket.send(JSON.stringify({ type: "response.failed", status: 400,
      response: { status: "failed", error: missing.error } }));
    else socket.close(1008, "previous_response_id must be a response.id (resp_*), not a message id");
    return true;
  };
  const request = extended(first.responseId);
  const repaired = await h.turn(request);
  assert.equal(repaired.responseId, "resp_3");
  assert.deepEqual(h.frames.map((frame) => frame.connection), [1, 2, 3]);
  assert.equal(h.frames[1].body.previous_response_id, first.responseId);
  const { store: _store, ...repair } = request;
  assert.deepEqual(h.frames[2].body, { type: "response.create", ...repair });
  assert.equal(h.httpRequests, 0);
  await h.disconnect(); await h.turn(request);
  assert.equal(h.frames[3].body.previous_response_id, undefined, "rejected anchor removed");
});

test("second repair rejection stays terminal for provider retries", async (t) => {
  const h = await harness(t); const first = await h.turn(); await h.disconnect();
  h.behavior = (socket) => { socket.send(JSON.stringify(missing)); return true; };
  const request = extended(first.responseId);
  await assert.rejects(h.turn(request, { transport: "auto" }));
  assert.equal(h.frames.length, 3);
  await assert.rejects(h.retryLast(request));
  assert.equal(h.frames.length, 3);
  assert.equal(h.httpRequests, 0);
});

for (const frame of [
  { ...missing, status: 500 },
  { ...missing, status: 401 },
  { ...missing, status: 429 },
  { type: "error", error: { ...missing.error, code: "invalid_api_key" } },
  { type: "error", error: { ...missing.error, type: "server_error" } },
  { type: "error", code: "server_error", error: { ...missing.error, status: 400 } },
]) test(`conflicting rejection ${JSON.stringify(frame)} never replays stored continuation`, async (t) => {
  const h = await harness(t); const first = await h.turn(); await h.disconnect();
  h.behavior = (socket) => { socket.send(JSON.stringify(frame)); return true; };
  await assert.rejects(h.turn(extended(first.responseId), { transport: "auto" }));
  assert.equal(h.frames.length, 2);
  assert.equal(h.httpRequests, 0);
  await assert.rejects(h.retryLast(extended(first.responseId)));
  assert.equal(h.frames.length, 2);
});

test("ambiguous socket close never replays stored continuation", async (t) => {
  const h = await harness(t); const first = await h.turn(); await h.disconnect();
  h.behavior = (socket) => { socket.close(1011, "backend unavailable"); return true; };
  await assert.rejects(h.turn(extended(first.responseId), { transport: "auto" }));
  assert.equal(h.frames.length, 2);
  assert.equal(h.httpRequests, 0);
});

test("durable bridge uses memory anchor when message checkpoint is absent, then honors cooldown and probe", async (t) => {
  let now = Date.now(); t.mock.method(Date, "now", () => now);
  const h = await harness(t); h.options.checkpoints.enabled = true;
  const first = await h.turn(); await h.disconnect();
  // No candidate metadata is supplied: this continuation comes from the in-process anchor.
  h.behavior = (socket, frame) => { if (!frame.previous_response_id) return false; socket.send(JSON.stringify(missing)); return true; };
  await h.turn(extended(first.responseId));
  assert.equal(h.frames[1].body.previous_response_id, first.responseId);
  assert.equal(h.frames[2].body.previous_response_id, undefined);
  h.behavior = undefined; await h.disconnect();
  await h.turn(extended(first.responseId));
  assert.equal(h.frames[3].body.previous_response_id, undefined);
  assert.equal(h.frames[3].body.store, undefined);
  await h.disconnect(); now += 5 * 60_000;
  await h.turn(extended(first.responseId));
  assert.equal(h.frames[4].body.previous_response_id, undefined);
  assert.equal(h.frames[4].body.store, true, "recovery probe uses full context with storage");
  await h.disconnect();
  await h.turn(body([...extended(first.responseId).input, assistant("resp_5"), user("three")]));
  assert.equal(h.frames[5].body.previous_response_id, "resp_5", "successful probe may establish a new confirmed anchor");
  assert.deepEqual(h.frames[5].body.input, [user("three")]);
});

test("auto recovery discards old anchor and probes with full input", async (t) => {
  const h = await harness(t); h.options.transport = "auto";
  const first = await h.turn(); await h.disconnect();
  h.behavior = (socket) => {
    socket.send(JSON.stringify({ type: "response.created", response: { id: "resp_failed" } }), () => socket.terminate());
    return true;
  };
  await assert.rejects(h.turn(extended(first.responseId)));
  h.behavior = undefined;
  await h.turn(extended(first.responseId));
  assert.equal(h.frames[2].body.previous_response_id, undefined);
  assert.equal(h.frames[2].body.store, true, "transport retry preserves caller storage intent");
  assert.deepEqual(h.frames[2].body.input, extended(first.responseId).input);
});

test("session shutdown clears its anchor without discarding other sessions", async (t) => {
  const h = await harness(t);
  const first = await h.turn(); await h.disconnect();
  const other = await h.turn(body(), { sessionId: "other" }); await h.disconnect();
  closeResponsesWebSockets("cross-socket");
  await h.turn(extended(first.responseId));
  assert.equal(h.frames[2].body.previous_response_id, undefined);
  await h.turn(extended(other.responseId), { sessionId: "other" });
  assert.equal(h.frames[3].body.previous_response_id, other.responseId);
});

test("first-frame response.failed 5xx cannot be replayed by the same bridge", async (t) => {
  const h = await harness(t); const first = await h.turn(); await h.disconnect();
  h.behavior = (socket) => {
    socket.send(JSON.stringify({ type: "response.failed", status: 500,
      response: { status: "failed", error: { type: "server_error", code: "server_error", message: "failed" } } }));
    return true;
  };
  await assert.rejects(h.turn(extended(first.responseId), { transport: "auto" }));
  assert.equal(h.frames.length, 2);
  await assert.rejects(h.retryLast(extended(first.responseId)));
  assert.equal(h.frames.length, 2);
  assert.equal(h.httpRequests, 0);
});

for (const encodeOutput of [async () => [], async () => { throw new Error("unsupported codec"); }]) {
  test("unproven output encoding never creates a cross-socket anchor", async (t) => {
    const h = await harness(t); h.options.checkpoints.encodeOutput = encodeOutput;
    const first = await h.turn(); await h.disconnect();
    await h.turn(extended(first.responseId));
    assert.equal(h.frames[1].body.previous_response_id, undefined);
  });
}

test("compressed reconnect labels preserve negotiated extensions and isolate observer failures", async (t) => {
  const h = await harness(t, true);
  h.options.onTransport = (label: string) => { h.labels.push(label); throw new Error("observer only"); };
  const first = await h.turn(); await h.disconnect(); await h.turn(extended(first.responseId));
  assert.equal(h.frames.length, 2);
  assert.equal(h.frames[1].body.previous_response_id, first.responseId);
  assert.deepEqual(h.labels, ["WS/full DEFLATE", "WS/continuation DEFLATE"]);
});

for (const status of [401, 503]) test(`stored reconnect handshake ${status} never falls back to full HTTP replay`, async (t) => {
  const h = await harness(t); const first = await h.turn(); await h.disconnect();
  h.handshakeStatus = status;
  await assert.rejects(h.turn(extended(first.responseId), { transport: "auto" }));
  assert.equal(h.frames.length, 1);
  assert.equal(h.httpRequests, 0);
  await assert.rejects(h.retryLast(extended(first.responseId)));
  assert.equal(h.httpRequests, 0);
});
