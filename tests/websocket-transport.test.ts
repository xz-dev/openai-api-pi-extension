import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createServer, type Server } from "node:http";
import { WebSocketServer } from "ws";
import type { Message } from "@earendil-works/pi-ai";
import { createOpenAIApiProvider } from "../index.ts";
import { closeResponsesWebSockets, getActualResponsesTransport } from "../responses-websocket-fetch.ts";

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

test("auto falls back on cached failure and recovers with full context on the next request", async () => {
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
  assert.equal(fallback.stopReason, "stop", fallback.errorMessage);
  assert.equal(fallback.content[0]?.text, "fallback ok");
  assert.equal(sseFallbacks, 1);
  assert.equal(upstream.connections, 1);
  assert.equal(requests.length, 2);

  const recovered = await provider.streamSimple(
    model(upstream.baseUrl),
    { messages: [...messages, fallback, { role: "user", content: "three", timestamp: 3 }] },
    options,
  ).result();

  assert.equal(recovered.stopReason, "stop", recovered.errorMessage ?? "Fresh WebSocket recovery failed");
  assert.equal(recovered.content[0]?.text, "fresh recovery");
  assert.equal(sseFallbacks, 1);
  assert.equal(upstream.connections, 2);
  assert.equal(requests.length, 3);
  assert.equal(requests[1]?.connection, 1);
  assert.equal(requests[1]?.body.previous_response_id, "resp_cached");
  assert.deepEqual(requests[1]?.body.input, [{ role: "user", content: [{ type: "input_text", text: "two" }] }]);
  assert.equal(requests[2]?.connection, 2);
  assert.equal(requests[2]?.body.previous_response_id, undefined);
  const freshInput = requests[2]?.body.input;
  assert.ok(Array.isArray(freshInput));
  assert.ok(freshInput.length > 1);
  assert.equal((freshInput[0] as { role?: unknown }).role, "user");
  assert.deepEqual(freshInput.at(-1), { role: "user", content: [{ type: "input_text", text: "three" }] });
});

test("auto cools down only after the next-request fresh WebSocket also fails", async (context) => {
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

  assert.equal(fallbackOutput.stopReason, "stop", fallbackOutput.errorMessage ?? "SSE fallback failed");
  assert.equal(fallbackOutput.content[0]?.type, "text");
  assert.equal(fallbackOutput.content[0]?.text, "fallback ok");
  assert.equal(upgradeAttempts, 1);
  assert.equal(connections, 1);
  assert.equal(websocketRequests, 2);
  assert.equal(fallback.requests, 1);
  assert.equal(getActualResponsesTransport(fallback.baseUrl, options.sessionId), "sse");

  await provider.streamSimple(
    model(fallback.baseUrl),
    { messages: [{ role: "user", content: "fresh retry", timestamp: 3 }] },
    options,
  ).result();
  assert.equal(upgradeAttempts, 2);
  assert.equal(connections, 2);
  assert.equal(websocketRequests, 3);
  assert.equal(fallback.requests, 2);

  await provider.streamSimple(
    model(fallback.baseUrl),
    { messages: [{ role: "user", content: "during cooldown", timestamp: 4 }] },
    options,
  ).result();
  assert.equal(upgradeAttempts, 2);
  assert.equal(fallback.requests, 3);
});

test("auto keeps provider retries on SSE and reserves fresh WebSocket recovery for the next request", async () => {
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
  const request = () => provider.streamSimple(
    model(fallback.baseUrl),
    { messages: [{ role: "user", content: "ping", timestamp: 1 }] },
    options,
  ).result();

  const first = await request();
  assert.equal(first.stopReason, "stop", first.errorMessage);
  assert.equal(first.content[0]?.text, "fallback ok");
  assert.equal(fetchAttempts, 2, "Pi still retries a retryable SSE response");
  assert.equal(upgradeAttempts, 1, "provider retry must remain SSE within the same logical request");
  assert.equal(fallback.requests, 1);

  websocketAvailable = true;
  const recovered = await request();
  assert.equal(recovered.stopReason, "stop", recovered.errorMessage);
  assert.equal(recovered.content[0]?.text, "websocket recovered");
  assert.equal(upgradeAttempts, 2, "only the next real request may probe a fresh WebSocket");
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

  assert.equal(output.stopReason, "stop", output.errorMessage ?? "SSE fallback failed");
  assert.equal(output.content[0]?.type, "text");
  assert.equal(output.content[0]?.text, "fallback ok");
  assert.equal(upgradeAttempts, 1);
  assert.equal(websocketRequests, 2);
  assert.equal(fallback.requests, 1);
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
  const requestModel = model("https://gateway.example/v1");
  for (const transport of ["sse", "auto"] as const) {
    const output = await provider.streamSimple(
      requestModel,
      { messages: [{ role: "user", content: "ping", timestamp: 1 }] },
      {
        apiKey: "secret-key",
        fetch: async () => new Response("echo secret-key", { status: 401, headers: { "content-type": "text/plain" } }),
        transport,
        sessionId: `redaction-${transport}`,
        websocketConnectTimeoutMs: 1,
      },
    ).result();
    assert.equal(output.stopReason, "error");
    assert.doesNotMatch(output.errorMessage ?? "", /secret-key/);
    assert.match(output.errorMessage ?? "", /\[REDACTED\]/);
  }
});

