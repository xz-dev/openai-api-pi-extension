import assert from "node:assert/strict";
import { gunzipSync, zstdDecompressSync } from "node:zlib";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { afterEach, test } from "node:test";
import { WebSocketServer } from "ws";
import { createOpenAIApiProvider } from "../index.ts";
import { closeResponsesWebSockets } from "../src/responses-websocket-fetch.ts";

const servers: Array<Server | WebSocketServer> = [];

afterEach(async () => {
  closeResponsesWebSockets();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

const BIG = `compress me ${"payload ".repeat(300)}`;

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

function sseEvents(id: string) {
  const message = { id: `msg_${id}`, type: "message", role: "assistant", status: "completed",
    content: [{ type: "output_text", text: "ok", annotations: [] }] };
  return [
    { type: "response.created", response: { id } },
    { type: "response.output_item.added", output_index: 0, item: message },
    { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "ok" },
    { type: "response.output_item.done", output_index: 0, item: message },
    { type: "response.completed", response: { id, status: "completed", output: [message],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
  ];
}

function decode(request: IncomingMessage, raw: Buffer): unknown {
  const encoding = request.headers["content-encoding"];
  const bytes =
    encoding === "zstd" ? zstdDecompressSync(raw)
    : encoding === "gzip" ? gunzipSync(raw)
    : raw;
  return JSON.parse(bytes.toString("utf8"));
}

// Direct SSE path: plugin opts in to the host helper at the final wire send.
test("direct SSE request compresses the JSON body on the wire", async () => {
  const bodies: unknown[] = [];
  const encodings: Array<string | undefined> = [];
  const http = createServer(async (request, response) => {
    const raw: Buffer[] = [];
    for await (const chunk of request) raw.push(Buffer.from(chunk as Uint8Array));
    encodings.push(request.headers["content-encoding"] as string | undefined);
    bodies.push(decode(request, Buffer.concat(raw)));
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of sseEvents("resp_sse_compressed")) response.write(`data: ${JSON.stringify(event)}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  servers.push(http);
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  assert.ok(address && typeof address === "object");
  const output = await createOpenAIApiProvider().streamSimple(
    model(`http://127.0.0.1:${address.port}/v1`),
    { messages: [{ role: "user", content: BIG, timestamp: 1 }] },
    { apiKey: "compress-key", transport: "sse", sessionId: "sse-compress" },
  ).result();
  assert.equal(output.stopReason, "stop", output.errorMessage);
  assert.equal(bodies.length, 1);
  assert.equal(encodings[0], "zstd");
  assert.equal((bodies[0] as { model?: string }).model, "mock-gpt");
});

// auto -> SSE fallback path goes through the same wrapped final sender.
for (const acceptedEncoding of ["zstd", "gzip", undefined]) {
test(`auto SSE fallback labels the final upload encoding: ${acceptedEncoding ?? "identity"}`, async () => {
  const encodings: Array<string | undefined> = [];
  const labels: Array<string | undefined> = [];
  const http = createServer(async (request, response) => {
    const raw: Buffer[] = [];
    for await (const chunk of request) raw.push(Buffer.from(chunk as Uint8Array));
    encodings.push(request.headers["content-encoding"] as string | undefined);
    if (request.headers["content-encoding"] !== acceptedEncoding) {
      response.writeHead(415, { "accept-encoding": acceptedEncoding ?? "identity" }).end();
      return;
    }
    decode(request, Buffer.concat(raw)); // must parse cleanly after decode
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of sseEvents("resp_fallback_compressed")) response.write(`data: ${JSON.stringify(event)}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  // Fail before admission: an admitted durable request must not replay over SSE.
  http.on("upgrade", (_request, socket) => socket.destroy());
  servers.push(http);
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  assert.ok(address && typeof address === "object");
  const provider = createOpenAIApiProvider();
  const ask = () => provider.streamSimple(
    model(`http://127.0.0.1:${address.port}/v1`),
    { messages: [{ role: "user", content: BIG, timestamp: 1 }] },
    { apiKey: "compress-key", transport: "auto", sessionId: "auto-compress", maxRetries: 0, websocketConnectTimeoutMs: 500,
      onTransport: (label: string | undefined) => { labels.push(label); } },
  ).result();
  for (let i = 0; i < 3; i++) assert.equal((await ask()).stopReason, "error");
  const output = await ask();
  assert.equal(output.stopReason, "stop", output.errorMessage);
  assert.deepEqual(encodings, acceptedEncoding === "zstd" ? ["zstd"]
    : acceptedEncoding === "gzip" ? ["zstd", "gzip"] : ["zstd", "gzip", "deflate", "br", undefined]);
  assert.deepEqual(labels, [acceptedEncoding === "zstd" ? "SSE Zstd" : acceptedEncoding === "gzip" ? "SSE gzip" : "SSE"]);
});
}

// HTTP content-encoding applies only to the HTTP upload; the JSON payload the
// bridge sends over WS stays plain JSON (this says nothing about negotiated
// WS frame compression — only that the application payload is uncompressed).
test("websocket path sends plain JSON payloads without HTTP encoding", async () => {
  const frames: unknown[] = [];
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  servers.push(wss);
  await new Promise<void>((resolve) => wss.once("listening", resolve));
  wss.on("connection", (socket) => {
    socket.on("message", (raw) => {
      frames.push(JSON.parse(String(raw)));
      for (const event of sseEvents("resp_ws_plain")) socket.send(JSON.stringify(event));
    });
  });
  const address = wss.address();
  assert.ok(address && typeof address === "object");
  const output = await createOpenAIApiProvider().streamSimple(
    model(`http://127.0.0.1:${address.port}/v1`),
    { messages: [{ role: "user", content: BIG, timestamp: 1 }] },
    { apiKey: "compress-key", transport: "websocket", sessionId: "ws-plain" },
  ).result();
  assert.equal(output.stopReason, "stop", output.errorMessage);
  assert.equal(frames.length, 1);
  assert.equal((frames[0] as { type?: string }).type, "response.create");
});

// Caller-supplied fetch stays the final sender; compression wraps it.
test("caller fetch sees compressed bytes at the final send", async () => {
  const seen: Array<{ encoding: string | null; body: Uint8Array | string | undefined }> = [];
  const output = await createOpenAIApiProvider().streamSimple(
    model("https://compress-caller.test/v1"),
    { messages: [{ role: "user", content: BIG, timestamp: 1 }] },
    {
      apiKey: "compress-key",
      transport: "sse",
      sessionId: "caller-fetch-compress",
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const headers = input instanceof Request ? new Headers(input.headers) : new Headers(init?.headers);
        seen.push({
          encoding: headers.get("content-encoding"),
          body: (init?.body ?? (input instanceof Request ? await input.arrayBuffer() : undefined)) as
            | Uint8Array
            | string
            | undefined,
        });
        const message = { id: "msg_r", type: "message", role: "assistant", status: "completed",
          content: [{ type: "output_text", text: "ok", annotations: [] }] };
        return new Response(
          [
            { type: "response.created", response: { id: "resp_caller" } },
            { type: "response.completed", response: { id: "resp_caller", status: "completed", output: [message],
              usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
          ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n",
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    },
  ).result();
  assert.equal(output.stopReason, "stop", output.errorMessage);
  assert.equal(seen[0]?.encoding, "zstd");
  assert.ok(seen[0]?.body instanceof Uint8Array);
});

for (const supported of [true, false]) {
  test(`WS negotiates actual compressed frames and remembers decline: ${supported}`, async () => {
    const offers: Array<string | undefined> = [];
    const frames: boolean[] = [];
    const http = createServer();
    const wss = new WebSocketServer({ server: http, perMessageDeflate: supported });
    http.on("upgrade", (request, socket) => {
      offers.push(request.headers["sec-websocket-extensions"]);
      socket.once("data", (chunk: Buffer) => frames.push((chunk[0] & 0x40) !== 0));
    });
    wss.on("connection", (socket) => {
      socket.on("message", (data) => {
        assert.equal(JSON.parse(String(data)).type, "response.create");
        for (const event of sseEvents("compression-wire")) socket.send(JSON.stringify(event));
      });
    });
    servers.push(wss, http);
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const address = http.address();
    assert.ok(address && typeof address === "object");
    for (let turn = 0; turn < 2; turn++) {
      const output = await createOpenAIApiProvider().streamSimple(
        model(`http://127.0.0.1:${address.port}/v1`),
        { messages: [{ role: "user", content: BIG, timestamp: 1 }] },
        { apiKey: "compression-wire-key", transport: "websocket" },
      ).result();
      assert.equal(output.stopReason, "stop", output.errorMessage);
    }
    assert.deepEqual(frames, [supported, supported]);
    assert.match(offers[0] ?? "", /permessage-deflate/);
    if (supported) assert.match(offers[1] ?? "", /permessage-deflate/);
    else assert.equal(offers[1], undefined);
  });
}

for (const credentialHeader of ["Authorization", "cf-aig-authorization"]) {
test(`WS compression identity follows effective ${credentialHeader}, ignoring unused apiKey`, async () => {
  const seen: Array<{ auth?: string; credential?: string; offer?: string }> = [];
  const http = createServer();
  const declined = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  const accepted = new WebSocketServer({ noServer: true, perMessageDeflate: true });
  servers.push(http, declined, accepted);
  http.on("upgrade", (request, socket, head) => {
    seen.push({ auth: request.headers.authorization, credential: request.headers[credentialHeader.toLowerCase()],
      offer: request.headers["sec-websocket-extensions"] });
    const wss = seen.length === 1 ? declined : accepted;
    wss.handleUpgrade(request, socket, head, (client) => {
      client.on("message", () => { for (const event of sseEvents(`resp_${seen.length}`)) client.send(JSON.stringify(event)); });
    });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address(); assert.ok(address && typeof address === "object");
  const provider = createOpenAIApiProvider();
  for (const [apiKey, authorization] of [["unused-a", "Bearer actual-a"], ["unused-b", "Bearer actual-a"], ["unused-b", "Bearer actual-b"]]) {
    const output = await provider.streamSimple(model(`http://127.0.0.1:${address.port}/v1`),
      { messages: [{ role: "user", content: "one", timestamp: 1 }] },
      { apiKey, headers: { [credentialHeader]: authorization }, transport: "websocket", maxRetries: 0 }).result();
    assert.equal(output.stopReason, "stop", output.errorMessage);
  }
  assert.deepEqual(seen.map((entry) => entry.credential), ["Bearer actual-a", "Bearer actual-a", "Bearer actual-b"]);
  assert.deepEqual(seen.map((entry) => entry.auth), credentialHeader === "Authorization"
    ? ["Bearer actual-a", "Bearer actual-a", "Bearer actual-b"] : [undefined, undefined, undefined]);
  assert.match(seen[0].offer ?? "", /permessage-deflate/);
  assert.equal(seen[1].offer, undefined, "same actual credential retains declined floor");
  assert.match(seen[2].offer ?? "", /permessage-deflate/, "new actual credential gets independent negotiation");
});
}
