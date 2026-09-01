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

test("auto retries a failed reused cached connection once with a fresh full-context WebSocket", async () => {
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
      throw new Error("SSE fallback invoked");
    },
    samplingParams: { previous_response_id: "caller-provided" },
    transport: "auto" as const,
    sessionId: "cached-fresh-recovery",
    websocketConnectTimeoutMs: 1_000,
  };
  const first = await provider.streamSimple(
    model(upstream.baseUrl),
    { messages: [{ role: "user", content: "one", timestamp: 1 }] },
    options,
  ).result();
  const recovered = await provider.streamSimple(
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

  assert.equal(recovered.stopReason, "stop", recovered.errorMessage ?? "Fresh WebSocket recovery failed");
  assert.equal(recovered.content[0]?.type, "text");
  assert.equal(recovered.content[0]?.text, "fresh recovery");
  assert.equal(sseFallbacks, 0);
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
  assert.equal((freshInput[freshInput.length - 1] as { role?: unknown }).role, "user");
});

test("auto falls back to SSE after both a reused cached connection and its fresh WebSocket retry fail", async (context) => {
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
  assert.equal(upgradeAttempts, 2);
  assert.equal(connections, 2);
  assert.equal(websocketRequests, 3);
  assert.equal(fallback.requests, 1);
  assert.equal(getActualResponsesTransport(fallback.baseUrl, options.sessionId), "sse");

  await provider.streamSimple(
    model(fallback.baseUrl),
    { messages: [{ role: "user", content: "during cooldown", timestamp: 3 }] },
    options,
  ).result();
  assert.equal(upgradeAttempts, 2);
  assert.equal(fallback.requests, 2);
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

test("auto retries cached WebSocket after each fixed 15-second SSE cooldown", async (context) => {
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
    socket.on("message", () => completed(socket, `resp_recovered_${connections}`, "websocket recovered"));
  });

  const provider = createOpenAIApiProvider();
  const options = {
    apiKey: "bridge-key",
    transport: "auto" as const,
    sessionId: "auto-recovery",
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

  await request("during cooldown");
  assert.equal(fallback.requests, 2);
  assert.equal(upgradeAttempts, 1);

  context.mock.timers.tick(15_000);
  await request("failed retry");
  assert.equal(fallback.requests, 3);
  assert.equal(upgradeAttempts, 2);

  websocketAvailable = true;
  await request("new cooldown");
  assert.equal(fallback.requests, 4);
  assert.equal(upgradeAttempts, 2);
  assert.equal(connections, 0);

  context.mock.timers.tick(15_000);
  const recovered = await request("recover");
  assert.equal(recovered.stopReason, "stop", recovered.errorMessage ?? "WebSocket recovery failed");
  assert.equal(recovered.content[0]?.type, "text");
  assert.equal(recovered.content[0]?.text, "websocket recovered");
  assert.equal(upgradeAttempts, 3);
  assert.equal(connections, 1);
  assert.equal(getActualResponsesTransport(fallback.baseUrl, options.sessionId), "websocket-cached");

  const continued = await request("continue");
  assert.equal(continued.stopReason, "stop", continued.errorMessage ?? "Cached WebSocket continuation failed");
  assert.equal(upgradeAttempts, 3);
  assert.equal(connections, 1);

  closeResponsesWebSockets(options.sessionId);
  websocketAvailable = false;
  await request("fallback again");
  assert.equal(fallback.requests, 5);
  assert.equal(upgradeAttempts, 4);
  assert.equal(getActualResponsesTransport(fallback.baseUrl, options.sessionId), "sse");

  websocketAvailable = true;
  await request("second cooldown");
  assert.equal(fallback.requests, 6);
  assert.equal(upgradeAttempts, 4);

  context.mock.timers.tick(15_000);
  const recoveredAgain = await request("recover again");
  assert.equal(recoveredAgain.stopReason, "stop", recoveredAgain.errorMessage ?? "Second WebSocket recovery failed");
  assert.equal(upgradeAttempts, 5);
  assert.equal(connections, 2);
  assert.equal(getActualResponsesTransport(fallback.baseUrl, options.sessionId), "websocket-cached");
});

test("auto runs one recovery probe while concurrent requests stay on SSE", async (context) => {
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
      markProbeStarted();
      await probeReleased;
      completed(socket, "resp_recovered", "websocket recovered");
    });
  });

  const provider = createOpenAIApiProvider();
  const options = {
    apiKey: "bridge-key",
    transport: "auto" as const,
    sessionId: "auto-concurrent-recovery",
    websocketConnectTimeoutMs: 1_000,
  };
  const request = (text: string) => provider.streamSimple(
    model(fallback.baseUrl),
    { messages: [{ role: "user" as const, content: text, timestamp: 1 }] },
    options,
  ).result();

  await request("start cooldown");
  websocketAvailable = true;
  context.mock.timers.tick(15_000);

  const recovery = request("recover");
  await probeStarted;
  const concurrent = await request("concurrent");
  assert.equal(concurrent.stopReason, "stop", concurrent.errorMessage ?? "Concurrent SSE fallback failed");
  assert.equal(fallback.requests, 2);
  assert.equal(upgradeAttempts, 2);
  assert.equal(getActualResponsesTransport(fallback.baseUrl, options.sessionId), "sse");

  releaseProbe();
  const recovered = await recovery;
  assert.equal(recovered.stopReason, "stop", recovered.errorMessage ?? "WebSocket recovery failed");
  assert.equal(recovered.content[0]?.type, "text");
  assert.equal(recovered.content[0]?.text, "websocket recovered");
  assert.equal(upgradeAttempts, 2);
  assert.equal(getActualResponsesTransport(fallback.baseUrl, options.sessionId), "websocket-cached");
});
