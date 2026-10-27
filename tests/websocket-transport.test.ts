import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { once } from "node:events";
import OpenAI from "openai";
import { WebSocketError } from "openai/resources/responses/internal-base";
import { createServer, type Server } from "node:http";
import { WebSocketServer } from "ws";
import type { Message } from "@earendil-works/pi-ai";
import { createOpenAIApiProvider } from "../index.ts";
import { closeResponsesWebSockets, createResponsesWebSocketBridge, getActualResponsesTransport } from "../src/responses-websocket-fetch.ts";

const servers: Array<Server | WebSocketServer> = [];

afterEach(async () => {
  closeResponsesWebSockets();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

function model(baseUrl: string) {
  return {
    id: "mock-gpt",
    name: "Mock GPT",
    provider: "openai-api-extension",
    api: "openai-responses" as const,
    baseUrl,
    reasoning: false,
    input: ["text"] as Array<"text" | "image">,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 16384,
  };
}

function responseEvents(responseId: string, text: string) {
  const message = {
    id: `msg_${responseId}`,
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  return [
    { type: "response.created", response: { id: responseId } },
    { type: "response.output_item.added", output_index: 0, item: message },
    { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: text },
    { type: "response.output_item.done", output_index: 0, item: message },
    {
      type: "response.completed",
      response: {
        id: responseId,
        status: "completed",
        output: [message],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ];
}

function completed(socket: import("ws").WebSocket, responseId: string, text: string) {
  for (const event of responseEvents(responseId, text)) socket.send(JSON.stringify(event));
}

async function server(
  onRequest: (body: Record<string, unknown>, connection: number, socket: import("ws").WebSocket) => void,
  verifyRequest?: (request: import("node:http").IncomingMessage) => void,
) {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  servers.push(wss);
  await new Promise<void>((resolve) => wss.once("listening", resolve));
  let connections = 0;
  wss.on("connection", (socket, request) => {
    verifyRequest?.(request);
    const connection = ++connections;
    socket.on("message", (raw) => onRequest(JSON.parse(String(raw)), connection, socket));
  });
  const address = wss.address();
  assert.ok(address && typeof address === "object");
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, get connections() { return connections; } };
}

async function sseServer(text: string) {
  let requests = 0;
  const http = createServer(async (request, response) => {
    requests++;
    assert.equal(request.url, "/v1/responses");
    for await (const _chunk of request) { /* consume request */ }
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of responseEvents(`resp_sse_${requests}`, text)) response.write(`data: ${JSON.stringify(event)}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  servers.push(http);
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  assert.ok(address && typeof address === "object");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    server: http,
    get requests() { return requests; },
  };
}

test("SDK connection lifetime closes an idle connection on a late API error", { timeout: 5_000 }, async () => {
  let idleSocket: import("ws").WebSocket;
  const upstream = await server((_body, _connection, socket) => {
    idleSocket = socket;
    completed(socket, "resp_idle", "ok");
  });
  const provider = createOpenAIApiProvider();
  const options = { apiKey: "bridge-key", transport: "websocket-cached" as const, sessionId: "sdk-idle-error" };
  const context = { messages: [{ role: "user" as const, content: "ping", timestamp: 1 }] };
  assert.equal((await provider.streamSimple(model(upstream.baseUrl), context, options).result()).stopReason, "stop");

  const closed = once(idleSocket!, "close");
  idleSocket!.send(JSON.stringify({ type: "error", error: { code: "server_error", message: "late idle failure" } }));
  await closed;

  const later = await provider.streamSimple(model(upstream.baseUrl), context, options).result();
  assert.equal(later.stopReason, "stop", later.errorMessage);
  assert.equal(upstream.connections, 2, "failed idle socket must not be reused");
});

test("SDK connection lifetime preserves the active iterator API error", { timeout: 5_000 }, async () => {
  const fault = { type: "error", error: { code: "server_error", message: "active SDK failure", status: 500 } };
  let requests = 0;
  let httpRequests = 0;
  const upstream = await server((_body, _connection, socket) => {
    requests++;
    socket.send(JSON.stringify({ type: "response.created", response: { id: "resp_active" } }));
    socket.send(JSON.stringify(fault));
  });
  const bridge = createResponsesWebSocketBridge(model(upstream.baseUrl), {
    apiKey: "bridge-key", transport: "auto", sessionId: "sdk-active-error",
    fetch: async () => { httpRequests++; throw new Error("unexpected HTTP replay"); },
  });
  const response = await bridge.fetch(`${upstream.baseUrl}/responses`, {
    method: "POST", body: JSON.stringify({ model: "mock-gpt", input: [], stream: true }),
  });
  await assert.rejects(response.text(), (error) => {
    assert.ok(error instanceof WebSocketError);
    assert.deepEqual(error.error, fault);
    assert.equal(error.message, JSON.stringify(fault));
    return true;
  });
  assert.equal(requests, 1);
  assert.equal(httpRequests, 0);
});

for (const status of [400, 401, 429, 503]) {
  for (const location of ["frame", "detail"] as const) {
    test(`pre-output application status ${status} at ${location} survives SDK fetch and retries`, { timeout: 5_000 }, async () => {
      const fault = { type: "error", ...(location === "frame" ? { status } : {}), error: {
        type: status === 400 ? "invalid_request_error" : "server_error",
        code: status === 400 ? "context_length_exceeded" : "fixture_application_error",
        message: "structured application rejection",
        ...(location === "detail" ? { status } : {}),
      } };
      let requests = 0;
      let httpRequests = 0;
      const upstream = await server((_body, _connection, socket) => {
        requests++;
        socket.send(JSON.stringify(fault));
      });
      const bridge = createResponsesWebSocketBridge(model(upstream.baseUrl), {
        apiKey: "bridge-key", transport: "auto", sessionId: `application-${status}-${location}`,
        fetch: async () => { httpRequests++; throw new Error("unexpected HTTP replay"); },
      });
      const responses: Array<{ status: number; body: unknown }> = [];
      const client = new OpenAI({ apiKey: "bridge-key", baseURL: upstream.baseUrl, maxRetries: 1,
        fetch: async (input, init) => {
          const response = await bridge.fetch(input, init);
          responses.push({ status: response.status, body: await response.clone().json() });
          return response;
        },
      });
      await assert.rejects(client.responses.create({ model: "mock-gpt", input: [], stream: true }), (error) => {
        assert.ok(error instanceof OpenAI.APIError);
        assert.ok(!(error instanceof OpenAI.APIConnectionError));
        assert.equal(error.status, status);
        assert.deepEqual(error.error, fault.error);
        return true;
      });
      assert.equal(responses.length, status === 429 || status >= 500 ? 2 : 1);
      for (const response of responses) {
        assert.equal(response.status, status);
        assert.deepEqual(response.body, fault, "original application envelope survives fetch");
      }
      assert.equal(requests, 1, "same logical failure never resends a WS frame");
      assert.equal(httpRequests, 0);
    });
  }
}

for (const transport of ["auto", "websocket", "websocket-cached"] as const) {
  test(`pre-output application status 429 preserves ${transport} connection-limit recovery`, { timeout: 5_000 }, async () => {
    const requests: Array<Record<string, unknown>> = [];
    let httpRequests = 0;
    const upstream = await server((body, _connection, socket) => {
      requests.push(body);
      if (requests.length <= 2) socket.send(JSON.stringify({ type: "error", status: 429,
        error: { code: "websocket_connection_limit_reached", message: "connection full" } }));
      else completed(socket, "resp_after_limit", "recovered");
    });
    const output = await createOpenAIApiProvider().streamSimple(model(upstream.baseUrl),
      { messages: [{ role: "user", content: "ping", timestamp: 1 }] },
      { apiKey: "bridge-key", transport, sessionId: `application-limit-${transport}`, maxRetries: 1,
        fetch: async () => { httpRequests++; throw new Error("unexpected HTTP replay"); } }).result();
    assert.equal(output.stopReason, "stop", output.errorMessage);
    assert.equal(requests.length, 3, "one special fresh retry, then one genuine provider retry");
    assert.equal(upstream.connections, 3);
    assert.deepEqual(requests[1], requests[0]);
    assert.deepEqual(requests[2], requests[0]);
    assert.equal(httpRequests, 0);
  });
}

for (const status of [undefined, null, "400", 399, 600, 400.5]) {
  test(`pre-output application status ${String(status)} never invents an HTTP status`, { timeout: 5_000 }, async () => {
    const fault = { type: "error", status, error: { code: "fixture_application_error", message: "original failure" } };
    let requests = 0;
    let httpRequests = 0;
    const upstream = await server((_body, _connection, socket) => {
      requests++;
      socket.send(JSON.stringify(fault));
    });
    const bridge = createResponsesWebSocketBridge(model(upstream.baseUrl), {
      apiKey: "bridge-key", transport: "auto", sessionId: "application-invalid-status",
      fetch: async () => { httpRequests++; throw new Error("unexpected HTTP replay"); },
    });
    await assert.rejects(bridge.fetch(`${upstream.baseUrl}/responses`, {
      method: "POST", body: JSON.stringify({ model: "mock-gpt", input: [], stream: true }),
    }), (error) => {
      assert.ok(error instanceof WebSocketError);
      assert.deepEqual(error.error, JSON.parse(JSON.stringify(fault)));
      return true;
    });
    assert.equal(requests, 1);
    assert.equal(httpRequests, 0);
  });
}

test("SDK connection lifetime keeps a replacement pooled after a displaced connection error", { timeout: 5_000 }, async () => {
  let displacedSocket: import("ws").WebSocket;
  let started!: () => void;
  const firstStarted = new Promise<void>((resolve) => { started = resolve; });
  const usedConnections: number[] = [];
  const upstream = await server((_body, connection, socket) => {
    usedConnections.push(connection);
    if (connection === 1) {
      displacedSocket = socket;
      socket.send(JSON.stringify({ type: "response.created", response: { id: "resp_displaced" } }));
      started();
    } else completed(socket, `resp_replacement_${usedConnections.length}`, "replacement ok");
  });
  const provider = createOpenAIApiProvider();
  const options = { apiKey: "bridge-key", transport: "websocket-cached" as const, sessionId: "sdk-displaced-error" };
  const context = { messages: [{ role: "user" as const, content: "ping", timestamp: 1 }] };
  const first = provider.streamSimple(model(upstream.baseUrl), context, options).result();
  await firstStarted;
  assert.equal((await provider.streamSimple(model(upstream.baseUrl), context, options).result()).stopReason, "stop");

  displacedSocket!.send(JSON.stringify({ type: "error", error: { code: "server_error", message: "displaced failure" } }));
  const failed = await first;
  assert.equal(failed.stopReason, "error");
  assert.match(failed.errorMessage ?? "", /displaced failure/);
  const later = await provider.streamSimple(model(upstream.baseUrl), context, options).result();
  assert.equal(later.stopReason, "stop", later.errorMessage);
  assert.deepEqual(usedConnections, [1, 2, 2], "old error must not evict replacement");
});

test("websocket transport reuses Pi request building, parser, auth, and headers", async () => {
  let request: Record<string, unknown> | undefined;
  const upstream = await server((body, _connection, socket) => {
    request = body;
    completed(socket, "resp_ws", "websocket ok");
  }, (upgrade) => {
    assert.deepEqual(upgrade.rawHeaders.filter((value) => value.toLowerCase() === "authorization"), ["Authorization"]);
    assert.equal(upgrade.headers.authorization, "Bearer bridge-key");
    assert.equal(upgrade.headers["x-bridge-test"], "present");
  });
  const output = await createOpenAIApiProvider().streamSimple(
    model(upstream.baseUrl),
    { systemPrompt: "Be concise.", messages: [{ role: "user", content: "ping", timestamp: 1 }] },
    {
      apiKey: "bridge-key",
      headers: { "x-bridge-test": "present" },
      reasoning: "high",
      transport: "websocket",
      sessionId: "ws-test",
    },
  ).result();

  assert.equal(output.stopReason, "stop", output.errorMessage ?? "WebSocket request failed");
  assert.equal(output.content[0]?.type, "text");
  assert.equal(output.content[0]?.text, "websocket ok");
  assert.equal(request?.type, "response.create");
  assert.equal(request?.model, "mock-gpt");
  assert.equal(request?.stream, true);
});

test("websocket-cached reuses connection and sends previous_response_id with delta input", async () => {
  const requests: Array<{ body: Record<string, unknown>; connection: number }> = [];
  const upstream = await server((body, connection, socket) => {
    requests.push({ body, connection });
    completed(socket, `resp_${requests.length}`, `answer ${requests.length}`);
  });
  const provider = createOpenAIApiProvider();
  const first = await provider.streamSimple(
    model(upstream.baseUrl),
    { messages: [{ role: "user", content: "one", timestamp: 1 }] },
    { apiKey: "bridge-key", transport: "websocket-cached", sessionId: "cached-test" },
  ).result();
  const second = await provider.streamSimple(
    model(upstream.baseUrl),
    {
      messages: [
        { role: "user", content: "one", timestamp: 1 },
        first,
        { role: "user", content: "two", timestamp: 2 },
      ],
    },
    { apiKey: "bridge-key", transport: "websocket-cached", sessionId: "cached-test" },
  ).result();

  assert.equal(second.content[0]?.type, "text");
  assert.equal(second.content[0]?.text, "answer 2");
  assert.equal(upstream.connections, 1);
  assert.equal(requests[0]?.body.previous_response_id, undefined);
  assert.equal(requests[1]?.body.previous_response_id, "resp_1");
  assert.deepEqual(requests[1]?.body.input, [{ role: "user", content: [{ type: "input_text", text: "two" }] }]);
});

// Sub2API ingress rejects a message-id-shaped previous_response_id before
// generation and closes WS 1008 ("previous_response_id must be a response.id
// (resp_*), not a message id"). Pi persists the text block's message id
// (msg_*) in textSignature, not the response id. The bridge must anchor
// continuations on the top-level response.id observed on the wire, never on a
// message-id-shaped value cached from the assistant message.
function rejectMessageIdAnchors(socket: import("ws").WebSocket, body: Record<string, unknown>): boolean {
  const previous = typeof body.previous_response_id === "string" ? body.previous_response_id : undefined;
  if (previous && !/^resp_[A-Za-z0-9_-]{1,256}$/.test(previous)) {
    socket.close(1008, "previous_response_id must be a response.id (resp_*), not a message id");
    return true;
  }
  return false;
}

test("websocket-cached never sends a message id as previous_response_id", async () => {
  const requests: Array<{ body: Record<string, unknown>; connection: number }> = [];
  const upstream = await server((body, connection, socket) => {
    requests.push({ body, connection });
    if (rejectMessageIdAnchors(socket, body)) return;
    completed(socket, `resp_turn_${requests.length}`, `answer ${requests.length}`);
  });
  const provider = createOpenAIApiProvider();
  const options = {
    apiKey: "bridge-key",
    transport: "websocket-cached" as const,
    sessionId: "cached-no-message-id",
    websocketConnectTimeoutMs: 1_000,
  };
  const first = await provider.streamSimple(
    model(upstream.baseUrl),
    { messages: [{ role: "user", content: "one", timestamp: 1 }] },
    options,
  ).result();
  assert.equal(first.stopReason, "stop", first.errorMessage);
  // Pi persists the message id (msg_*), not the response id, on text blocks.
  const textBlock = first.content.find((block) => block.type === "text");
  assert.match(String((textBlock as { textSignature?: string })?.textSignature ?? ""), /msg_/);

  const second = await provider.streamSimple(
    model(upstream.baseUrl),
    {
      messages: [
        { role: "user", content: "one", timestamp: 1 },
        first,
        { role: "user", content: "two", timestamp: 2 },
      ],
    },
    options,
  ).result();
  assert.equal(second.stopReason, "stop", second.errorMessage);
  assert.equal(second.content[0]?.text, "answer 2");
  assert.equal(upstream.connections, 1);
  assert.equal(requests.length, 2);
  assert.equal(requests[1]?.body.previous_response_id, "resp_turn_1");
  assert.deepEqual(requests[1]?.body.input, [{ role: "user", content: [{ type: "input_text", text: "two" }] }]);

  // Legal cached resp_* anchors keep producing correct incremental requests.
  const third = await provider.streamSimple(
    model(upstream.baseUrl),
    {
      messages: [
        { role: "user", content: "one", timestamp: 1 },
        first,
        { role: "user", content: "two", timestamp: 2 },
        second,
        { role: "user", content: "three", timestamp: 3 },
      ],
    },
    options,
  ).result();
  assert.equal(third.stopReason, "stop", third.errorMessage);
  assert.equal(third.content[0]?.text, "answer 3");
  assert.equal(requests.length, 3);
  assert.equal(requests[2]?.body.previous_response_id, "resp_turn_2");
  assert.deepEqual(requests[2]?.body.input, [{ role: "user", content: [{ type: "input_text", text: "three" }] }]);
});


// An explicit pre-execution invalid-reference rejection (WS 1008, no output)
// may recover once on a fresh WebSocket with the complete context. It must not
// replay partial output and must not loop the same rejected-anchor class:
// later turns keep the full request instead of repeating a rejection the
// endpoint is already known to emit.
test("websocket-cached recovers once with full context after an explicit invalid-reference rejection", async () => {
  const requests: Array<{ body: Record<string, unknown>; connection: number }> = [];
  const upstream = await server((body, connection, socket) => {
    requests.push({ body, connection });
    // Gateway rejects every continuation anchor before execution: protocol
    // error event, then WS 1008 close (Sub2API ingress shape).
    if (typeof body.previous_response_id === "string" && body.previous_response_id) {
      socket.send(JSON.stringify({
        type: "error",
        error: {
          type: "invalid_request_error",
          code: "invalid_request",
          message: "previous_response_id must be a response.id (resp_*), not a message id",
        },
        sequence_number: 0,
      }), () => socket.close(1008, "previous_response_id must be a response.id (resp_*), not a message id"));
      return;
    }
    completed(socket, `resp_valid_${requests.length}`, `answer ${requests.length}`);
  });
  const provider = createOpenAIApiProvider();
  const options = {
    apiKey: "bridge-key",
    transport: "websocket-cached" as const,
    sessionId: "cached-invalid-ref-recovery",
    websocketConnectTimeoutMs: 1_000,
  };
  const first = await provider.streamSimple(
    model(upstream.baseUrl),
    { messages: [{ role: "user", content: "one", timestamp: 1 }] },
    options,
  ).result();
  assert.equal(first.stopReason, "stop", first.errorMessage);

  const second = await provider.streamSimple(
    model(upstream.baseUrl),
    {
      messages: [
        { role: "user", content: "one", timestamp: 1 },
        first,
        { role: "user", content: "two", timestamp: 2 },
      ],
    },
    options,
  ).result();
  assert.equal(second.stopReason, "stop", second.errorMessage);
  assert.equal(second.content[0]?.text, "answer 3");
  assert.equal(upstream.connections, 2);
  assert.equal(requests.length, 3);
  assert.equal(requests[1]?.connection, 1);
  assert.match(String(requests[1]?.body.previous_response_id), /^resp_/);
  assert.deepEqual(requests[1]?.body.input, [{ role: "user", content: [{ type: "input_text", text: "two" }] }]);
  // Recovery replays complete context with no parent reference.
  assert.equal(requests[2]?.connection, 2);
  assert.equal(requests[2]?.body.previous_response_id, undefined);
  const recoveredInput = requests[2]?.body.input;
  assert.ok(Array.isArray(recoveredInput));
  assert.equal((recoveredInput[0] as { role?: unknown }).role, "user");
  assert.equal((recoveredInput.at(-1) as { role?: unknown })?.role, "user");
  assert.deepEqual(
    (recoveredInput.at(-1) as { content?: unknown[] })?.content,
    [{ type: "input_text", text: "two" }],
  );

  // The endpoint is already known to reject this continuation anchor class,
  // so the next turn keeps complete context instead of repeating the same
  // rejection on a third socket.
  const third = await provider.streamSimple(
    model(upstream.baseUrl),
    {
      messages: [
        { role: "user", content: "one", timestamp: 1 },
        first,
        { role: "user", content: "two", timestamp: 2 },
        second,
        { role: "user", content: "three", timestamp: 3 },
      ],
    },
    options,
  ).result();
  assert.equal(third.stopReason, "stop", third.errorMessage);
  assert.equal(third.content[0]?.text, "answer 4");
  assert.equal(upstream.connections, 2);
  assert.equal(requests.length, 4);
  assert.equal(requests[3]?.connection, 2);
  assert.equal(requests[3]?.body.previous_response_id, undefined);
  const fullInput = requests[3]?.body.input;
  assert.ok(Array.isArray(fullInput));
  assert.equal((fullInput[0] as { role?: unknown }).role, "user");
  assert.deepEqual(
    (fullInput.at(-1) as { content?: unknown[] })?.content,
    [{ type: "input_text", text: "three" }],
  );
});

// Reproduces the observed incident shape: the gateway returns a top-level
// response.id like msg_server_N, then strict ingress rejects that value as
// previous_response_id before execution. The bridge may recover once with
// full context, but must not repeat the same rejection class every later
// turn. An endpoint that accepts opaque anchors is unaffected (the probe
// covers that case); this test pins the incompatible endpoint.
test("websocket-cached stops repeating an incompatible msg_* anchor after one rejection", async () => {
  const requests: Array<{ body: Record<string, unknown>; connection: number }> = [];
  let generations = 0;
  let rejected = 0;
  const upstream = await server((body, connection, socket) => {
    requests.push({ body, connection });
    if (body.previous_response_id) {
      rejected++;
      socket.close(1008, "previous_response_id must be a response.id (resp_*), not a message id");
      return;
    }
    generations++;
    completed(socket, `msg_server_${generations}`, `answer ${generations}`);
  });
  const provider = createOpenAIApiProvider();
  const options = {
    apiKey: "bridge-key",
    transport: "websocket-cached" as const,
    sessionId: "incompatible-msg-anchor",
    websocketConnectTimeoutMs: 1_000,
  };
  const first = await provider.streamSimple(
    model(upstream.baseUrl),
    { messages: [{ role: "user", content: "one", timestamp: 1 }] },
    options,
  ).result();
  assert.equal(first.stopReason, "stop", first.errorMessage);
  assert.equal(first.responseId, "msg_server_1");

  const second = await provider.streamSimple(
    model(upstream.baseUrl),
    {
      messages: [
        { role: "user", content: "one", timestamp: 1 },
        first,
        { role: "user", content: "two", timestamp: 2 },
      ],
    },
    options,
  ).result();
  assert.equal(second.stopReason, "stop", second.errorMessage);
  assert.equal(second.content[0]?.text, "answer 2");
  // Bridge-owned msg_server_1 anchor rejected once, then retried parent-free.
  assert.equal(rejected, 1);
  assert.equal(requests[1]?.body.previous_response_id, "msg_server_1");
  assert.deepEqual(requests[1]?.body.input, [{ role: "user", content: [{ type: "input_text", text: "two" }] }]);
  assert.equal(requests[2]?.connection, 2);
  assert.equal(requests[2]?.body.previous_response_id, undefined);
  assert.ok((requests[2]?.body.input as unknown[]).length > 1, "retry sends complete context");

  const third = await provider.streamSimple(
    model(upstream.baseUrl),
    {
      messages: [
        { role: "user", content: "one", timestamp: 1 },
        first,
        { role: "user", content: "two", timestamp: 2 },
        second,
        { role: "user", content: "three", timestamp: 3 },
      ],
    },
    options,
  ).result();
  assert.equal(third.stopReason, "stop", third.errorMessage);
  assert.equal(third.content[0]?.text, "answer 3");
  // Same rejection class never repeats: one rejection total across four
  // requests (turn 1, rejected delta, parent-free retry, full turn 3), two
  // sockets, three generations. Later turns keep complete context parent-free.
  assert.equal(rejected, 1);
  assert.equal(requests.length, 4);
  assert.equal(upstream.connections, 2);
  assert.equal(generations, 3);
  assert.equal(requests[3]?.connection, 2);
  assert.equal(requests[3]?.body.previous_response_id, undefined);
  const last = requests[3]?.body.input;
  assert.ok(Array.isArray(last));
  assert.equal((last[0] as { role?: unknown }).role, "user");
  assert.deepEqual(
    (last.at(-1) as { content?: unknown[] })?.content,
    [{ type: "input_text", text: "three" }],
  );
});

// Neither an unrelated policy/auth 1008 nor a bare ambiguous close may
// trigger blind inference replay: the request must surface the failure once
// without a same-request WS retry.
for (const scenario of ["policy-1008", "ambiguous-close"] as const) {
  test(`websocket-cached does not replay a continuation on ${scenario}`, async () => {
    const requests: Array<{ body: Record<string, unknown>; connection: number }> = [];
    const upstream = await server((body, connection, socket) => {
      requests.push({ body, connection });
      if (body.previous_response_id) {
        if (scenario === "policy-1008") {
          socket.send(JSON.stringify({
            type: "error",
            error: { type: "insufficient_quota", code: "billing_disabled", message: "account disabled" },
            sequence_number: 0,
          }), () => socket.close(1008, "policy violation"));
        } else {
          socket.terminate();
        }
        return;
      }
      completed(socket, `resp_${requests.length}`, `answer ${requests.length}`);
    });
    const provider = createOpenAIApiProvider();
    const options = {
      apiKey: "bridge-key",
      transport: "websocket-cached" as const,
      sessionId: `cached-no-replay-${scenario}`,
      websocketConnectTimeoutMs: 1_000,
    };
    const first = await provider.streamSimple(
      model(upstream.baseUrl),
      { messages: [{ role: "user", content: "one", timestamp: 1 }] },
      options,
    ).result();
    const second = await provider.streamSimple(
      model(upstream.baseUrl),
      {
        messages: [
          { role: "user", content: "one", timestamp: 1 },
          first,
          { role: "user", content: "two", timestamp: 2 },
        ],
      },
      options,
    ).result();
    assert.equal(second.stopReason, "error");
    // Exactly one WS request for the failed turn: no replayed generation.
    assert.equal(requests.length, 2);
    assert.equal(upstream.connections, 1);
  });
}

// Merely naming previous_response_id is not an explicit invalid-reference
// rejection. An auth/policy error mentioning the field and a server error
// with unknown execution status must both fail closed: one WS request, one
// generation at most.
for (const scenario of ["auth-parent-wording", "unknown-execution", "auth-close", "unknown-close", "auth-invalid-request"] as const) {
  test(`websocket-cached does not replay on ${scenario} error naming previous_response_id`, async () => {
    const requests: Array<{ body: Record<string, unknown>; connection: number }> = [];
    let generations = 0;
    const upstream = await server((body, _connection, socket) => {
      requests.push({ body });
      generations++;
      if (body.previous_response_id) {
        if (scenario === "auth-close" || scenario === "unknown-close") {
          socket.close(1008, scenario === "auth-close"
            ? "Invalid API key; previous_response_id requests require authentication"
            : "Upstream returned invalid state using previous_response_id; execution status unknown");
          return;
        }
        const error = scenario === "auth-invalid-request"
          ? { type: "invalid_request_error", code: "invalid_api_key", message: "Invalid API key for previous_response_id requests" }
          : scenario === "auth-parent-wording"
            ? { type: "insufficient_quota", code: "billing_disabled", message: "Account disabled; previous_response_id requests are not authorized" }
            : { type: "server_error", code: "backend_timeout", message: "Timed out using previous_response_id; execution status unknown" };
        socket.send(JSON.stringify({ type: "error", error, sequence_number: 0 }), () => socket.close(1008, "policy violation"));
        return;
      }
      completed(socket, `resp_${requests.length}`, `answer ${requests.length}`);
    });
    const provider = createOpenAIApiProvider();
    const options = {
      apiKey: "bridge-key",
      transport: "websocket-cached" as const,
      sessionId: `cached-no-replay-${scenario}`,
      websocketConnectTimeoutMs: 1_000,
    };
    const first = await provider.streamSimple(
      model(upstream.baseUrl),
      { messages: [{ role: "user", content: "one", timestamp: 1 }] },
      options,
    ).result();
    const second = await provider.streamSimple(
      model(upstream.baseUrl),
      {
        messages: [
          { role: "user", content: "one", timestamp: 1 },
          first,
          { role: "user", content: "two", timestamp: 2 },
        ],
      },
      options,
    ).result();
    assert.equal(second.stopReason, "error");
    assert.equal(requests.length, 2, `no replayed request after ${scenario}`);
    assert.equal(upstream.connections, 1);
    assert.equal(generations, 2, "rejected turn must not generate twice");
  });
}

// A caller-supplied previous_response_id rides on delta-only input and is not
// a bridge-owned full-history baseline. Its rejection must fail closed: no
// retry, no parent-stripped replay built from partial context.
test("websocket-cached fails closed when a caller-supplied parent is rejected", async () => {
  const requests: Array<Record<string, unknown>> = [];
  let generations = 0;
  const upstream = await server((body, _connection, socket) => {
    requests.push(body);
    if (body.previous_response_id) {
      socket.close(1008, "previous_response_id must be a response.id (resp_*), not a message id");
      return;
    }
    generations++;
    completed(socket, `resp_${requests.length}`, `answer ${requests.length}`);
  });
  const output = await createOpenAIApiProvider().streamSimple(
    model(upstream.baseUrl),
    { messages: [{ role: "user", content: "delta only", timestamp: 1 }] },
    {
      apiKey: "bridge-key",
      transport: "websocket-cached",
      sessionId: "caller-parent-rejected",
      samplingParams: { previous_response_id: "msg_caller_parent" },
      websocketConnectTimeoutMs: 1_000,
    },
  ).result();
  assert.equal(output.stopReason, "error");
  assert.equal(requests.length, 1, "caller-owned reference must not be replayed");
  assert.equal(requests[0]?.previous_response_id, "msg_caller_parent");
  assert.equal(generations, 0);
});

for (const scenario of ["explicit", "implicit", "inherited"] as const) {
  test(`websocket-cached preserves caller-parent ancestry on ${scenario} rejection`, async () => {
    const requests: Array<Record<string, unknown>> = [];
    const externalHistory = new Set(["resp_external_root"]);
    const rejectAt = scenario === "inherited" ? 3 : 2;
    let generations = 0;
    const upstream = await server((body, _connection, socket) => {
      requests.push(body);
      if (requests.length === rejectAt && body.previous_response_id) {
        socket.close(1008, "previous_response_id must be a response.id (resp_*), not a message id");
        return;
      }
      generations++;
      const id = `resp_${requests.length}`;
      const retainsExternal = typeof body.previous_response_id === "string" && externalHistory.has(body.previous_response_id);
      if (retainsExternal) externalHistory.add(id);
      completed(socket, id, retainsExternal ? "WITH_EXTERNAL_HISTORY" : "LOST_EXTERNAL_HISTORY");
    });
    const provider = createOpenAIApiProvider();
    const messages: Message[] = [];
    for (let turn = 1; turn <= rejectAt; turn++) {
      messages.push({ role: "user", content: `turn ${turn}`, timestamp: turn });
      const output = await provider.streamSimple(model(upstream.baseUrl), { messages }, {
        apiKey: "bridge-key", transport: "websocket-cached", sessionId: `caller-ancestry-${scenario}`,
        websocketConnectTimeoutMs: 1_000,
        // "explicit" pins the connection-local resp_* rewrite; durable checkpoints
        // send a caller parent verbatim instead (durable-provider caller-supplied tests).
        ...(scenario === "explicit" ? { responseCheckpointExclude: ["*"] } : {}),
        ...(turn === 1 || scenario === "explicit" ? { samplingParams: { previous_response_id: "resp_external_root" } } : {}),
      }).result();
      if (turn === rejectAt) {
        assert.equal(output.stopReason, "error", "must not replace caller-only history with a parent-free generation");
      } else {
        assert.equal(output.stopReason, "stop", output.errorMessage);
        assert.equal(output.content[0]?.type, "text");
        assert.equal(output.content[0]?.text, "WITH_EXTERNAL_HISTORY");
        messages.push(output);
      }
    }
    assert.equal(requests.length, rejectAt);
    assert.equal(requests.at(-1)?.previous_response_id, `resp_${rejectAt - 1}`);
    assert.equal(generations, rejectAt - 1);
  });
}

for (const transport of ["auto", "websocket-cached"] as const) {
  for (const maxRetries of [0, 1, 2]) {
    test(`${transport} does not replay a failed reference repair with maxRetries=${maxRetries}`, async () => {
      let requests = 0;
      let generations = 0;
      let sseFallbacks = 0;
      const upstream = await server((body, _connection, socket) => {
        requests++;
        if (requests === 2) {
          socket.close(1008, "previous_response_id must be a response.id (resp_*), not a message id");
          return;
        }
        generations++;
        if (requests === 1) completed(socket, "resp_first", "first answer");
        else if (JSON.stringify(body.input).includes('"later"')) completed(socket, "resp_later", "later request works");
        else socket.close(1011, "execution status unknown");
      });
      const provider = createOpenAIApiProvider();
      const options = {
        apiKey: "bridge-key", transport, maxRetries, sessionId: `repair-terminal-${transport}-${maxRetries}`,
        websocketConnectTimeoutMs: 1_000,
        fetch: async () => {
          sseFallbacks++;
          generations++;
          return new Response(responseEvents("resp_replayed", "duplicate inference")
            .map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
          { headers: { "content-type": "text/event-stream" } });
        },
      };
      const firstUser: Message = { role: "user", content: "one", timestamp: 1 };
      const first = await provider.streamSimple(model(upstream.baseUrl), { messages: [firstUser] }, options).result();
      const messages: Message[] = [firstUser, first, { role: "user", content: "two", timestamp: 2 }];
      const second = await provider.streamSimple(model(upstream.baseUrl), { messages }, options).result();
      assert.equal(second.stopReason, "error");
      assert.equal(requests, 3);
      assert.equal(sseFallbacks, 0);
      assert.equal(generations, 2);

      // Terminal state belongs to this model request, not all future calls.
      const later = await provider.streamSimple(model(upstream.baseUrl), {
        messages: [...messages, { role: "user", content: "later", timestamp: 3 }],
      }, options).result();
      assert.equal(later.stopReason, "stop", later.errorMessage);
      assert.equal(later.content[0]?.type, "text");
      assert.equal(later.content[0]?.text, "later request works");
      assert.equal(requests, 4);
      assert.equal(sseFallbacks, 0);
      assert.equal(generations, 3);
    });
  }
}

test("auto cached failure uses native WS retry budget and next request recovers with full context", async () => {
  const requests: Array<{ body: Record<string, unknown>; connection: number }> = [];
  let sseFallbacks = 0;
  const upstream = await server((body, connection, socket) => {
    requests.push({ body, connection });
    if (requests.length === 1) {
      completed(socket, "resp_cached", "cached answer");
      return;
    }
    if (connection === 1) {
      socket.terminate();
      return;
    }
    completed(socket, "resp_fresh", "fresh recovery");
  });
  const provider = createOpenAIApiProvider();
  const options = {
    apiKey: "bridge-key",
    fetch: async () => {
      sseFallbacks++;
      return new Response(
        responseEvents("resp_sse", "fallback ok").map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
    samplingParams: { previous_response_id: "caller-provided" },
    transport: "auto" as const,
    sessionId: "cached-fresh-recovery",
    // Transport-only fixture: default checkpoint mode "always" would fence the
    // post-send replay this test exercises, so durable checkpoints opt out.
    responseCheckpointExclude: ["*"],
    websocketConnectTimeoutMs: 1_000,
  };
  const first = await provider.streamSimple(
    model(upstream.baseUrl),
    { messages: [{ role: "user", content: "one", timestamp: 1 }] },
    options,
  ).result();
  const messages = [
    { role: "user" as const, content: "one", timestamp: 1 },
    first,
    { role: "user" as const, content: "two", timestamp: 2 },
  ];
  const fallback = await provider.streamSimple(model(upstream.baseUrl), { messages }, options).result();
  assert.equal(fallback.stopReason, "error", "first transport failure remains within native WS retry budget");
  assert.equal(sseFallbacks, 0);
  assert.equal(upstream.connections, 1);
  assert.equal(requests.length, 2);

  const recovered = await provider.streamSimple(
    model(upstream.baseUrl),
    { messages: [...messages, fallback, { role: "user", content: "three", timestamp: 3 }] },
    options,
  ).result();

  assert.equal(recovered.stopReason, "stop", recovered.errorMessage ?? "Fresh WebSocket recovery failed");
  assert.equal(recovered.content[0]?.text, "fresh recovery");
  assert.equal(sseFallbacks, 0);
  assert.equal(upstream.connections, 2);
  assert.equal(requests.length, 3);
  assert.equal(requests[1]?.connection, 1);
  assert.equal(requests[1]?.body.previous_response_id, "resp_cached");
  assert.deepEqual(requests[1]?.body.input, [{ role: "user", content: [{ type: "input_text", text: "two" }] }]);
  assert.equal(requests[2]?.connection, 2);
  assert.equal(requests[2]?.body.previous_response_id, "caller-provided", "fresh recovery preserves explicit caller ancestry");
  const freshInput = requests[2]?.body.input;
  assert.ok(Array.isArray(freshInput));
  assert.ok(freshInput.length > 1);
  assert.equal((freshInput[0] as { role?: unknown }).role, "user");
  assert.deepEqual(freshInput.at(-1), { role: "user", content: [{ type: "input_text", text: "three" }] });
});

test("auto cached and fresh failures exhaust three WS retries before SSE cooldown", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: 0 });
  const fallback = await sseServer("fallback ok");
  const wss = new WebSocketServer({ noServer: true });
  servers.push(wss);
  let upgradeAttempts = 0;
  let connections = 0;
  let websocketRequests = 0;
  fallback.server.on("upgrade", (request, socket, head) => {
    upgradeAttempts++;
    wss.handleUpgrade(request, socket, head, (client) => wss.emit("connection", client, request));
  });
  wss.on("connection", (socket) => {
    connections++;
    socket.on("message", () => {
      websocketRequests++;
      if (websocketRequests === 1) completed(socket, "resp_cached", "cached answer");
      else socket.terminate();
    });
  });

  const provider = createOpenAIApiProvider();
  const options = {
    apiKey: "bridge-key",
    transport: "auto" as const,
    sessionId: "cached-fresh-sse-fallback",
    // Transport-only fixture: default checkpoint mode "always" would fence the
    // post-send replay this test exercises, so durable checkpoints opt out.
    responseCheckpointExclude: ["*"],
    websocketConnectTimeoutMs: 1_000,
  };
  const first = await provider.streamSimple(
    model(fallback.baseUrl),
    { messages: [{ role: "user", content: "one", timestamp: 1 }] },
    options,
  ).result();
  const fallbackOutput = await provider.streamSimple(
    model(fallback.baseUrl),
    {
      messages: [
        { role: "user", content: "one", timestamp: 1 },
        first,
        { role: "user", content: "two", timestamp: 2 },
      ],
    },
    options,
  ).result();

  assert.equal(fallbackOutput.stopReason, "error");
  assert.equal(upgradeAttempts, 1);
  assert.equal(connections, 1);
  assert.equal(websocketRequests, 2);
  assert.equal(fallback.requests, 0);
  const request = () => provider.streamSimple(model(fallback.baseUrl),
    { messages: [{ role: "user", content: "fresh retry", timestamp: 3 }] }, { ...options, maxRetries: 0 }).result();
  for (let i = 0; i < 2; i++) assert.equal((await request()).stopReason, "error");
  assert.equal(upgradeAttempts, 3);
  assert.equal(fallback.requests, 0);
  assert.equal((await request()).stopReason, "stop");
  assert.equal(upgradeAttempts, 4);
  assert.equal(connections, 4);
  assert.equal(websocketRequests, 5);
  assert.equal(fallback.requests, 1);
  await request();
  assert.equal(upgradeAttempts, 4);
  assert.equal(fallback.requests, 2);
});

test("auto keeps provider retries on SSE; only next post-cooldown request probes WS", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: 0 });
  const fallback = await sseServer("fallback ok");
  const wss = new WebSocketServer({ noServer: true });
  servers.push(wss);
  let websocketAvailable = false;
  let upgradeAttempts = 0;
  let fetchAttempts = 0;
  fallback.server.on("upgrade", (request, socket, head) => {
    upgradeAttempts++;
    if (!websocketAvailable) socket.destroy();
    else wss.handleUpgrade(request, socket, head, (client) => wss.emit("connection", client, request));
  });
  wss.on("connection", (socket) => {
    socket.on("message", () => completed(socket, "resp_recovered", "websocket recovered"));
  });
  const provider = createOpenAIApiProvider();
  const options = {
    apiKey: "bridge-key",
    transport: "auto" as const,
    sessionId: "provider-retry-recovery",
    maxRetries: 1,
    websocketConnectTimeoutMs: 1_000,
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchAttempts++;
      if (fetchAttempts === 1) return new Response("retry SSE", { status: 503, headers: { "retry-after-ms": "1" } });
      return fetch(input, init);
    },
  };
  const request = (maxRetries = options.maxRetries) => provider.streamSimple(
    model(fallback.baseUrl),
    { messages: [{ role: "user", content: "ping", timestamp: 1 }] },
    { ...options, maxRetries },
  ).result();

  for (let i = 0; i < 3; i++) assert.equal((await request(0)).stopReason, "error");
  const first = await request();
  assert.equal(first.stopReason, "stop", first.errorMessage);
  assert.equal(first.content[0]?.text, "fallback ok");
  assert.equal(fetchAttempts, 2, "Pi still retries a retryable SSE response");
  assert.equal(upgradeAttempts, 4, "provider retry must remain SSE within the same logical request");
  assert.equal(fallback.requests, 1);

  websocketAvailable = true;
  context.mock.timers.tick(120_000);
  const recovered = await request();
  assert.equal(recovered.stopReason, "stop", recovered.errorMessage);
  assert.equal(recovered.content[0]?.text, "websocket recovered");
  assert.equal(upgradeAttempts, 5, "only a post-cooldown real request may probe a fresh WebSocket");
  assert.equal(fetchAttempts, 2);
});

test("auto does not retry a reused cached WebSocket after an API error event", async () => {
  const fallback = await sseServer("fallback ok");
  const wss = new WebSocketServer({ noServer: true });
  servers.push(wss);
  let upgradeAttempts = 0;
  let websocketRequests = 0;
  fallback.server.on("upgrade", (request, socket, head) => {
    upgradeAttempts++;
    wss.handleUpgrade(request, socket, head, (client) => wss.emit("connection", client, request));
  });
  wss.on("connection", (socket) => {
    socket.on("message", () => {
      websocketRequests++;
      if (websocketRequests === 1) {
        completed(socket, "resp_cached", "cached answer");
        return;
      }
      socket.send(JSON.stringify({
        type: "error",
        error: { type: "invalid_request_error", code: "invalid_request", message: "cached request rejected" },
        sequence_number: 0,
      }));
    });
  });

  const provider = createOpenAIApiProvider();
  const options = {
    apiKey: "bridge-key",
    transport: "auto" as const,
    sessionId: "cached-api-error",
    // Transport-only fixture: default checkpoint mode "always" would fence the
    // post-send replay this test exercises, so durable checkpoints opt out.
    responseCheckpointExclude: ["*"],
    websocketConnectTimeoutMs: 1_000,
  };
  const first = await provider.streamSimple(
    model(fallback.baseUrl),
    { messages: [{ role: "user", content: "one", timestamp: 1 }] },
    options,
  ).result();
  const output = await provider.streamSimple(
    model(fallback.baseUrl),
    {
      messages: [
        { role: "user", content: "one", timestamp: 1 },
        first,
        { role: "user", content: "two", timestamp: 2 },
      ],
    },
    options,
  ).result();

  assert.equal(output.stopReason, "error");
  assert.equal(upgradeAttempts, 1);
  assert.equal(websocketRequests, 2, "API error cannot replay this request");
  assert.equal(fallback.requests, 0);
});

for (const started of [false, true]) {
  for (const failure of ["api", "failed", "protocol", "disconnect"] as const) {
    test(`auto accounts only transport failures: ${failure}, started=${started}`, async () => {
      const fallback = await sseServer("fallback ok");
      const wss = new WebSocketServer({ noServer: true });
      servers.push(wss);
      let frames = 0;
      let succeed = false;
      fallback.server.on("upgrade", (request, socket, head) => {
        wss.handleUpgrade(request, socket, head, (client) => wss.emit("connection", client, request));
      });
      wss.on("connection", (socket) => socket.on("message", () => {
        frames++;
        if (succeed) { completed(socket, "resp_recovered", "recovered"); return; }
        const reject = () => {
          if (failure === "disconnect") socket.terminate();
          else if (failure === "protocol") socket.send("not JSON");
          else {
            const error = { type: "invalid_request_error", code: "invalid_request", message: "request rejected" };
            socket.send(JSON.stringify(failure === "api" ? { type: "error", error }
              : { type: "response.failed", response: { id: "resp_failed", error } }));
          }
        };
        if (started) socket.send(JSON.stringify({ type: "response.created", response: { id: "resp_started" } }), reject);
        else reject();
      }));
      const provider = createOpenAIApiProvider();
      const request = () => provider.streamSimple(model(fallback.baseUrl),
        { messages: [{ role: "user", content: "ping", timestamp: 1 }] },
        { apiKey: "bridge-key", transport: "auto", sessionId: `provenance-${failure}-${started}`,
          responseCheckpointExclude: ["*"], maxRetries: 0, timeoutMs: 100 }).result();
      const reasons = [];
      for (let i = 0; i < 4; i++) reasons.push((await request()).stopReason);
      assert.equal(frames, 4);
      if (failure === "disconnect") {
        assert.deepEqual(reasons, started ? ["error", "error", "error", "error"] : ["error", "error", "error", "stop"]);
        assert.equal(fallback.requests, started ? 0 : 1, "never replay a started response");
        assert.equal((await request()).stopReason, "stop");
        assert.equal(frames, 4, "real disconnects exhaust transport budget");
      } else {
        assert.deepEqual(reasons, ["error", "error", "error", "error"]);
        assert.equal(fallback.requests, 0, "API/protocol failures never open transport cooldown");
        succeed = true;
        assert.equal((await request()).stopReason, "stop");
        assert.equal(frames, 5, "next valid request still uses WS");
        assert.equal(fallback.requests, 0);
      }
    });
  }
}

for (const transport of [undefined, "auto", "websocket", "websocket-cached"] as const) {
  for (const repeated of [false, true]) {
    test(`connection limit retries once on fresh WS: ${transport ?? "default"}, repeated=${repeated}`, async () => {
      const requests: Array<{ body: Record<string, unknown>; connection: number }> = [];
      const upstream = await server((body, connection, socket) => {
        requests.push({ body, connection });
        if (requests.length === 1 || repeated) socket.send(JSON.stringify({ type: "error",
          error: { type: "invalid_request_error", code: "websocket_connection_limit_reached", message: "connection full" } }));
        else completed(socket, "resp_replacement", "replacement ok");
      });
      let sse = 0;
      const output = await createOpenAIApiProvider().streamSimple(model(upstream.baseUrl),
        { messages: [{ role: "user", content: "ping", timestamp: 1 }] },
        { apiKey: "bridge-key", ...(transport ? { transport } : {}), sessionId: "connection-limit",
          maxRetries: 0, fetch: async () => { sse++; throw new Error("SSE must not replay"); } }).result();
      assert.equal(requests.length, 2, "one special retry independent of maxRetries:0");
      assert.deepEqual(requests.map((request) => request.connection), [1, 2]);
      assert.deepEqual(requests[1]?.body, requests[0]?.body);
      assert.equal(output.stopReason, repeated ? "error" : "stop", output.errorMessage);
      assert.equal(sse, 0);
    });
  }
}

for (const envelope of ["nested", "top-level", "response.failed"] as const) {
  test(`repeated connection limits enter transport cooldown: ${envelope}`, async () => {
    let frames = 0;
    let sse = 0;
    const upstream = await server((_body, _connection, socket) => {
      frames++;
      const error = { code: "websocket_connection_limit_reached", message: "connection full" };
      socket.send(JSON.stringify(envelope === "response.failed" ? { type: envelope, response: { error } }
        : envelope === "top-level" ? { type: "error", ...error } : { type: "error", error }));
    });
    const provider = createOpenAIApiProvider();
    const request = () => provider.streamSimple(model(upstream.baseUrl),
      { messages: [{ role: "user", content: "ping", timestamp: 1 }] },
      { apiKey: "bridge-key", transport: "auto", sessionId: `limit-${envelope}`, maxRetries: 0,
        fetch: async () => {
          sse++;
          return new Response(responseEvents("resp_sse", "fallback ok")
            .map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
          { headers: { "content-type": "text/event-stream" } });
        } }).result();
    for (let i = 0; i < 3; i++) {
      assert.equal((await request()).stopReason, "error");
      assert.equal(frames, (i + 1) * 2);
      assert.equal(sse, 0);
    }
    assert.equal((await request()).stopReason, "stop");
    assert.equal(frames, 8, "one fresh retry per default-durable request at maxRetries:0");
    assert.equal(upstream.connections, 8);
    assert.equal(sse, 1, "fourth repeated limit selects SSE");
    assert.equal((await request()).stopReason, "stop");
    assert.equal(frames, 8, "following request stays SSE during cooldown");
    assert.equal(sse, 2);
  });
}

test("connection limits keep one fresh retry across provider retries", async () => {
  let frames = 0;
  let sse = 0;
  const upstream = await server((_body, _connection, socket) => {
    frames++;
    socket.send(JSON.stringify({ type: "error",
      error: { code: "websocket_connection_limit_reached", message: "connection full" } }));
  });
  const provider = createOpenAIApiProvider();
  const request = () => provider.streamSimple(model(upstream.baseUrl),
    { messages: [{ role: "user", content: "ping", timestamp: 1 }] },
    { apiKey: "bridge-key", transport: "auto", sessionId: "limit-provider-retries", maxRetries: 2,
      fetch: async () => {
        sse++;
        return new Response(responseEvents("resp_sse", "fallback ok")
          .map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
        { headers: { "content-type": "text/event-stream" } });
      } }).result();
  assert.equal((await request()).stopReason, "error");
  assert.equal(frames, 4, "two initial frames, then one frame per provider retry");
  assert.equal(sse, 0, "three accounted failures do not select SSE");
  assert.equal((await request()).stopReason, "stop");
  assert.equal(frames, 6, "next logical request has its own single fresh retry");
  assert.equal(sse, 1, "fourth accounted failure selects SSE");
});

test("connection limit after consumed durable reference repair stays terminal", async () => {
  let frames = 0;
  let sse = 0;
  const upstream = await server((_body, _connection, socket) => {
    frames++;
    const code = frames === 1 ? "previous_response_not_found" : "websocket_connection_limit_reached";
    socket.send(JSON.stringify({ type: "error", error: { code, message: "request rejected" } }));
  });
  const output = await createOpenAIApiProvider().streamSimple(model(upstream.baseUrl),
    { messages: [{ role: "user", content: "ping", timestamp: 1 }] },
    { apiKey: "bridge-key", transport: "auto", sessionId: "limit-consumed-repair", maxRetries: 2,
      fetch: async () => { sse++; throw new Error("SSE must not replay"); } }).result();
  assert.equal(output.stopReason, "error");
  assert.equal(frames, 2, "consumed repair cannot gain a limit retry or provider replay");
  assert.equal(sse, 0);
});

test("sessionless auto falls back after one fresh connection-limit retry", async () => {
  let frames = 0;
  let sse = 0;
  const upstream = await server((_body, _connection, socket) => {
    frames++;
    socket.send(JSON.stringify({ type: "error",
      error: { code: "websocket_connection_limit_reached", message: "connection full" } }));
  });
  const output = await createOpenAIApiProvider().streamSimple(model(upstream.baseUrl),
    { messages: [{ role: "user", content: "ping", timestamp: 1 }] },
    { apiKey: "bridge-key", transport: "auto", maxRetries: 0, fetch: async () => {
      sse++;
      return new Response(responseEvents("resp_sse", "fallback ok")
        .map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
      { headers: { "content-type": "text/event-stream" } });
    } }).result();
  assert.equal(output.stopReason, "stop", output.errorMessage);
  assert.equal(frames, 2);
  assert.equal(upstream.connections, 2);
  assert.equal(sse, 1);
});

for (const maxRetries of [0, 2]) {
  test(`connection limit retries checkpoint-excluded caller parent unchanged: maxRetries=${maxRetries}`, async () => {
    const requests: Array<Record<string, unknown>> = [];
    let sse = 0;
    const upstream = await server((body, _connection, socket) => {
      requests.push(body);
      if (requests.length === 1) socket.send(JSON.stringify({ type: "error",
        error: { code: "websocket_connection_limit_reached", message: "connection full" } }));
      else completed(socket, "resp_replacement", "replacement ok");
    });
    const output = await createOpenAIApiProvider().streamSimple(model(upstream.baseUrl),
      { messages: [{ role: "user", content: "ping", timestamp: 1 }] },
      { apiKey: "bridge-key", transport: "auto", sessionId: `limit-caller-optout-${maxRetries}`, maxRetries,
        responseCheckpointExclude: ["*"],
        onPayload: (payload) => ({ ...payload as object, previous_response_id: "caller-parent" }),
        fetch: async () => { sse++; throw new Error("SSE must not replay"); } }).result();
    assert.equal(output.stopReason, "stop", output.errorMessage);
    assert.equal(requests.length, 2);
    assert.equal(upstream.connections, 2);
    assert.equal(requests[0]?.previous_response_id, "caller-parent");
    assert.deepEqual(requests[1], requests[0], "opt-out preserves original parent and params");
    assert.equal(sse, 0);
  });
}

test("connection limit does not retry a durable caller-owned parent or a started response", async () => {
  for (const started of [false, true]) {
    let frames = 0;
    const upstream = await server((_body, _connection, socket) => {
      frames++;
      if (started) socket.send(JSON.stringify({ type: "response.created", response: { id: "resp_started" } }));
      socket.send(JSON.stringify({ type: "error",
        error: { code: "websocket_connection_limit_reached", message: "connection full" } }));
    });
    const output = await createOpenAIApiProvider().streamSimple(model(upstream.baseUrl),
      { messages: [{ role: "user", content: "ping", timestamp: 1 }] },
      { apiKey: "bridge-key", transport: "auto", sessionId: `limit-fenced-${started}`, maxRetries: 0,
        ...(!started ? { onPayload: (payload) => ({ ...payload as object, previous_response_id: "caller-parent" }) } : {}) }).result();
    assert.equal(output.stopReason, "error");
    assert.equal(frames, 1);
  }
});

test("connection limit does not replay durable caller-rooted continuation", async () => {
  const requests: Array<Record<string, unknown>> = [];
  let sse = 0;
  const upstream = await server((body, _connection, socket) => {
    requests.push(body);
    if (requests.length === 1) completed(socket, "resp_caller", "caller answer");
    else socket.send(JSON.stringify({ type: "error",
      error: { code: "websocket_connection_limit_reached", message: "connection full" } }));
  });
  const provider = createOpenAIApiProvider();
  const options = { apiKey: "bridge-key", transport: "auto" as const, sessionId: "limit-caller-lineage", maxRetries: 2,
    fetch: async () => { sse++; throw new Error("SSE must not replay"); } };
  const firstUser: Message = { role: "user", content: "one", timestamp: 1 };
  const first = await provider.streamSimple(model(upstream.baseUrl), { messages: [firstUser] },
    { ...options, onPayload: (payload) => ({ ...payload as object, previous_response_id: "caller-parent" }) }).result();
  assert.equal(first.stopReason, "stop", first.errorMessage);
  const output = await provider.streamSimple(model(upstream.baseUrl),
    { messages: [firstUser, first, { role: "user", content: "two", timestamp: 2 }] }, options).result();
  assert.equal(output.stopReason, "error");
  assert.equal(requests.length, 2, "unknown caller history cannot gain a fresh retry or provider replay");
  assert.equal(requests[1]?.previous_response_id, "resp_caller");
  assert.equal(sse, 0);
});

test("auto never retries or falls back after the first response event", async () => {
  let websocketRequests = 0;
  let sseFallbacks = 0;
  const upstream = await server((_body, _connection, socket) => {
    websocketRequests++;
    if (websocketRequests === 1) {
      completed(socket, "resp_cached", "cached answer");
      return;
    }
    socket.send(JSON.stringify({ type: "response.created", response: { id: "resp_started" } }), () => socket.terminate());
  });
  const provider = createOpenAIApiProvider();
  const options = {
    apiKey: "bridge-key",
    fetch: async () => {
      sseFallbacks++;
      throw new Error("SSE fallback invoked");
    },
    transport: "auto" as const,
    sessionId: "post-first-event-failure",
    websocketConnectTimeoutMs: 1_000,
  };
  const first = await provider.streamSimple(
    model(upstream.baseUrl),
    { messages: [{ role: "user", content: "one", timestamp: 1 }] },
    options,
  ).result();
  const output = await provider.streamSimple(
    model(upstream.baseUrl),
    {
      messages: [
        { role: "user", content: "one", timestamp: 1 },
        first,
        { role: "user", content: "two", timestamp: 2 },
      ],
    },
    options,
  ).result();

  assert.equal(output.stopReason, "error");
  assert.equal(upstream.connections, 1);
  assert.equal(websocketRequests, 2);
  assert.equal(sseFallbacks, 0);
});

test("websocket-cached omits every prior assistant response item from delta input", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const upstream = await server((body, _connection, socket) => {
    requests.push(body);
    completed(socket, `resp_${requests.length}`, `answer ${requests.length}`);
  });
  const provider = createOpenAIApiProvider();
  // Default responseCheckpointMode is "always"; this test pins the
  // connection-local cache, so durable checkpoints opt out here.
  const base = { apiKey: "bridge-key", transport: "websocket-cached" as const, sessionId: "multi-item-cache",
    responseCheckpointExclude: ["*"] };
  const first = await provider.streamSimple(
    model(upstream.baseUrl),
    { messages: [{ role: "user", content: "one", timestamp: 1 }] },
    base,
  ).result();
  first.content.unshift({
    type: "thinking",
    thinking: "reasoning",
    thinkingSignature: JSON.stringify({ type: "reasoning", id: "rs_1", summary: [] }),
  });
  await provider.streamSimple(
    model(upstream.baseUrl),
    {
      messages: [
        { role: "user", content: "one", timestamp: 1 },
        first,
        { role: "user", content: "two", timestamp: 2 },
      ],
    },
    base,
  ).result();

  assert.equal(requests[1]?.previous_response_id, "resp_1");
  assert.deepEqual(requests[1]?.input, [{ role: "user", content: [{ type: "input_text", text: "two" }] }]);
});

test("SSE requests record the actual session-scoped transport", async () => {
  const upstream = await sseServer("sse ok");
  const sessionId = "sse-status";
  const output = await createOpenAIApiProvider().streamSimple(
    model(upstream.baseUrl),
    { messages: [{ role: "user", content: "ping", timestamp: 1 }] },
    { apiKey: "bridge-key", transport: "sse", sessionId },
  ).result();

  assert.equal(output.stopReason, "stop", output.errorMessage ?? "SSE request failed");
  assert.equal(getActualResponsesTransport(upstream.baseUrl, sessionId), "sse");
  assert.equal(getActualResponsesTransport(upstream.baseUrl, "another-session"), undefined);
});

test("explicit WebSocket transports fail closed without SSE fallback", async () => {
  const upstream = await sseServer("should not run");
  for (const transport of ["websocket", "websocket-cached"] as const) {
    const output = await createOpenAIApiProvider().streamSimple(
      model(upstream.baseUrl),
      { messages: [{ role: "user", content: "ping", timestamp: 1 }] },
      {
        apiKey: "bridge-key",
        fetch: async () => {
          throw new Error("SSE fallback invoked");
        },
        transport,
        sessionId: `explicit-failure-${transport}`,
        websocketConnectTimeoutMs: 1_000,
      },
    ).result();

    assert.equal(output.stopReason, "error");
    assert.doesNotMatch(output.errorMessage ?? "", /SSE fallback invoked/);
  }
});

test("model request errors redact an echoed API key", async () => {
  const provider = createOpenAIApiProvider();
  const requestModel = model("http://127.0.0.1:1/v1");
  for (const transport of ["sse", "auto"] as const) {
    const request = () => provider.streamSimple(
      requestModel,
      { messages: [{ role: "user", content: "ping", timestamp: 1 }] },
      {
        apiKey: "secret-key",
        fetch: async () => new Response("echo secret-key", { status: 401, headers: { "content-type": "text/plain" } }),
        transport,
        sessionId: `redaction-${transport}`,
        maxRetries: 0,
        websocketConnectTimeoutMs: 1,
      },
    ).result();
    if (transport === "auto") for (let i = 0; i < 3; i++) assert.equal((await request()).stopReason, "error");
    const output = await request();
    assert.equal(output.stopReason, "error");
    assert.doesNotMatch(output.errorMessage ?? "", /secret-key/);
    assert.match(output.errorMessage ?? "", /\[REDACTED\]/);
  }
});

test("auto allows three WS retries, steps 2/3/4/5/5 minutes and resets after WS success", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: 0 });
  const fallback = await sseServer("fallback ok");
  const wss = new WebSocketServer({ noServer: true });
  servers.push(wss);
  let websocketAvailable = false;
  let upgradeAttempts = 0;
  let connections = 0;
  fallback.server.on("upgrade", (request, socket, head) => {
    upgradeAttempts++;
    if (!websocketAvailable) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (client) => wss.emit("connection", client, request));
  });
  wss.on("connection", (socket) => {
    connections++;
    socket.on("message", () => {
      if (!websocketAvailable) socket.terminate();
      else completed(socket, `resp_recovered_${connections}`, "websocket recovered");
    });
  });

  const provider = createOpenAIApiProvider();
  const options = {
    apiKey: "bridge-key",
    transport: "auto" as const,
    sessionId: "auto-recovery",
    maxRetries: 0,
    // Transport-only fixture: default checkpoint mode "always" would fence the
    // post-send replay this test exercises, so durable checkpoints opt out.
    responseCheckpointExclude: ["*"],
    websocketConnectTimeoutMs: 1_000,
  };
  const request = (text: string) => provider.streamSimple(
    model(fallback.baseUrl),
    { messages: [{ role: "user" as const, content: text, timestamp: 1 }] },
    options,
  ).result();

  for (let i = 0; i < 3; i++) {
    assert.equal((await request("initial WS failure")).stopReason, "error");
    assert.equal(upgradeAttempts, i + 1);
    assert.equal(fallback.requests, 0, "native retry budget precedes SSE cooldown");
  }
  const first = await request("exhaust retries");
  assert.equal(first.stopReason, "stop", first.errorMessage);
  assert.equal(fallback.requests, 1);
  assert.equal(upgradeAttempts, 4);
  for (const minutes of [2, 3, 4, 5, 5]) {
    const before = upgradeAttempts;
    context.mock.timers.tick(minutes * 60_000 - 1);
    await request("during cooldown");
    assert.equal(upgradeAttempts, before, `suppressed before ${minutes}-minute deadline`);
    context.mock.timers.tick(1);
    await request("failed recovery");
    assert.equal(upgradeAttempts, before + 1, `one recovery at ${minutes}-minute deadline`);
  }
  assert.equal(fallback.requests, 11);
  websocketAvailable = true;
  context.mock.timers.tick(300_000);
  const recovered = await request("recover");
  assert.equal(recovered.stopReason, "stop", recovered.errorMessage ?? "WebSocket recovery failed");
  assert.equal(recovered.content[0]?.text, "websocket recovered");
  assert.equal(upgradeAttempts, 10);
  assert.equal(connections, 1);
  assert.equal(getActualResponsesTransport(fallback.baseUrl, options.sessionId), "websocket-cached");

  const continued = await request("continue");
  assert.equal(continued.stopReason, "stop", continued.errorMessage ?? "Cached WebSocket continuation failed");
  assert.equal(upgradeAttempts, 10);
  assert.equal(connections, 1);

  websocketAvailable = false;
  for (let i = 0; i < 3; i++) assert.equal((await request("failure after reset")).stopReason, "error");
  assert.equal(fallback.requests, 11);
  assert.equal((await request("exhaust reset budget")).stopReason, "stop");
  assert.equal(fallback.requests, 12);
  const beforeRecovery = upgradeAttempts;
  websocketAvailable = true;
  context.mock.timers.tick(119_999);
  await request("reset cooldown");
  assert.equal(upgradeAttempts, beforeRecovery);
  context.mock.timers.tick(1);
  const recoveredAgain = await request("recover after reset two-minute cooldown");
  assert.equal(recoveredAgain.stopReason, "stop", recoveredAgain.errorMessage);
  assert.equal(fallback.requests, 13);
  assert.equal(upgradeAttempts, beforeRecovery + 1);
  assert.equal(connections, 2);
  assert.equal(getActualResponsesTransport(fallback.baseUrl, options.sessionId), "websocket-cached");
});

for (const failures of [1, 4]) {
  test(`auto runs one recovery probe after ${failures} failure(s) while concurrent requests stay on SSE`, async (context) => {
    context.mock.timers.enable({ apis: ["Date"], now: 0 });
    const fallback = await sseServer("fallback ok");
    const wss = new WebSocketServer({ noServer: true });
    servers.push(wss);
    let websocketAvailable = false;
    let upgradeAttempts = 0;
    let markProbeStarted = () => {};
    let releaseProbe = () => {};
    const probeStarted = new Promise<void>((resolve) => { markProbeStarted = resolve; });
    const probeReleased = new Promise<void>((resolve) => { releaseProbe = resolve; });
    fallback.server.on("upgrade", (request, socket, head) => {
      upgradeAttempts++;
      if (!websocketAvailable) {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(request, socket, head, (client) => wss.emit("connection", client, request));
    });
    wss.on("connection", (socket) => {
      socket.on("message", async () => {
        socket.send(JSON.stringify({ type: "response.created", response: { id: "resp_recovered" } }));
        await probeReleased;
        for (const event of responseEvents("resp_recovered", "websocket recovered").slice(1)) socket.send(JSON.stringify(event));
      });
    });

    const provider = createOpenAIApiProvider();
    const options = {
      apiKey: "bridge-key",
      transport: "auto" as const,
      sessionId: "auto-concurrent-recovery",
      maxRetries: 0,
      websocketConnectTimeoutMs: 1_000,
      onResponse: () => { if (websocketAvailable) markProbeStarted(); },
    };
    const request = (text: string) => provider.streamSimple(
      model(fallback.baseUrl),
      { messages: [{ role: "user" as const, content: text, timestamp: 1 }] },
      options,
    ).result();

    for (let i = 0; i < failures; i++) await request("failure");
    if (failures === 4) context.mock.timers.tick(120_000);
    websocketAvailable = true;

    const recovery = request("recover");
    await probeStarted;
    const concurrent = await request("concurrent");
    assert.equal(concurrent.stopReason, "stop", concurrent.errorMessage ?? "Concurrent SSE fallback failed");
    assert.equal(fallback.requests, failures === 4 ? 2 : 1);
    assert.equal(upgradeAttempts, failures + 1);
    assert.equal(getActualResponsesTransport(fallback.baseUrl, options.sessionId), "sse");

    releaseProbe();
    const recovered = await recovery;
    assert.equal(recovered.stopReason, "stop", recovered.errorMessage ?? "WebSocket recovery failed");
    assert.equal(recovered.content[0]?.type, "text");
    assert.equal(recovered.content[0]?.text, "websocket recovered");
    assert.equal(upgradeAttempts, failures + 1);
    // The concurrent SSE request was the last transport started.
    assert.equal(getActualResponsesTransport(fallback.baseUrl, options.sessionId), "sse");
  });
}

for (const outcome of ["error", "aborted"] as const) {
  test(`auto recovery ${outcome} after streaming starts preserves failure history without replay`, async (context) => {
    context.mock.timers.enable({ apis: ["Date"], now: 0 });
    const fallback = await sseServer("fallback ok");
    const wss = new WebSocketServer({ noServer: true });
    servers.push(wss);
    let upgradeAttempts = 0;
    let interrupt: (() => void) | undefined;
    fallback.server.on("upgrade", (request, socket, head) => {
      upgradeAttempts++;
      if (upgradeAttempts <= 4) socket.destroy();
      else wss.handleUpgrade(request, socket, head, (client) => wss.emit("connection", client, request));
    });
    const controller = new AbortController();
    wss.on("connection", (socket) => {
      socket.on("message", () => {
        if (upgradeAttempts === 5) {
          interrupt = () => outcome === "aborted" ? controller.abort() : socket.terminate();
          socket.send(JSON.stringify({ type: "response.created", response: { id: "resp_partial" } }));
        } else completed(socket, "resp_recovered", "websocket recovered");
      });
    });
    const provider = createOpenAIApiProvider();
    const options = {
      apiKey: "bridge-key",
      transport: "auto" as const,
      sessionId: `recovery-${outcome}`,
      maxRetries: 0,
      websocketConnectTimeoutMs: 1_000,
    };
    // Exercise the full stream entry point too, not only streamSimple.
    const request = (recover = false) => provider.stream(
      model(fallback.baseUrl),
      { messages: [{ role: "user", content: "ping", timestamp: 1 }] },
      { ...options, ...(recover ? { signal: controller.signal, onResponse: () => interrupt?.() } : {}) },
    ).result();
    for (let i = 0; i < 4; i++) await request();
    context.mock.timers.tick(120_000);
    const interrupted = await request(true);
    assert.equal(interrupted.stopReason, outcome, interrupted.errorMessage);
    assert.equal(upgradeAttempts, 5);
    assert.equal(fallback.requests, 1, "never replay after the first event");
    if (outcome === "error") {
      await request();
      assert.equal(upgradeAttempts, 5, "partial response must not reset the failure sequence");
      assert.equal(fallback.requests, 2);
      context.mock.timers.tick(180_000);
    }
    const recovered = await request();
    assert.equal(recovered.stopReason, "stop", recovered.errorMessage);
    assert.equal(recovered.content[0]?.text, "websocket recovered");
    assert.equal(upgradeAttempts, 6, "aborted probe must release its slot without adding a cooldown");
  });
}

test("real provider reconnect uses confirmed memory anchor without persisted checkpoint metadata", async () => {
  const requests: Array<{ body: Record<string, unknown>; connection: number }> = [];
  let firstSocket: import("ws").WebSocket;
  const upstream = await server((body, connection, socket) => {
    firstSocket ??= socket;
    requests.push({ body, connection });
    for (const event of responseEvents(`resp_memory_${requests.length}`, "stored answer")) {
      if (event.type === "response.completed") (event.response as any).store = true;
      socket.send(JSON.stringify(event));
    }
  });
  const provider = createOpenAIApiProvider();
  const labels: string[] = [];
  const options = { apiKey: "bridge-key", transport: "websocket-cached" as const, sessionId: "stored-memory",
    onTransport: (label: string) => { labels.push(label); } };
  const one = { role: "user" as const, content: "one", timestamp: 1 };
  const first = await provider.streamSimple(model(upstream.baseUrl), { messages: [one] }, options).result();
  assert.equal(first.stopReason, "stop", first.errorMessage);
  const { responseCheckpoint: _checkpoint, ...withoutCheckpoint } = first as typeof first & { responseCheckpoint?: unknown };
  await new Promise<void>((resolve) => { firstSocket.once("close", () => resolve()); firstSocket.close(1000, "idle timeout"); });
  const second = await provider.streamSimple(model(upstream.baseUrl), {
    messages: [one, withoutCheckpoint, { role: "user", content: "two", timestamp: 2 }],
  }, options).result();
  assert.equal(second.stopReason, "stop", second.errorMessage);
  assert.equal(upstream.connections, 2);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].body.previous_response_id, first.responseId);
  assert.deepEqual(requests[1].body.input, [{ role: "user", content: [{ type: "input_text", text: "two" }] }]);
  assert.deepEqual(labels, ["WS/full", "WS/continuation"]);
});

test("late WS success resets progression but only transport owner clears active deadline", { timeout: 10_000 }, async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: 0 });
  const fallback = await sseServer("fallback ok");
  const wss = new WebSocketServer({ noServer: true }); servers.push(wss);
  let upgrades = 0;
  let oldSocket!: import("ws").WebSocket;
  let probeSocket!: import("ws").WebSocket;
  let markOld!: () => void;
  let markProbe!: () => void;
  const oldSeen = new Promise<void>((resolve) => { markOld = resolve; });
  const probeSeen = new Promise<void>((resolve) => { markProbe = resolve; });
  fallback.server.on("upgrade", (request, socket, head) => {
    upgrades++;
    if (upgrades >= 2 && upgrades <= 5) { socket.destroy(); return; }
    wss.handleUpgrade(request, socket, head, (client) => wss.emit("connection", client, request));
  });
  wss.on("connection", (socket) => socket.on("message", () => {
    if (upgrades === 1) {
      oldSocket = socket;
      socket.send(JSON.stringify(responseEvents("resp_old", "ok")[0])); markOld();
    } else if (upgrades === 6) {
      probeSocket = socket;
      socket.send(JSON.stringify(responseEvents("resp_probe", "ok")[0])); markProbe();
    } else completed(socket, "resp_recovered", "ok");
  }));
  const provider = createOpenAIApiProvider();
  context.after(() => { for (const socket of wss.clients) socket.terminate(); });
  const options = { apiKey: "key", transport: "auto" as const, sessionId: "late-transport-owner",
    responseCheckpointExclude: ["*"], maxRetries: 0, websocketConnectTimeoutMs: 1_000 };
  const ask = () => provider.streamSimple(model(fallback.baseUrl),
    { messages: [{ role: "user", content: "one", timestamp: 1 }] }, options).result();
  const old = ask(); await oldSeen;
  for (let i = 0; i < 3; i++) assert.equal((await ask()).stopReason, "error");
  assert.equal((await ask()).stopReason, "stop");
  context.mock.timers.tick(120_000);
  const probe = ask(); await probeSeen;
  for (const event of responseEvents("resp_old", "ok").slice(1)) oldSocket.send(JSON.stringify(event));
  assert.equal((await old).stopReason, "stop");
  await ask();
  assert.equal(upgrades, 6, "non-owner success must not clear in-flight transport recovery");
  probeSocket.terminate();
  assert.equal((await probe).stopReason, "error");
  context.mock.timers.tick(119_999);
  await ask(); assert.equal(upgrades, 6, "late success reset next duration to two minutes");
  context.mock.timers.tick(1);
  assert.equal((await ask()).stopReason, "stop");
  assert.equal(upgrades, 7);
  assert.equal(fallback.requests, 3, "started probe was never replayed over HTTP");
});
