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
  const received: any[] = [];
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
  async function turn(request = body(), overrides: any = {}, headers: Record<string, string> = {},
    beforeFetch?: (bridge: ReturnType<typeof createResponsesWebSocketBridge>, request: any) => unknown) {
    const bridge = createResponsesWebSocketBridge(model, { ...options, ...overrides });
    lastBridge = bridge;
    try {
      const payload = beforeFetch ? await beforeFetch(bridge, request) : request;
      const response = await bridge.fetch(`${model.baseUrl}/responses`, {
        method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(payload),
      });
      let text = "";
      try {
        for await (const chunk of response.body!) text += new TextDecoder().decode(chunk);
      } finally {
        received.push(...text.split("\n").filter((line) => line.startsWith("data: {")).map((line) => JSON.parse(line.slice(6))));
      }
      const events = text.split("\n").filter((line) => line.startsWith("data: {")).map((line) => JSON.parse(line.slice(6)));
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
  return { frames, sockets, labels, received, model, options, turn, disconnect,
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

test("caller takeover retires old local anchor; reconnect uses only validated dependent chain, never repair", async (t) => {
  const h = await harness(t); h.options.checkpoints.enabled = true; h.options.responseAncestry = "local";
  const first = await h.turn();
  const caller = await h.turn({ ...extended(first.responseId), previous_response_id: "external-root" });
  assert.equal(caller.responseAncestry, "server-dependent");
  assert.equal(caller.responseCheckpoint, undefined);
  await h.disconnect();
  const request = body([...extended(first.responseId).input, assistant(caller.responseId), user("three")]);
  const descendant = await h.turn(request, { responseAncestry: "server-dependent" });
  assert.equal(h.frames[2].body.previous_response_id, caller.responseId, "old resp_1 cannot resurrect");
  assert.deepEqual(h.frames[2].body.input, [user("three")]);
  assert.equal(descendant.responseAncestry, "server-dependent");
  assert.equal(descendant.responseCheckpoint, undefined, "stored dependent chain is not complete-history proof");
  await h.disconnect();
  h.behavior = (socket) => { socket.send(JSON.stringify(missing)); return true; };
  const next = body([...request.input, assistant(descendant.responseId), user("four")]);
  await assert.rejects(h.turn(next, { responseAncestry: "server-dependent", transport: "auto" }));
  assert.equal(h.frames[3].body.previous_response_id, descendant.responseId);
  assert.equal(h.frames.length, 4, "dependent rejection cannot repair parent-free");
  await assert.rejects(h.retryLast(next));
  assert.equal(h.frames.length, 4);
  assert.equal(h.httpRequests, 0);
});

test("caller takeover retires old local anchor even when new output cannot seed a stored chain", async (t) => {
  const h = await harness(t); h.options.checkpoints.enabled = true; const first = await h.turn();
  h.store = false;
  const caller = await h.turn({ ...extended(first.responseId), previous_response_id: "external-root" });
  await h.disconnect();
  const next = body([...extended(first.responseId).input, assistant(caller.responseId), user("three")]);
  await assert.rejects(h.turn(next, { responseAncestry: "server-dependent", transport: "auto" }));
  assert.equal(h.frames.length, 2, "no older anchor or parent-free WS escape");
  assert.equal(h.httpRequests, 0);
});

test("explicit SSE caller takeover retires cached lineage without opening a bookkeeping socket", async (t) => {
  const h = await harness(t); const first = await h.turn();
  const caller = await h.turn({ ...body([user("delta")]), previous_response_id: "external-root" }, {
    transport: "sse", fetch: async () => new Response(`data: ${JSON.stringify({ type: "response.completed",
      response: { id: "resp_sse", status: "completed", output: [assistant("resp_sse")] } })}\n\ndata: [DONE]\n\n`,
    { headers: { "content-type": "text/event-stream" } }),
  });
  assert.equal(caller.responseAncestry, "server-dependent");
  assert.equal(h.sockets.length, 1);
  await h.disconnect();
  await h.turn(extended(first.responseId));
  assert.equal(h.frames[1].body.previous_response_id, undefined, "selected old local branch cannot resurrect retired memory anchor");
});

for (const invalidation of ["shutdown", "caller-takeover", "sse-takeover"] as const) test(`late completion cannot resurrect an anchor after ${invalidation}`, { timeout: 10_000 }, async (t) => {
  const h = await harness(t); h.options.checkpoints.enabled = true;
  const first = await h.turn();
  let unblock!: () => void;
  const held = new Promise<void>((resolve) => { unblock = resolve; });
  let encoding!: () => void;
  const started = new Promise<void>((resolve) => { encoding = resolve; });
  h.options.checkpoints.encodeOutput = async (output: any) => {
    if (output.responseId === "resp_2") { encoding(); await held; }
    return [assistant(output.responseId)];
  };
  const late = h.turn(body([user("late local request")]));
  await started;
  let caller: any;
  if (invalidation === "shutdown") closeResponsesWebSockets("cross-socket");
  else if (invalidation === "sse-takeover") {
    await h.turn({ ...body([user("delta")]), previous_response_id: "external-root" }, {
      transport: "sse", fetch: async () => new Response(`data: ${JSON.stringify({ type: "response.completed",
        response: { id: "resp_sse", status: "completed", output: [assistant("resp_sse")] } })}\n\ndata: [DONE]\n\n`,
      { headers: { "content-type": "text/event-stream" } }),
    });
  } else {
    h.store = false;
    caller = await h.turn({ ...extended(first.responseId), previous_response_id: "external-root" });
    await h.disconnect();
  }
  unblock(); await late;
  const request = invalidation !== "caller-takeover"
    ? body([user("late local request"), assistant("resp_2"), user("next")])
    : body([...extended(first.responseId).input, assistant(caller.responseId), user("next")]);
  if (invalidation !== "caller-takeover") {
    await h.turn(request);
    assert.equal(h.frames.at(-1)!.body.previous_response_id, undefined, "invalidation rejects delayed anchor registration");
  } else {
    const before = h.frames.length;
    await assert.rejects(h.turn(request, { responseAncestry: "server-dependent" }));
    assert.equal(h.frames.length, before, "delayed local completion cannot replace dependent takeover");
  }
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

for (const terminal of ["error", "response.failed"] as const) test(`accepted non-durable repair retains partial text and fences ${terminal} for the logical request`, async (t) => {
  const h = await harness(t); const first = await h.turn(); await h.disconnect();
  h.behavior = (socket, frame) => {
    if (frame.previous_response_id) socket.send(JSON.stringify(missing));
    else {
      socket.send(JSON.stringify({ type: "response.created", response: { id: "resp_partial" } }));
      socket.send(JSON.stringify({ type: "response.output_text.delta", delta: "partial repair text" }));
      setImmediate(() => socket.send(JSON.stringify(terminal === "error"
        ? { type: "error", error: { type: "server_error", code: "server_error", message: "repair failed" } }
        : { type: "response.failed", response: { status: "failed", error: { type: "server_error", message: "repair failed" } } })));
    }
    return true;
  };
  const request = extended(first.responseId);
  await assert.rejects(h.turn(request, { transport: "auto" }));
  assert.equal(h.frames.length, 3);
  assert.equal(h.received.find((event) => event.type === "response.output_text.delta")?.delta, "partial repair text");
  await assert.rejects(h.retryLast(request), "accepted repair failure stays terminal across pending replacement");
  assert.equal(h.frames.length, 3, "same logical request sends no fourth frame");
  assert.equal(h.httpRequests, 0);
  h.behavior = undefined;
  const later = await h.turn(body([user("unrelated")]), { transport: "auto" });
  assert.equal(later.responseId, "resp_4", "later unrelated request is not poisoned");
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
  const status = "status" in frame ? frame.status : "status" in frame.error ? frame.error.status : undefined;
  if (status === undefined) await assert.rejects(h.retryLast(extended(first.responseId)));
  else {
    const response = await h.retryLast(extended(first.responseId));
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), frame, "fetch preserves the original rejection without resending");
  }
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

for (const store of [true, false]) test(`payload preparation exposes validated parent but bridge keeps ownership/store=${store}`, async (t) => {
  const h = await harness(t); h.options.checkpoints.enabled = true;
  const caller = await h.turn({ ...body(), previous_response_id: "external-root" }); await h.disconnect();
  const request = { ...extended(caller.responseId), store };
  const original = structuredClone(request);
  const output = await h.turn(request, { responseAncestry: "server-dependent",
    checkpoints: { ...h.options.checkpoints, candidate: { responseId: caller.responseId } } }, {}, (bridge, full) => {
    const prepared: any = bridge.prepare(full);
    assert.equal(prepared.previous_response_id, caller.responseId);
    assert.deepEqual(prepared.input, full.input, "preparation retains full logical input for final validation");
    assert.equal(h.frames.length, 1, "preparation performs no network I/O");
    assert.deepEqual(full, original);
    return prepared;
  });
  assert.equal(output.responseAncestry, "server-dependent"); assert.equal(output.responseCheckpoint, undefined);
  assert.equal(h.frames[1].body.previous_response_id, caller.responseId);
  assert.deepEqual(h.frames[1].body.input, [user("two")]); assert.equal(h.frames[1].body.store, store);
  assert.equal(h.httpRequests, 0);
});

for (const mutation of ["nested-input", "store", "headers", "request-url", "non-response-route", "invalid-json", "expiry", "invalidation"] as const) {
  test(`payload preparation revalidates ${mutation} without stale parent or replay`, async (t) => {
    let now = Date.now(); t.mock.method(Date, "now", () => now);
    const h = await harness(t); h.options.checkpoints.enabled = true;
    const caller = await h.turn({ ...body(), previous_response_id: "external-root" }); await h.disconnect();
    const headers: Record<string, string> = {};
    const request = extended(caller.responseId);
    await assert.rejects(h.turn(request, { responseAncestry: "server-dependent",
      checkpoints: { ...h.options.checkpoints, candidate: { responseId: caller.responseId } } }, headers, (bridge, full) => {
      const prepared: any = bridge.prepare(full); assert.equal(prepared.previous_response_id, caller.responseId);
      if (mutation === "nested-input") prepared.input[0].content = "edited after preparation";
      if (mutation === "store") prepared.store = false;
      if (mutation === "headers") headers["x-tenant"] = "changed after preparation";
      if (mutation === "request-url" || mutation === "non-response-route" || mutation === "invalid-json") {
        const fetch = bridge.fetch;
        bridge.fetch = (input, init) => mutation === "invalid-json" ? fetch(input, { ...init, body: "{" })
          : fetch(new URL(mutation === "request-url" ? "/other/responses" : "/chat/completions", String(input)), init);
      }
      if (mutation === "expiry") now += 10 * 60_000;
      if (mutation === "invalidation") closeResponsesWebSockets("cross-socket");
      return prepared;
    }), mutation === "invalid-json" ? SyntaxError : /Prepared continuation changed before transport/);
    assert.equal(h.frames.length, 1); assert.equal(h.httpRequests, 0);
    await assert.rejects(h.retryLast(request)); assert.equal(h.frames.length, 1, "same request cannot retry a stale plan");
    const later = await h.turn(body([user("unrelated")])); assert.equal(later.stopReason, "stop");
  });
}

test("prepared dependent missing reference stays bridge-owned and cannot repair parent-free", async (t) => {
  const h = await harness(t); h.options.checkpoints.enabled = true;
  const caller = await h.turn({ ...body(), previous_response_id: "external-root" }); await h.disconnect();
  h.behavior = (socket) => { socket.send(JSON.stringify(missing)); return true; };
  const request = extended(caller.responseId);
  await assert.rejects(h.turn(request, { responseAncestry: "server-dependent", transport: "auto",
    checkpoints: { ...h.options.checkpoints, candidate: { responseId: caller.responseId } } }, {}, (bridge, full) => bridge.prepare(full)));
  assert.equal(h.frames.length, 2); assert.equal(h.frames[1].body.previous_response_id, caller.responseId);
  await assert.rejects(h.retryLast(request)); assert.equal(h.frames.length, 2); assert.equal(h.httpRequests, 0);
});

test("payload preparation never claims actual caller parent or cold unvalidated lineage", async (t) => {
  const h = await harness(t); h.options.checkpoints.enabled = true;
  const caller = await h.turn({ ...body(), previous_response_id: "external-root" }); await h.disconnect();
  const explicit = { ...extended(caller.responseId), previous_response_id: "new-caller-root" };
  const output = await h.turn(explicit, { responseAncestry: "server-dependent",
    checkpoints: { ...h.options.checkpoints, candidate: { responseId: caller.responseId } } }, {}, (bridge, full) => {
    assert.equal(bridge.prepare(full), full, "caller payload passes through unchanged"); return full;
  });
  assert.equal(h.frames[1].body.previous_response_id, "new-caller-root"); assert.equal(output.responseAncestry, "server-dependent");
  closeResponsesWebSockets();
  const request = body([...explicit.input, assistant(output.responseId), user("three")]);
  await assert.rejects(h.turn(request, { responseAncestry: "server-dependent",
    checkpoints: { ...h.options.checkpoints, candidate: { responseId: output.responseId } } }, {}, (bridge, full) => {
    assert.equal(bridge.prepare(full), full, "no invented parent on cold cache miss"); return full;
  }));
  assert.equal(h.frames.length, 2); assert.equal(h.httpRequests, 0);
});

for (const change of ["credential", "tenant", "model", "session", "envelope", "prefix", "latest"] as const) {
  test(`payload preparation declines unvalidated ${change} identity before exposing parent`, async (t) => {
    const h = await harness(t); h.options.checkpoints.enabled = true;
    const caller = await h.turn({ ...body(), previous_response_id: "external-root" }); await h.disconnect();
    const request: any = extended(caller.responseId);
    const options = { ...h.options, responseAncestry: "server-dependent",
      checkpoints: { ...h.options.checkpoints, candidate: { responseId: caller.responseId } } };
    if (change === "credential") options.apiKey = "different-credential";
    if (change === "tenant") options.headers = { "x-tenant": "different-tenant" };
    if (change === "model") h.model.id = "different-model";
    if (change === "session") options.sessionId = "different-session";
    if (change === "envelope") request.instructions = "different instructions";
    if (change === "prefix") request.input[0].content = "different prefix";
    if (change === "latest") options.checkpoints.candidate.responseId = "different-latest";
    const bridge = createResponsesWebSocketBridge(h.model, options);
    assert.equal(bridge.prepare(request), request);
    assert.equal(request.previous_response_id, undefined); assert.equal(h.frames.length, 1); assert.equal(h.httpRequests, 0);
  });
}

test("prepared nonstored lineage stays connection-local through cooldown and fails cold", async (t) => {
  const h = await harness(t); h.options.checkpoints.enabled = true; h.store = false;
  const caller = await h.turn({ ...body(), previous_response_id: "external-root" });
  const second = await h.turn({ ...extended(caller.responseId), store: false }, { responseAncestry: "server-dependent",
    checkpoints: { ...h.options.checkpoints, candidate: { responseId: caller.responseId } } }, {}, (bridge, full) => {
    const prepared: any = bridge.prepare(full); assert.equal(prepared.previous_response_id, caller.responseId); return prepared;
  });
  assert.equal(h.frames[1].connection, h.frames[0].connection);
  assert.equal(h.frames[1].body.store, false); assert.deepEqual(h.frames[1].body.input, [user("two")]);
  assert.equal(second.responseAncestry, "server-dependent"); assert.equal(second.responseCheckpoint, undefined);
  await h.disconnect();
  const third = { ...body([...extended(caller.responseId).input, assistant(second.responseId), user("three")]), store: false };
  await assert.rejects(h.turn(third, { responseAncestry: "server-dependent",
    checkpoints: { ...h.options.checkpoints, candidate: { responseId: second.responseId } } }, {}, (bridge, full) => {
    assert.equal(bridge.prepare(full), full, "unacknowledged storage cannot become a reconnect anchor"); return full;
  }));
  assert.equal(h.frames.length, 2); assert.equal(h.httpRequests, 0);
});