test("auto retries after each 5-minute cooldown and resets failures after WebSocket success", async (context) => {
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

  const first = await request("first");
  assert.equal(first.stopReason, "stop", first.errorMessage ?? "SSE fallback failed");
  assert.equal(fallback.requests, 1);
  assert.equal(upgradeAttempts, 1);

  await request("immediate fresh retry");
  assert.equal(fallback.requests, 2);
  assert.equal(upgradeAttempts, 2);

  context.mock.timers.tick(299_999);
  await request("during cooldown");
  assert.equal(fallback.requests, 3);
  assert.equal(upgradeAttempts, 2);

  context.mock.timers.tick(1);
  await request("failed retry");
  assert.equal(fallback.requests, 4);
  assert.equal(upgradeAttempts, 3);

  websocketAvailable = true;
  await request("new cooldown");
  assert.equal(fallback.requests, 5);
  assert.equal(upgradeAttempts, 3);
  assert.equal(connections, 0);

  context.mock.timers.tick(300_000);
  const recovered = await request("recover");
  assert.equal(recovered.stopReason, "stop", recovered.errorMessage ?? "WebSocket recovery failed");
  assert.equal(recovered.content[0]?.text, "websocket recovered");
  assert.equal(upgradeAttempts, 4);
  assert.equal(connections, 1);
  assert.equal(getActualResponsesTransport(fallback.baseUrl, options.sessionId), "websocket-cached");

  const continued = await request("continue");
  assert.equal(continued.stopReason, "stop", continued.errorMessage ?? "Cached WebSocket continuation failed");
  assert.equal(upgradeAttempts, 4);
  assert.equal(connections, 1);

  websocketAvailable = false;
  await request("cached connection fails again");
  assert.equal(fallback.requests, 6);
  assert.equal(upgradeAttempts, 4);
  assert.equal(getActualResponsesTransport(fallback.baseUrl, options.sessionId), "sse");

  websocketAvailable = true;
  const recoveredAgain = await request("recover immediately after reset");
  assert.equal(recoveredAgain.stopReason, "stop", recoveredAgain.errorMessage ?? "Second WebSocket recovery failed");
  assert.equal(fallback.requests, 6);
  assert.equal(upgradeAttempts, 5);
  assert.equal(connections, 2);
  assert.equal(getActualResponsesTransport(fallback.baseUrl, options.sessionId), "websocket-cached");
});

for (const failures of [1, 2]) {
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
      websocketConnectTimeoutMs: 1_000,
      onResponse: () => { if (websocketAvailable) markProbeStarted(); },
    };
    const request = (text: string) => provider.streamSimple(
      model(fallback.baseUrl),
      { messages: [{ role: "user" as const, content: text, timestamp: 1 }] },
      options,
    ).result();

    for (let i = 0; i < failures; i++) await request("failure");
    if (failures === 2) context.mock.timers.tick(300_000);
    websocketAvailable = true;

    const recovery = request("recover");
    await probeStarted;
    const concurrent = await request("concurrent");
    assert.equal(concurrent.stopReason, "stop", concurrent.errorMessage ?? "Concurrent SSE fallback failed");
    assert.equal(fallback.requests, failures + 1);
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
      if (upgradeAttempts === 1) socket.destroy();
      else wss.handleUpgrade(request, socket, head, (client) => wss.emit("connection", client, request));
    });
    const controller = new AbortController();
    wss.on("connection", (socket) => {
      socket.on("message", () => {
        if (upgradeAttempts === 2) {
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
      websocketConnectTimeoutMs: 1_000,
    };
    // Exercise the full stream entry point too, not only streamSimple.
    const request = (recover = false) => provider.stream(
      model(fallback.baseUrl),
      { messages: [{ role: "user", content: "ping", timestamp: 1 }] },
      { ...options, ...(recover ? { signal: controller.signal, onResponse: () => interrupt?.() } : {}) },
    ).result();
    await request();
    const interrupted = await request(true);
    assert.equal(interrupted.stopReason, outcome, interrupted.errorMessage);
    assert.equal(upgradeAttempts, 2);
    assert.equal(fallback.requests, 1, "never replay after the first event");
    if (outcome === "error") {
      await request();
      assert.equal(upgradeAttempts, 2, "partial response must not reset the failure sequence");
      assert.equal(fallback.requests, 2);
      context.mock.timers.tick(300_000);
    }
    const recovered = await request();
    assert.equal(recovered.stopReason, "stop", recovered.errorMessage);
    assert.equal(recovered.content[0]?.text, "websocket recovered");
    assert.equal(upgradeAttempts, 3, "aborted probe must release its slot without adding a cooldown");
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
