import assert from "node:assert/strict";
import { createServer } from "node:http";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { WebSocketServer } from "ws";
import { closeResponsesWebSockets } from "../src/responses-websocket-fetch.ts";
import { host } from "./fixtures/response-replay-host.ts";
import { readJsonBody } from "./fixtures/wire-decode.ts";

// Same built-in fixture interception used by production-codec.test.ts, not a runtime loader.
const source = new URL("../index.ts", import.meta.url).href;
const fixture = new URL("./fixtures/response-replay-host.ts", import.meta.url).href;
const hook = registerHooks({ resolve(specifier, context, next) {
  if (specifier === "@earendil-works/pi-ai/compat" && context.parentURL === source) return { url: fixture, shortCircuit: true };
  return next(specifier, context);
} });
const { createOpenAIApiProvider } = await import("../index.ts");
hook.deregister();

// Wire events carry sequence_number like real Responses streams; a native replay owner validates the cursor.
function events() {
  const item = { id: "msg_replay", type: "message", role: "assistant", status: "completed",
    content: [{ type: "output_text", text: "ok", annotations: [] }] };
  return [
    { type: "response.created", response: { id: "resp_replay" } },
    { type: "response.output_item.added", output_index: 0, item },
    { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "ok" },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: "resp_replay", status: "completed", output: [item],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
  ].map((event, sequence_number) => ({ ...event, sequence_number }));
}

for (const method of ["stream", "streamSimple"] as const) {
  for (const capability of [undefined, true]) {
    for (const transport of ["sse", "auto", "websocket", "websocket-cached"] as const) {
      test(`${method}/${transport}, host=${capability === true ? "advertised" : "stock"}: one recovery owner, no wire option`, async (t) => {
        host.capability = capability;
        host.calls = [];
        const frames: Record<string, unknown>[] = [];
        const prepared: Request[] = [];
        let httpPosts = 0;
        let wsConnections = 0;
        const server = createServer(async (request, response) => {
          assert.equal(request.method, "POST");
          httpPosts++;
          frames.push(await readJsonBody(request));
          assert.equal(request.headers["x-plugin-owner"], "same");
          assert.ok(Object.keys(request.headers).every((name) => !name.includes("responsereplay")));
          response.writeHead(200, { "content-type": "text/event-stream" });
          for (const event of events()) response.write(`data: ${JSON.stringify(event)}\n\n`);
          response.end("data: [DONE]\n\n");
        });
        const wss = new WebSocketServer({ server });
        wss.on("connection", (socket) => {
          wsConnections++;
          socket.on("message", (raw) => {
            frames.push(JSON.parse(String(raw)));
            for (const event of events()) socket.send(JSON.stringify(event));
          });
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        t.after(async () => {
          closeResponsesWebSockets();
          for (const socket of wss.clients) socket.terminate();
          await new Promise<void>((resolve) => wss.close(() => resolve()));
          await new Promise<void>((resolve) => server.close(() => resolve()));
        });
        const address = server.address();
        assert.ok(address && typeof address === "object");
        const model = { id: "mock-replay", name: "Mock", provider: "openai-api-extension", api: "openai-responses" as const,
          baseUrl: `http://127.0.0.1:${address.port}/v1`, reasoning: false, input: ["text"] as ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024 };
        const selected = capability === true && transport === "sse";
        const output = await createOpenAIApiProvider()[method](model,
          { messages: [{ role: "user", content: "one", timestamp: 1 }] }, {
            apiKey: "dummy-replay-key", maxRetries: 0, transport, sessionId: `${method}-${transport}-${capability}`,
            headers: { "x-plugin-owner": "same" }, responseReplay: !selected,
            onPayload: async (payload: unknown, _model: unknown, prepareRequest?: (payload: unknown) => Promise<Request>) => {
              assert.ok(payload && typeof payload === "object");
              const body = { ...payload, background: true, store: false, custom_field: { kept: true } };
              if (prepareRequest) prepared.push(await prepareRequest(body));
              return body;
            },
          }).result();
        assert.equal(output.stopReason, "stop", output.errorMessage);
        const calls = host.calls.filter((call) => call.options?.apiKey === "dummy-replay-key");
        assert.equal(calls.length, 1, "checkpoint encoding preparations are not generation calls");
        assert.equal(calls[0].method, method);
        assert.equal(calls[0].options?.transport, "sse");
        assert.equal(calls[0].options?.responseReplay, selected, "outer transport and host capability own native recovery, not caller flag");
        assert.equal(frames.length, 1);
        assert.equal(frames[0].background, true);
        assert.equal(frames[0].store, false);
        assert.deepEqual(frames[0].custom_field, { kept: true });
        assert.equal(Object.hasOwn(frames[0], "responseReplay"), false);
        assert.equal(httpPosts, transport === "sse" ? 1 : 0);
        assert.equal(wsConnections, transport === "sse" ? 0 : 1);
        for (const request of prepared) {
          assert.equal(Object.hasOwn(await request.json(), "responseReplay"), false);
          assert.ok([...request.headers.keys()].every((name) => !name.includes("responsereplay")));
        }
        const notices = output.diagnostics?.filter((entry) => entry.type === "provider_response_replay_passthrough") ?? [];
        assert.equal(notices.length, selected ? 0 : 1);
        if (!selected) assert.deepEqual(notices[0].details, {
          reason: capability === true ? "bridge_owns_transport" : "host_unsupported", configuredTransport: transport,
        });
        assert.notEqual(output.diagnostics?.some((entry) => entry.type === "provider_response_replay_unavailable"), true);
      });
    }
  }
}

for (const method of ["stream", "streamSimple"] as const) test(`${method}: ordinary non-background request gets no replay notice`, async () => {
  host.capability = undefined;
  host.calls = [];
  const model = { id: "ordinary", name: "Mock", provider: "openai-api-extension", api: "openai-responses" as const,
    baseUrl: "http://127.0.0.1:1/v1", reasoning: false, input: ["text"] as ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024 };
  const result = await createOpenAIApiProvider()[method](model, { messages: [{ role: "user", content: "one", timestamp: 1 }] }, {
    apiKey: "dummy-ordinary", transport: "sse", maxRetries: 0,
    onPayload: () => ({ model: "ordinary", input: [], stream: true, background: false }),
    fetch: async () => new Response(events().map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
      headers: { "content-type": "text/event-stream" },
    }),
  }).result();
  assert.equal(result.stopReason, "stop", result.errorMessage);
  assert.notEqual(result.diagnostics?.some((entry) => entry.type === "provider_response_replay_passthrough"), true);
  assert.equal(host.calls[0].options?.responseReplay, false);
});
