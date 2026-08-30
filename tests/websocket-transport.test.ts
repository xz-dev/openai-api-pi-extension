import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createServer, type Server } from "node:http";
import { WebSocketServer } from "ws";
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
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, get requests() { return requests; } };
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

test("websocket-cached omits every prior assistant response item from delta input", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const upstream = await server((body, _connection, socket) => {
    requests.push(body);
    completed(socket, `resp_${requests.length}`, `answer ${requests.length}`);
  });
  const provider = createOpenAIApiProvider();
  const first = await provider.streamSimple(
    model(upstream.baseUrl),
    { messages: [{ role: "user", content: "one", timestamp: 1 }] },
    { apiKey: "bridge-key", transport: "websocket-cached", sessionId: "multi-item-cache" },
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
    { apiKey: "bridge-key", transport: "websocket-cached", sessionId: "multi-item-cache" },
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

test("explicit websocket failure does not silently fall back to SSE", async () => {
  const upstream = await sseServer("should not run");
  const output = await createOpenAIApiProvider().streamSimple(
    model(upstream.baseUrl),
    { messages: [{ role: "user", content: "ping", timestamp: 1 }] },
    {
      apiKey: "bridge-key",
      fetch: async () => {
        throw new Error("SSE fallback invoked");
      },
      transport: "websocket",
      sessionId: "explicit-failure",
      websocketConnectTimeoutMs: 1_000,
    },
  ).result();

  assert.equal(output.stopReason, "error");
  assert.doesNotMatch(output.errorMessage ?? "", /SSE fallback invoked/);
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

test("auto falls back to SSE only when websocket fails before its first event", async () => {
  const upstream = await sseServer("fallback ok");
  const output = await createOpenAIApiProvider().streamSimple(
    model(upstream.baseUrl),
    { messages: [{ role: "user", content: "ping", timestamp: 1 }] },
    { apiKey: "bridge-key", transport: "auto", sessionId: "auto-fallback", websocketConnectTimeoutMs: 1_000 },
  ).result();

  assert.equal(output.stopReason, "stop", output.errorMessage ?? "SSE fallback failed");
  assert.equal(output.content[0]?.type, "text");
  assert.equal(output.content[0]?.text, "fallback ok");
  assert.equal(upstream.requests, 2);
});
