import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { WebSocketServer } from "ws";
import { createModels, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import * as responses from "@earendil-works/pi-ai/api/openai-responses";
import { createOpenAIApiProvider } from "../index.ts";
import { closeResponsesWebSockets, getActualResponsesTransport } from "../src/responses-websocket-fetch.ts";
import { readJsonBody } from "./fixtures/wire-decode.ts";

function events(id: string) {
  const item = { id: `msg_${id}`, type: "message", role: "assistant", status: "completed",
    content: [{ type: "output_text", text: "ok", annotations: [] }] };
  return [
    { type: "response.created", response: { id } },
    { type: "response.output_item.added", output_index: 0, item },
    { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "ok" },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id, status: "completed", output: [item],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
  ];
}

for (const compressed of [false, true]) {
for (const method of ["stream", "streamSimple"] as const) {
  for (const transport of ["auto", "websocket-cached", "websocket", "sse", undefined] as const) {
    test(`SDK entry ${method}/${transport}, compression=${compressed}: bridge owns frames and actual transport`, async (t) => {
      const frames: Record<string, any>[] = [];
      let wsConnections = 0;
      let httpRequests = 0;
      let generations = 0;
      const http = createServer(async (request, response) => {
        httpRequests++;
        frames.push(await readJsonBody(request));
        response.writeHead(200, { "content-type": "text/event-stream" });
        for (const event of events(`resp_${++generations}`)) response.write(`data: ${JSON.stringify(event)}\n\n`);
        response.end("data: [DONE]\n\n");
      });
      const wss = new WebSocketServer({ server: http, perMessageDeflate: compressed });
      wss.on("connection", (socket) => {
        wsConnections++;
        socket.on("message", (raw) => {
          frames.push(JSON.parse(String(raw)));
          for (const event of events(`resp_${++generations}`)) socket.send(JSON.stringify(event));
        });
      });
      await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
      const address = http.address();
      assert.ok(address && typeof address === "object");
      const baseUrl = `http://127.0.0.1:${address.port}/v1`;
      const sessionId = `entry-${method}-${transport}`;
      t.after(async () => {
        closeResponsesWebSockets(sessionId);
        responses.closeOpenAIResponsesWebSocketSessions?.(sessionId);
        for (const client of wss.clients) client.terminate();
        await new Promise<void>((resolve) => wss.close(() => resolve()));
        await new Promise<void>((resolve) => http.close(() => resolve()));
      });
      const credentials = new InMemoryCredentialStore();
      await credentials.modify("openai-api-extension", async () => ({ type: "api_key", key: "dummy-entry-key",
        env: { OPENAI_API_EXTENSION_BASE_URL: baseUrl } }));
      const models = createModels({ credentials });
      models.setProvider(createOpenAIApiProvider());
      const model = { id: "mock-entry", name: "Mock", provider: "openai-api-extension", api: "openai-responses" as const,
        baseUrl, reasoning: false, input: ["text"] as ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000, maxTokens: 1024 };
      const notifications: Array<[string | undefined, string]> = [];
      const options = { transport, sessionId, maxRetries: 0,
        onTransport: (label: string | undefined, actualModel: typeof model) => { notifications.push([label, actualModel.id]); } };
      const firstUser = { role: "user" as const, content: "one", timestamp: 1 };
      const secondUser = { role: "user" as const, content: "two", timestamp: 2 };
      const tools = [{ name: "lookup", description: "Look up value", parameters: { type: "object", properties: {} } }];
      const first = await models[method](model, { systemPrompt: "Use tools.", tools, messages: [firstUser] }, options).result();
      assert.equal(first.stopReason, "stop", first.errorMessage);
      const second = await models[method](model, { systemPrompt: "Use tools.", tools, messages: [firstUser, first, secondUser] }, options).result();
      assert.equal(second.stopReason, "stop", second.errorMessage);
      assert.equal(first.responseId, "resp_1");
      assert.equal(second.responseId, "resp_2");
      assert.equal(frames.length, 2);
      assert.equal(generations, 2);
      const usesSse = transport === "sse";
      const cached = transport === undefined || transport === "auto" || transport === "websocket-cached";
      assert.equal(!!(first as any).responseCheckpoint, cached, "resolved default also enables checkpoint capture");
      assert.equal(httpRequests, usesSse ? 2 : 0);
      assert.equal(wsConnections, usesSse ? 0 : cached ? 1 : 2);
      const firstInput = [{ role: "system", content: "Use tools." },
        { role: "user", content: [{ type: "input_text", text: "one" }] }];
      assert.deepEqual(frames[0].input, firstInput);
      assert.equal(frames[0].tools[0].name, "lookup");
      assert.equal(frames[0].previous_response_id, undefined);
      assert.equal(frames[1].previous_response_id, cached ? "resp_1" : undefined);
      const next = { role: "user", content: [{ type: "input_text", text: "two" }] };
      if (cached) assert.deepEqual(frames[1].input, [next]);
      else assert.deepEqual(frames[1].input, [...firstInput, {
        type: "message", role: "assistant", id: "msg_resp_1", status: "completed",
        content: [{ type: "output_text", text: "ok", annotations: [] }],
      }, next]);
      assert.equal(getActualResponsesTransport(baseUrl, sessionId), usesSse ? "sse" : cached ? "websocket-cached" : "websocket");
      assert.equal(responses.getOpenAIResponsesWebSocketDebugStats?.(sessionId), undefined, "native planner/pool must stay unused");
      // Stock has no observer for explicit SSE; preserve that host behavior.
      if (!usesSse || responses.getOpenAIResponsesWebSocketDebugStats) {
        const suffix = compressed ? " DEFLATE" : "";
        assert.deepEqual(notifications, [[usesSse ? "SSE Zstd" : `WS/full${suffix}`, model.id],
          [usesSse ? "SSE Zstd" : `${cached ? "WS/continuation" : "WS/full"}${suffix}`, model.id]]);
      }
    });
  }
}
}

for (const observer of ["absent", "throw", "reject"] as const) {
  test(`direct provider preserves tools/system context with ${observer} observer`, async (t) => {
    const frames: Record<string, any>[] = [];
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise<void>((resolve) => wss.once("listening", resolve));
    t.after(async () => {
      closeResponsesWebSockets();
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    });
    wss.on("connection", (socket) => socket.on("message", (raw) => {
      frames.push(JSON.parse(String(raw)));
      for (const event of events(`resp_${frames.length}`)) socket.send(JSON.stringify(event));
    }));
    const address = wss.address();
    assert.ok(address && typeof address === "object");
    const model = { id: "mock-tools", name: "Mock", provider: "openai-api-extension", api: "openai-responses" as const,
      baseUrl: `http://127.0.0.1:${address.port}/v1`, reasoning: false, input: ["text"] as ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024 };
    let notifications = 0;
    const options = { apiKey: "dummy-tools-key", transport: "websocket-cached" as const, sessionId: `tools-${observer}`, maxRetries: 2, maxTokens: 1024,
      ...(observer === "absent" ? {} : { onTransport: (_label: string | undefined, actualModel: typeof model) => {
        notifications++;
        assert.equal(actualModel, model);
        if (observer === "reject") return Promise.reject(new Error("observer rejected"));
        throw new Error("observer threw");
      } }) };
    const provider = createOpenAIApiProvider();
    const tools = [{ name: "lookup", description: "Look up value", parameters: { type: "object", properties: { key: { type: "string" } } } }];
    const user = { role: "user" as const, content: "one", timestamp: 1 };
    const first = await provider.stream(model, { systemPrompt: "Use tools.", tools, messages: [user] }, options).result();
    assert.equal(first.stopReason, "stop", first.errorMessage);
    const second = await provider.streamSimple(model, { systemPrompt: "Use tools.", tools,
      messages: [user, first, { role: "user", content: "two", timestamp: 2 }] }, options).result();
    assert.equal(second.stopReason, "stop", second.errorMessage);
    assert.equal(frames.length, 2, "observer must never cause another inference");
    assert.equal(notifications, observer === "absent" ? 0 : 2);
    assert.equal(frames[0].tools[0].name, "lookup");
    assert.deepEqual(frames[0].tools[0].parameters, tools[0].parameters);
    assert.ok(JSON.stringify(frames[0]).includes("Use tools."), "system prompt must reach wire");
    assert.equal(frames[1].previous_response_id, "resp_1");
    assert.deepEqual(frames[1].input, [{ role: "user", content: [{ type: "input_text", text: "two" }] }]);
  });
}

test("auto reports actual SSE fallback; rejected observer cannot replay inference", async (t) => {
  let upgrades = 0;
  let generations = 0;
  const http = createServer(async (request, response) => {
    for await (const _chunk of request) { /* drain request */ }
    generations++;
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of events("resp_fallback")) response.write(`data: ${JSON.stringify(event)}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  http.on("upgrade", (_request, socket) => {
    upgrades++;
    socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    closeResponsesWebSockets();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  });
  const address = http.address();
  assert.ok(address && typeof address === "object");
  const model = { id: "mock-fallback", name: "Mock", provider: "openai-api-extension", api: "openai-responses" as const,
    baseUrl: `http://127.0.0.1:${address.port}/v1`, reasoning: false, input: ["text"] as ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024 };
  const labels: Array<string | undefined> = [];
  const provider = createOpenAIApiProvider();
  const ask = () => provider.streamSimple(model,
    { messages: [{ role: "user", content: "one", timestamp: 1 }] },
    { apiKey: "dummy-fallback-key", transport: "auto", sessionId: "fallback-observer", maxRetries: 0,
      onTransport: async (label: string | undefined, actualModel: typeof model) => {
        labels.push(label);
        assert.equal(actualModel, model);
        throw new Error("observer unavailable");
      } }).result();
  for (let i = 0; i < 3; i++) assert.equal((await ask()).stopReason, "error");
  const output = await ask();
  assert.equal(output.stopReason, "stop", output.errorMessage);
  assert.deepEqual(labels, ["SSE Zstd"]);
  assert.equal(upgrades, 4, "three native WS retries precede fallback");
  assert.equal(generations, 1);
  assert.equal(getActualResponsesTransport(model.baseUrl, "fallback-observer"), "sse");
});
