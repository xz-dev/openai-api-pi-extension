import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { Server } from "node:http";
import { WebSocketServer } from "ws";
import type { Message } from "@earendil-works/pi-ai";
import { createOpenAIApiProvider } from "../index.ts";
import { closeResponsesWebSockets } from "../responses-websocket-fetch.ts";
import { readJsonBody } from "./fixtures/wire-decode.ts";

const servers: Array<Server | WebSocketServer> = [];

afterEach(async () => {
  closeResponsesWebSockets();
  // Unconditional teardown: terminate fixture clients so close() never waits.
  for (const server of servers) if (server instanceof WebSocketServer) for (const client of server.clients) client.terminate();
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
    maxTokens: 1024,
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

const REFERENCE_FAILURES = {
  notFound: { type: "invalid_request_error", code: "previous_response_not_found", message: "Previous response not found" },
  notAvailable: { type: "invalid_request_error", message: "previous_response_id is not available for this user" },
  storeRejected: { type: "invalid_request_error", code: "unsupported_parameter", param: "store",
    message: "store is not supported for this model" },
  parentUnsupported: { type: "invalid_request_error", code: "unsupported_parameter", param: "previous_response_id",
    message: "previous_response_id is unsupported" },
  codelessMessage: { type: "invalid_request_error", message: "previous response state was not found" },
} as const;

async function server(
  onRequest: (body: Record<string, unknown>, connection: number, socket: import("ws").WebSocket) => void,
) {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  servers.push(wss);
  await new Promise<void>((resolve) => wss.once("listening", resolve));
  let connections = 0;
  wss.on("connection", (socket) => {
    const connection = ++connections;
    socket.on("message", (raw) => onRequest(JSON.parse(String(raw)), connection, socket));
  });
  const address = wss.address();
  assert.ok(address && typeof address === "object");
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, get connections() { return connections; } };
}

const options = (sessionId: string) => ({
  apiKey: "bridge-key",
  transport: "websocket-cached" as const,
  sessionId,
  websocketConnectTimeoutMs: 1_000,
});

function reject(socket: import("ws").WebSocket, error: Record<string, unknown>) {
  socket.send(JSON.stringify({ type: "error", error, sequence_number: 0 }));
}

for (const [signal, failure] of Object.entries(REFERENCE_FAILURES)) {
  test(`checkpoint reference failure ${signal}: one repair without store/previous_response_id, then cooldown`, { timeout: 10_000 }, async () => {
    const requests: Array<Record<string, unknown>> = [];
    const upstream = await server((body, _connection, socket) => {
      requests.push(body);
      if (body.previous_response_id || (body.store === true && signal === "storeRejected" && requests.length === 1)) {
        reject(socket, failure);
        return;
      }
      completed(socket, `resp_${requests.length}`, `answer ${requests.length}`);
    });
    const provider = createOpenAIApiProvider();
    const opts = options(`checkpoint-cooldown-${signal}`);
    const first = await provider.streamSimple(
      model(upstream.baseUrl),
      { messages: [{ role: "user", content: "one", timestamp: 1 }] },
      opts,
    ).result();
    assert.equal(first.stopReason, "stop", first.errorMessage);

    const messages: Message[] = [
      { role: "user", content: "one", timestamp: 1 }, first,
      { role: "user", content: "two", timestamp: 2 },
    ];
    const second = await provider.streamSimple(model(upstream.baseUrl), { messages }, opts).result();
    assert.equal(second.stopReason, "stop", second.errorMessage);
    // Exactly one rejected request and one full-history repair without
    // store/previous_response_id.
    const rejected = requests.filter((body) => body.previous_response_id || (signal === "storeRejected" && body.store === true));
    const repair = requests.at(-1)!;
    assert.equal(rejected.length, 1);
    assert.equal(repair.previous_response_id, undefined);
    assert.equal(repair.store, undefined, "repair must not resend store");
    assert.ok(Array.isArray(repair.input) && repair.input.length > 1, "repair resends full history");

    // Cooldown: next request keeps full history and no store.
    const third = await provider.streamSimple(model(upstream.baseUrl), {
      messages: [...messages, second, { role: "user", content: "three", timestamp: 3 }],
    }, opts).result();
    assert.equal(third.stopReason, "stop", third.errorMessage);
    const cooled = requests.at(-1)!;
    assert.equal(cooled.previous_response_id, undefined);
    assert.equal(cooled.store, undefined);
    assert.ok(Array.isArray(cooled.input) && cooled.input.length > 2);
  });
}

test("checkpoint probe after cooldown sends store:true + full history; success resumes delta", { timeout: 10_000 }, async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: 0 });
  const requests: Array<Record<string, unknown>> = [];
  const upstream = await server((body, _connection, socket) => {
    requests.push(body);
    if (requests.length === 2) { reject(socket, REFERENCE_FAILURES.notFound); return; }
    completed(socket, `resp_${requests.length}`, `answer ${requests.length}`);
  });
  const provider = createOpenAIApiProvider();
  const opts = options("checkpoint-probe-resume");
  const first = await provider.streamSimple(
    model(upstream.baseUrl),
    { messages: [{ role: "user", content: "one", timestamp: 1 }] },
    opts,
  ).result();
  const messages: Message[] = [{ role: "user", content: "one", timestamp: 1 }, first,
    { role: "user", content: "two", timestamp: 2 }];
  const second = await provider.streamSimple(model(upstream.baseUrl), { messages }, opts).result();
  assert.equal(second.stopReason, "stop", second.errorMessage);
  assert.equal(requests[1]?.previous_response_id, first.responseId);
  assert.equal(requests[2]?.store, undefined, "repair drops store");

  // Inside cooldown: full history, no store.
  context.mock.timers.tick(119_999);
  await provider.streamSimple(model(upstream.baseUrl), {
    messages: [...messages, second, { role: "user", content: "three", timestamp: 3 }],
  }, opts).result();
  assert.equal(requests.at(-1)?.store, undefined);
  assert.equal(requests.at(-1)?.previous_response_id, undefined);

  // Probe at the deadline: store:true plus full history, no parent.
  context.mock.timers.tick(1);
  const probed = await provider.streamSimple(model(upstream.baseUrl), {
    messages: [...messages, second, { role: "user", content: "three", timestamp: 3 }],
  }, opts).result();
  assert.equal(probed.stopReason, "stop", probed.errorMessage);
  const probe = requests.at(-1)!;
  assert.equal(probe.store, true);
  assert.equal(probe.previous_response_id, undefined);
  assert.ok(Array.isArray(probe.input) && probe.input.length > 2);

  // Success cleared state: next turn continues with a delta.
  const next = await provider.streamSimple(model(upstream.baseUrl), {
    messages: [
      { role: "user", content: "one", timestamp: 1 }, first,
      { role: "user", content: "two", timestamp: 2 }, second,
      { role: "user", content: "three", timestamp: 3 }, probed,
      { role: "user", content: "four", timestamp: 4 },
    ],
  }, opts).result();
  assert.equal(next.stopReason, "stop", next.errorMessage);
  const delta = requests.at(-1)!;
  assert.equal(delta.previous_response_id, probed.responseId);
  assert.equal((delta.input as unknown[]).length, 1);
});

test("failed checkpoint probe renews the cooldown", { timeout: 10_000 }, async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: 0 });
  const requests: Array<Record<string, unknown>> = [];
  const upstream = await server((body, _connection, socket) => {
    requests.push(body);
    if (body.previous_response_id || body.store === true) {
      reject(socket, REFERENCE_FAILURES.storeRejected);
      return;
    }
    completed(socket, `resp_${requests.length}`, `answer ${requests.length}`);
  });
  const provider = createOpenAIApiProvider();
  const opts = options("checkpoint-probe-renew");
  const first = await provider.streamSimple(
    model(upstream.baseUrl),
    { messages: [{ role: "user", content: "one", timestamp: 1 }] },
    opts,
  ).result();
  assert.equal(first.stopReason, "stop", first.errorMessage);
  assert.equal(requests.length, 2, "store rejection already repaired the first turn");
  assert.equal(requests[0]?.store, true);
  assert.equal(requests[1]?.store, undefined);

  context.mock.timers.tick(120_000);
  // Probe carries store:true again and is rejected; repair then cooldown renews.
  const second = await provider.streamSimple(model(upstream.baseUrl), {
    messages: [{ role: "user", content: "one", timestamp: 1 }, first, { role: "user", content: "two", timestamp: 2 }],
  }, opts).result();
  assert.equal(second.stopReason, "stop", second.errorMessage);
  assert.equal(requests[2]?.store, true, "probe retried store");
  assert.equal(requests[2]?.previous_response_id, undefined);
  assert.equal(requests[3]?.store, undefined, "probe repair drops store");

  const third = await provider.streamSimple(model(upstream.baseUrl), {
    messages: [{ role: "user", content: "one", timestamp: 1 }, first,
      { role: "user", content: "two", timestamp: 2 }, second,
      { role: "user", content: "three", timestamp: 3 }],
  }, opts).result();
  assert.equal(third.stopReason, "stop", third.errorMessage);
  assert.equal(requests.at(-1)?.store, undefined, "renewed cooldown keeps store off");
});

test("one checkpoint probe per session; an overlapping request stays off", { timeout: 10_000 }, async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: 0 });
  const requests: Array<Record<string, unknown>> = [];
  let probeSocket: import("ws").WebSocket | undefined;
  let probeId = "";
  let rejected = false;
  let probeArrived!: () => void;
  const probeSeen = new Promise<void>((resolve) => { probeArrived = resolve; });
  const upstream = await server((body, _connection, socket) => {
    requests.push(body);
    if (body.previous_response_id && !rejected) { rejected = true; reject(socket, REFERENCE_FAILURES.notFound); return; }
    if (rejected && body.store === true && probeSocket === undefined) {
      // First post-cooldown store:true request is the probe; the socket is
      // held until the concurrent request lands.
      probeSocket = socket;
      probeId = `resp_${requests.length}`;
      socket.send(JSON.stringify(responseEvents(probeId, "probe answer")[0]));
      probeArrived();
      return;
    }
    completed(socket, `resp_${requests.length}`, `answer ${requests.length}`);
  });
  // Unconditional teardown: a held probe socket must never hang the suite.
  context.signal.addEventListener("abort", () => probeSocket?.terminate());
  const provider = createOpenAIApiProvider();
  const opts = options("checkpoint-probe-single");
  const first = await provider.streamSimple(
    model(upstream.baseUrl),
    { messages: [{ role: "user", content: "one", timestamp: 1 }] },
    opts,
  ).result();
  assert.equal(first.stopReason, "stop", first.errorMessage);
  const messages: Message[] = [{ role: "user", content: "one", timestamp: 1 }, first,
    { role: "user", content: "two", timestamp: 2 }];
  await provider.streamSimple(model(upstream.baseUrl), { messages }, opts).result();
  context.mock.timers.tick(120_000);

  const probe = provider.streamSimple(model(upstream.baseUrl), {
    messages: [...messages, { role: "user", content: "three", timestamp: 3 }],
  }, opts).result();
  await Promise.race([probeSeen, new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("probe never arrived")), 5_000).unref())]);
  const concurrent = await provider.streamSimple(model(upstream.baseUrl), {
    messages: [...messages, { role: "user", content: "concurrent", timestamp: 3 }],
  }, { ...opts, sessionId: "checkpoint-probe-single" }).result();
  assert.equal(concurrent.stopReason, "stop", concurrent.errorMessage);
  assert.equal(requests.at(-1)?.store, undefined, "overlapping request stays off while probe is in flight");
  for (const event of responseEvents(probeId, "probe answer").slice(1)) probeSocket!.send(JSON.stringify(event));
  assert.equal((await probe).stopReason, "stop");
});

for (const [name, error, status] of [
  ["server_error 500 not found", { type: "server_error", code: "previous_response_not_found", message: "gone" }, 500],
  ["internal_error with store param", { type: "server_error", code: "internal_error", param: "store", message: "store invalid" }, 400],
  ["authentication_error with store param", { type: "authentication_error", param: "store", message: "store invalid" }, 400],
  ["unrelated code with store param", { type: "invalid_request_error", code: "model_not_found", param: "store", message: "store invalid" }, undefined],
  ["untyped code-less message", { message: "previous_response_id is not available for this user" }, undefined],
] as const) {
  test(`non-signal rejection (${name}) is never replayed and opens no cooldown`, { timeout: 10_000 }, async () => {
    const requests: Array<Record<string, unknown>> = [];
    const upstream = await server((body, _connection, socket) => {
      requests.push(body);
      if (requests.length === 1) {
        socket.send(JSON.stringify({ type: "error", error, ...(status ? { status } : {}), sequence_number: 0 }));
        return;
      }
      completed(socket, `resp_${requests.length}`, "ok");
    });
    const provider = createOpenAIApiProvider();
    const opts = options(`non-signal-${name}`);
    const first = await provider.streamSimple(model(upstream.baseUrl),
      { messages: [{ role: "user", content: "one", timestamp: 1 }] }, { ...opts, maxRetries: 0 }).result();
    assert.equal(first.stopReason, "error");
    assert.equal(requests.length, 1, "no replay");
    const second = await provider.streamSimple(model(upstream.baseUrl),
      { messages: [{ role: "user", content: "again", timestamp: 2 }] }, opts).result();
    assert.equal(second.stopReason, "stop", second.errorMessage);
    assert.equal(requests.at(-1)?.store, true, "no cooldown opened");
  });
}

test("non-signal probe failure renews the cooldown without replay", { timeout: 10_000 }, async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: 0 });
  const requests: Array<Record<string, unknown>> = [];
  let probeFails = false;
  const upstream = await server((body, _connection, socket) => {
    requests.push(body);
    if (requests.length === 1) { reject(socket, REFERENCE_FAILURES.storeRejected); return; }
    if (probeFails && body.store === true) {
      socket.send(JSON.stringify({ type: "error", error: { type: "server_error", message: "boom" }, status: 500 }));
      return;
    }
    completed(socket, `resp_${requests.length}`, "ok");
  });
  const provider = createOpenAIApiProvider();
  const opts = { ...options("probe-non-signal"), maxRetries: 0 };
  const ask = (text: string) => provider.streamSimple(model(upstream.baseUrl),
    { messages: [{ role: "user", content: text, timestamp: 1 }] }, opts).result();
  assert.equal((await ask("one")).stopReason, "stop");
  assert.equal(requests.length, 2);
  context.mock.timers.tick(120_000);
  probeFails = true;
  assert.equal((await ask("probe")).stopReason, "error");
  assert.equal(requests.length, 3, "probe never replayed");
  assert.equal(requests[2]?.store, true);
  probeFails = false;
  assert.equal((await ask("next")).stopReason, "stop");
  assert.equal(requests.at(-1)?.store, undefined, "renewed cooldown keeps store off");
});

test("auto with checkpoints on still falls back to SSE on a pre-open handshake failure", { timeout: 10_000 }, async () => {
  const { createServer } = await import("node:http");
  const bodies: Array<Record<string, unknown>> = [];
  const http = createServer(async (request, response) => {
    bodies.push(await readJsonBody(request) as Record<string, unknown>);
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of responseEvents("resp_sse", "sse ok")) response.write(`data: ${JSON.stringify(event)}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  http.on("upgrade", (_request, socket) => socket.destroy());
  servers.push(http);
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  assert.ok(address && typeof address === "object");
  const provider = createOpenAIApiProvider();
  const ask = () => provider.streamSimple(
    model(`http://127.0.0.1:${address.port}/v1`),
    { messages: [{ role: "user", content: "one", timestamp: 1 }] },
    { apiKey: "bridge-key", transport: "auto", sessionId: "checkpoint-handshake-sse", maxRetries: 0, websocketConnectTimeoutMs: 1_000 },
  ).result();
  for (let i = 0; i < 3; i++) assert.equal((await ask()).stopReason, "error");
  const out = await ask();
  assert.equal(out.stopReason, "stop", out.errorMessage);
  assert.equal(bodies.length, 1);
  assert.notEqual(bodies[0]?.store, true, "SSE fallback never carries store:true");
  assert.equal(bodies[0]?.previous_response_id, undefined);
});

test("hook store:false keeps its veto through cooldown and never claims the probe", { timeout: 10_000 }, async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: 0 });
  const requests: Array<Record<string, unknown>> = [];
  const upstream = await server((body, _connection, socket) => {
    requests.push(body);
    if (requests.length === 1) { reject(socket, REFERENCE_FAILURES.storeRejected); return; }
    completed(socket, `resp_${requests.length}`, `answer ${requests.length}`);
  });
  const provider = createOpenAIApiProvider();
  const opts = options("hook-veto-cooldown");
  const vetoed = { ...opts, onPayload: (payload: any) => ({ ...payload, store: false }) };
  const first = await provider.streamSimple(model(upstream.baseUrl),
    { messages: [{ role: "user", content: "one", timestamp: 1 }] }, opts).result();
  assert.equal(first.stopReason, "stop", first.errorMessage);
  assert.equal(requests.length, 2);
  const messages: Message[] = [{ role: "user", content: "one", timestamp: 1 }, first, { role: "user", content: "two", timestamp: 2 }];
  const second = await provider.streamSimple(model(upstream.baseUrl), { messages }, vetoed).result();
  assert.equal(second.stopReason, "stop", second.errorMessage);
  assert.equal(requests[2]?.store, false);
  const third = await provider.streamSimple(model(upstream.baseUrl),
    { messages: [...messages, second, { role: "user", content: "three", timestamp: 3 }] }, vetoed).result();
  assert.equal(third.stopReason, "stop", third.errorMessage);
  assert.equal(requests[3]?.store, false);
  assert.equal(requests[3]?.previous_response_id, undefined, "cooldown forces full context");
  assert.ok(Array.isArray(requests[3]?.input) && requests[3].input.length > 2);
  // After the deadline a vetoed request does not consume the probe slot...
  context.mock.timers.tick(120_000);
  await provider.streamSimple(model(upstream.baseUrl),
    { messages: [{ role: "user", content: "veto", timestamp: 4 }] }, vetoed).result();
  assert.equal(requests[4]?.store, false);
  // ...so the next policy request is still the store:true probe.
  await provider.streamSimple(model(upstream.baseUrl),
    { messages: [{ role: "user", content: "probe", timestamp: 5 }] }, opts).result();
  assert.equal(requests[5]?.store, true);
});

test("500 previous_response_not_found never replays through the legacy repair branch", { timeout: 10_000 }, async () => {
  const requests: Array<Record<string, unknown>> = [];
  const upstream = await server((body, _connection, socket) => {
    requests.push(body);
    if (body.previous_response_id) {
      socket.send(JSON.stringify({ type: "error", status: 500,
        error: { type: "invalid_request_error", code: "previous_response_not_found", message: "gone" } }));
      return;
    }
    completed(socket, `resp_${requests.length}`, "ok");
  });
  const provider = createOpenAIApiProvider();
  const opts = { ...options("legacy-500"), maxRetries: 0 };
  const first = await provider.streamSimple(model(upstream.baseUrl),
    { messages: [{ role: "user", content: "one", timestamp: 1 }] }, opts).result();
  const second = await provider.streamSimple(model(upstream.baseUrl), { messages: [
    { role: "user", content: "one", timestamp: 1 }, first, { role: "user", content: "two", timestamp: 2 }] }, opts).result();
  assert.equal(second.stopReason, "error");
  assert.equal(requests.length, 2, "no replay after an ambiguous 500");
});

test("cooldown keeps a caller-owned previous_response_id", { timeout: 10_000 }, async () => {
  const requests: Array<Record<string, unknown>> = [];
  const upstream = await server((body, _connection, socket) => {
    requests.push(body);
    if (requests.length === 1) { reject(socket, REFERENCE_FAILURES.storeRejected); return; }
    completed(socket, `resp_${requests.length}`, "ok");
  });
  const provider = createOpenAIApiProvider();
  const opts = options("cooldown-caller-parent");
  await provider.streamSimple(model(upstream.baseUrl), { messages: [{ role: "user", content: "one", timestamp: 1 }] }, opts).result();
  assert.equal(requests.length, 2);
  await provider.streamSimple(model(upstream.baseUrl), { messages: [{ role: "user", content: "delta", timestamp: 2 }] },
    { ...opts, onPayload: (payload: any) => ({ ...payload, previous_response_id: "resp_external_root" }) }).result();
  assert.equal(requests[2]?.previous_response_id, "resp_external_root");
  assert.equal(requests[2]?.store, undefined);
});

for (const target of ["store", "previous_response_id"] as const) {
  test(`first-frame response.failed ${target} rejection repairs once`, { timeout: 10_000 }, async () => {
    const requests: Array<Record<string, unknown>> = [];
    const upstream = await server((body, _connection, socket) => {
      requests.push(body);
      const hit = target === "store" ? body.store === true : Boolean(body.previous_response_id);
      if (hit && requests.length <= (target === "store" ? 1 : 2)) {
        socket.send(JSON.stringify({ type: "response.failed", response: { id: "resp_failed", status: "failed",
          error: { type: "invalid_request_error", param: target, message: "Unsupported parameter" } } }));
        return;
      }
      completed(socket, `resp_${requests.length}`, "ok");
    });
    const provider = createOpenAIApiProvider();
    const opts = options(`response-failed-${target}`);
    const first = await provider.streamSimple(model(upstream.baseUrl),
      { messages: [{ role: "user", content: "one", timestamp: 1 }] }, opts).result();
    assert.equal(first.stopReason, "stop", first.errorMessage);
    if (target === "previous_response_id") {
      const second = await provider.streamSimple(model(upstream.baseUrl), { messages: [
        { role: "user", content: "one", timestamp: 1 }, first, { role: "user", content: "two", timestamp: 2 }] }, opts).result();
      assert.equal(second.stopReason, "stop", second.errorMessage);
      assert.equal(requests.length, 3);
    } else {
      assert.equal(requests.length, 2);
    }
    const repair = requests.at(-1)!;
    assert.equal(repair.store, undefined);
    assert.equal(repair.previous_response_id, undefined);
  });
}

test("aborted probe releases its claim without renewing; next request probes", { timeout: 10_000 }, async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: 0 });
  const requests: Array<Record<string, unknown>> = [];
  let hold = false;
  let held!: () => void;
  const arrived = new Promise<void>((resolve) => { held = resolve; });
  const upstream = await server((body, _connection, socket) => {
    requests.push(body);
    if (requests.length === 1) { reject(socket, REFERENCE_FAILURES.storeRejected); return; }
    if (hold) { held(); return; } // never answers: the client aborts
    completed(socket, `resp_${requests.length}`, "ok");
  });
  const provider = createOpenAIApiProvider();
  const opts = { ...options("probe-abort"), maxRetries: 0 };
  const ask = (text: string, signal?: AbortSignal) => provider.streamSimple(model(upstream.baseUrl),
    { messages: [{ role: "user", content: text, timestamp: 1 }] }, { ...opts, signal }).result();
  await ask("one");
  context.mock.timers.tick(120_000);
  hold = true;
  const controller = new AbortController();
  const probe = ask("probe", controller.signal);
  await arrived;
  controller.abort();
  assert.equal((await probe).stopReason, "aborted");
  assert.equal(requests.at(-1)?.store, true);
  hold = false;
  await ask("next");
  assert.equal(requests.at(-1)?.store, true, "claim released and deadline not renewed: next request probes");
});

test("probe that captures nothing renews the cooldown", { timeout: 10_000 }, async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: 0 });
  const requests: Array<Record<string, unknown>> = [];
  const upstream = await server((body, _connection, socket) => {
    requests.push(body);
    if (requests.length === 1) { reject(socket, REFERENCE_FAILURES.storeRejected); return; }
    const events = responseEvents(`resp_${requests.length}`, "ok");
    const done = events.at(-1) as { response: Record<string, unknown> };
    done.response.store = false; // server declines storage: no checkpoint captured
    for (const event of events) socket.send(JSON.stringify(event));
  });
  const provider = createOpenAIApiProvider();
  const opts = options("probe-uncaptured");
  const ask = (text: string) => provider.streamSimple(model(upstream.baseUrl),
    { messages: [{ role: "user", content: text, timestamp: 1 }] }, opts).result();
  await ask("one");
  context.mock.timers.tick(120_000);
  assert.equal((await ask("probe")).stopReason, "stop");
  assert.equal(requests.at(-1)?.store, true);
  await ask("next");
  assert.equal(requests.at(-1)?.store, undefined, "uncaptured probe renewed the cooldown");
});

test("checkpoint cooldown is partitioned by credential", { timeout: 10_000 }, async () => {
  const requests: Array<Record<string, unknown>> = [];
  const upstream = await server((body, _connection, socket) => {
    requests.push(body);
    if (requests.length === 1) { reject(socket, REFERENCE_FAILURES.storeRejected); return; }
    completed(socket, `resp_${requests.length}`, "ok");
  });
  const provider = createOpenAIApiProvider();
  const opts = options("credential-partition");
  await provider.streamSimple(model(upstream.baseUrl), { messages: [{ role: "user", content: "a", timestamp: 1 }] }, opts).result();
  assert.equal(requests.length, 2);
  await provider.streamSimple(model(upstream.baseUrl), { messages: [{ role: "user", content: "b", timestamp: 1 }] },
    { ...opts, apiKey: "other-account-key" }).result();
  assert.equal(requests[2]?.store, true, "another credential is not cooled down");
});

for (const [name, frame] of [
  ["status 500", { status: 500 }],
  ["401 invalid_api_key", { status: 401, error: { code: "invalid_api_key" } }],
] as const) {
  test(`legacy message-ID rejection with ${name} is never replayed`, { timeout: 10_000 }, async () => {
    const requests: Array<Record<string, unknown>> = [];
    const upstream = await server((body, _connection, socket) => {
      requests.push(body);
      if (body.previous_response_id) {
        const error = { type: "invalid_request_error",
          message: "previous_response_id must be a response.id (resp_*), not a message id",
          ...("error" in frame ? frame.error : {}) };
        socket.send(JSON.stringify({ type: "error", ...("status" in frame ? { status: frame.status } : {}), error }));
        return;
      }
      completed(socket, `resp_${requests.length}`, "ok");
    });
    const provider = createOpenAIApiProvider();
    const opts = { ...options(`legacy-conflict-${name}`), maxRetries: 0, responseCheckpointExclude: ["*"] };
    const first = await provider.streamSimple(model(upstream.baseUrl),
      { messages: [{ role: "user", content: "one", timestamp: 1 }] }, opts).result();
    const second = await provider.streamSimple(model(upstream.baseUrl), { messages: [
      { role: "user", content: "one", timestamp: 1 }, first, { role: "user", content: "two", timestamp: 2 }] }, opts).result();
    assert.equal(second.stopReason, "error");
    assert.equal(requests.length, 2, "no replay");
  });
}

for (const [name, extra] of [["status 500", { status: 500 }], ["code invalid_api_key", { code: "invalid_api_key" }]] as const) {
  test(`response.failed store rejection with frame-level ${name} is never replayed`, { timeout: 10_000 }, async () => {
    const requests: Array<Record<string, unknown>> = [];
    const upstream = await server((body, _connection, socket) => {
      requests.push(body);
      socket.send(JSON.stringify({ type: "response.failed", ...extra, response: { id: "resp_failed", status: "failed",
        error: { type: "invalid_request_error", param: "store", message: "Unsupported parameter" } } }));
    });
    const out = await createOpenAIApiProvider().streamSimple(model(upstream.baseUrl),
      { messages: [{ role: "user", content: "one", timestamp: 1 }] }, { ...options(`failed-frame-${name}`), maxRetries: 0 }).result();
    assert.equal(out.stopReason, "error");
    assert.equal(requests.length, 1);
  });
}

test("cooldown keeps chaining an inherited caller-rooted descendant", { timeout: 10_000 }, async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: 0 });
  const requests: Array<Record<string, unknown>> = [];
  const upstream = await server((body, _connection, socket) => {
    requests.push(body);
    if (requests.length === 1) { reject(socket, REFERENCE_FAILURES.storeRejected); return; }
    completed(socket, `resp_${requests.length}`, `answer ${requests.length}`);
  });
  const provider = createOpenAIApiProvider();
  const opts = options("cooldown-descendant");
  await provider.streamSimple(model(upstream.baseUrl), { messages: [{ role: "user", content: "one", timestamp: 1 }] }, opts).result();
  const callerMessages: Message[] = [{ role: "user", content: "delta", timestamp: 2 }];
  const caller = await provider.streamSimple(model(upstream.baseUrl), { messages: callerMessages },
    { ...opts, onPayload: (payload: any) => ({ ...payload, previous_response_id: "resp_external_root" }) }).result();
  assert.equal(caller.stopReason, "stop", caller.errorMessage);
  assert.equal(requests[2]?.previous_response_id, "resp_external_root");
  const descendant: any = await provider.streamSimple(model(upstream.baseUrl),
    { messages: [...callerMessages, caller, { role: "user", content: "two", timestamp: 3 }] }, opts).result();
  assert.equal(descendant.stopReason, "stop", descendant.errorMessage);
  assert.equal(requests[3]?.previous_response_id, caller.responseId, "descendant chains the caller-rooted response");
  assert.equal((requests[3]?.input as unknown[]).length, 1);
  assert.equal(requests[3]?.store, undefined);
  assert.equal(descendant.responseCheckpoint, undefined);
  // A hook store:false descendant still chains the lineage.
  const vetoMessages: Message[] = [...callerMessages, caller, { role: "user", content: "two", timestamp: 3 }, descendant,
    { role: "user", content: "veto", timestamp: 4 }];
  const vetoed: any = await provider.streamSimple(model(upstream.baseUrl), { messages: vetoMessages },
    { ...opts, onPayload: (payload: any) => ({ ...payload, store: false }) }).result();
  assert.equal(vetoed.stopReason, "stop", vetoed.errorMessage);
  assert.equal(requests[4]?.previous_response_id, descendant.responseId);
  assert.equal(requests[4]?.store, false);
  // After expiry the probe keeps chaining and captures nothing.
  context.mock.timers.tick(120_000);
  const probe: any = await provider.streamSimple(model(upstream.baseUrl),
    { messages: [...vetoMessages, vetoed, { role: "user", content: "probe", timestamp: 5 }] }, opts).result();
  assert.equal(probe.stopReason, "stop", probe.errorMessage);
  assert.equal(requests[5]?.previous_response_id, vetoed.responseId);
  assert.equal((requests[5]?.input as unknown[]).length, 1);
  assert.equal(probe.responseCheckpoint, undefined);
});

test("checkpoint cooldown is partitioned by Authorization-header credential", { timeout: 10_000 }, async () => {
  const requests: Array<Record<string, unknown>> = [];
  const upstream = await server((body, _connection, socket) => {
    requests.push(body);
    if (requests.length === 1) { reject(socket, REFERENCE_FAILURES.storeRejected); return; }
    completed(socket, `resp_${requests.length}`, "ok");
  });
  const provider = createOpenAIApiProvider();
  const base = options("header-credential-partition");
  await provider.streamSimple(model(upstream.baseUrl), { messages: [{ role: "user", content: "a", timestamp: 1 }] },
    { ...base, headers: { Authorization: "Bearer account-a" } }).result();
  assert.equal(requests.length, 2);
  await provider.streamSimple(model(upstream.baseUrl), { messages: [{ role: "user", content: "same", timestamp: 1 }] },
    { ...base, apiKey: "different-unused-key", headers: { authorization: "Bearer account-a" } }).result();
  assert.equal(requests[2]?.store, undefined, "unused apiKey change retains actual account cooldown");
  await provider.streamSimple(model(upstream.baseUrl), { messages: [{ role: "user", content: "b", timestamp: 1 }] },
    { ...base, headers: { Authorization: "Bearer account-b" } }).result();
  assert.equal(requests[3]?.store, true, "account B is not cooled down by account A");
});

for (const transport of ["auto", "websocket-cached"] as const) {
  test(`${transport}: unchainable caller-rooted request fails closed with no WS/SSE request, lineage survives`, { timeout: 10_000 }, async () => {
    const requests: Array<Record<string, unknown>> = [];
    let sse = 0;
    const upstream = await server((body, _connection, socket) => {
      requests.push(body);
      if (requests.length === 1) { reject(socket, REFERENCE_FAILURES.storeRejected); return; }
      completed(socket, `resp_${requests.length}`, `answer ${requests.length}`);
    });
    const provider = createOpenAIApiProvider();
    const opts = { ...options(`unchainable-${transport}`), transport, maxRetries: 2,
      fetch: async () => { sse++; return new Response("unexpected", { status: 500 }); } };
    await provider.streamSimple(model(upstream.baseUrl), { messages: [{ role: "user", content: "one", timestamp: 1 }] }, opts).result();
    const callerMessages: Message[] = [{ role: "user", content: "delta", timestamp: 2 }];
    const caller = await provider.streamSimple(model(upstream.baseUrl), { messages: callerMessages },
      { ...opts, onPayload: (payload: any) => ({ ...payload, previous_response_id: "resp_external_root" }) }).result();
    assert.equal(caller.stopReason, "stop", caller.errorMessage);
    const before = requests.length;
    const next: Message[] = [...callerMessages, caller, { role: "user", content: "two", timestamp: 3 }];
    // A changed request option (maxTokens) cannot match the caller-rooted baseline.
    const changed = await provider.streamSimple({ ...model(upstream.baseUrl), maxTokens: 128 }, { messages: next },
      { ...opts, onPayload: (payload: any) => ({ ...payload, store: false }) }).result();
    assert.equal(changed.stopReason, "error");
    assert.equal(requests.length, before, "no WS request");
    assert.equal(sse, 0, "no SSE fallback");
    // A matching retry still chains the caller-rooted response.
    const retried = await provider.streamSimple(model(upstream.baseUrl), { messages: next }, opts).result();
    assert.equal(retried.stopReason, "stop", retried.errorMessage);
    assert.equal(requests.at(-1)?.previous_response_id, caller.responseId);
  });
}

test("prod gateway output (logprobs: []) captures checkpoints, chains deltas and repairs a keeper miss", { timeout: 10_000 }, async () => {
  const requests: Array<Record<string, unknown>> = [];
  let chained = 0;
  const upstream = await server((body, _connection, socket) => {
    requests.push(body);
    // Keeper restart: the second chained reference is gone.
    if (body.previous_response_id && ++chained === 2) {
      socket.send(JSON.stringify({ type: "error", status: 400, error: { code: "previous_response_not_found",
        message: `Previous response with id '${body.previous_response_id}' not found.`,
        param: "previous_response_id", type: "invalid_request_error" } }));
      return;
    }
    for (const event of responseEvents(`resp_${requests.length}`, `answer ${requests.length}`)) {
      socket.send(JSON.stringify(event).replaceAll('"annotations":[]', '"annotations":[],"logprobs":[]'));
    }
  });
  const provider = createOpenAIApiProvider();
  const opts = options("prod-logprobs");
  let messages: Message[] = [{ role: "user", content: "one", timestamp: 1 }];
  const outs = [];
  for (let turn = 0; turn < 3; turn++) {
    const out = await provider.streamSimple(model(upstream.baseUrl), { messages }, opts).result();
    outs.push(out);
    messages = [...messages, out, { role: "user", content: `next ${turn}`, timestamp: turn + 2 }];
  }
  assert.deepEqual(outs.map((out) => out.stopReason), ["stop", "stop", "stop"]);
  assert.equal(requests[1]?.previous_response_id, "resp_1", "second turn sends a delta");
  const repair = requests.at(-1)!;
  assert.equal(repair.previous_response_id, undefined);
  assert.equal(repair.store, undefined);
  assert.equal((repair.input as unknown[]).length, 5);
});

test("checkpoint failures step 2/3/4/5/5 minutes; captured success resets progression", { timeout: 10_000 }, async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: 0 });
  const requests: Array<Record<string, unknown>> = [];
  let rejects = true;
  const upstream = await server((body, _connection, socket) => {
    requests.push(body);
    if (rejects && body.store === true) { reject(socket, REFERENCE_FAILURES.storeRejected); return; }
    completed(socket, `resp_${requests.length}`, "ok");
  });
  const provider = createOpenAIApiProvider();
  const opts = { ...options("probe-progression"), maxRetries: 0 };
  const ask = () => provider.streamSimple(model(upstream.baseUrl),
    { messages: [{ role: "user", content: "one", timestamp: 1 }] }, opts).result();
  assert.equal((await ask()).stopReason, "stop");
  for (const minutes of [2, 3, 4, 5, 5]) {
    context.mock.timers.tick(minutes * 60_000 - 1);
    await ask();
    assert.equal(requests.at(-1)?.store, undefined, `suppressed before ${minutes}-minute deadline`);
    context.mock.timers.tick(1);
    await ask();
    assert.equal(requests.at(-2)?.store, true, `probe at ${minutes}-minute deadline`);
    assert.equal(requests.at(-1)?.store, undefined, "one store-off repair");
  }
  rejects = false;
  context.mock.timers.tick(300_000);
  const success: any = await ask();
  assert.ok(success.responseCheckpoint, success.errorMessage);
  rejects = true;
  await ask();
  context.mock.timers.tick(119_999);
  await ask(); assert.equal(requests.at(-1)?.store, undefined);
  context.mock.timers.tick(1);
  await ask(); assert.equal(requests.at(-2)?.store, true, "new failure starts at two minutes again");
});

test("held rejected probe and failed repair keep single ownership and advance only once", { timeout: 10_000 }, async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: 0 });
  const requests: Array<Record<string, unknown>> = [];
  let heldSocket: import("ws").WebSocket | undefined;
  let markHeld!: () => void;
  const held = new Promise<void>((resolve) => { markHeld = resolve; });
  const upstream = await server((body, _connection, socket) => {
    requests.push(body);
    if (body.store === true) { reject(socket, REFERENCE_FAILURES.storeRejected); return; }
    if (requests.length === 4) { heldSocket = socket; markHeld(); return; }
    completed(socket, `resp_${requests.length}`, "ok");
  });
  const provider = createOpenAIApiProvider();
  const opts = { ...options("probe-held-failed-repair"), maxRetries: 0 };
  const ask = () => provider.streamSimple(model(upstream.baseUrl),
    { messages: [{ role: "user", content: "one", timestamp: 1 }] }, opts).result();
  await ask();
  context.mock.timers.tick(120_000);
  const probe = ask(); await held;
  assert.equal(requests[2]?.store, true);
  assert.equal(requests[3]?.store, undefined);
  context.mock.timers.tick(240_000); // renewed deadline elapsed, repair still owns probe
  await ask();
  assert.equal(requests.at(-1)?.store, undefined, "repair cannot release owner before it settles");
  heldSocket!.send(JSON.stringify({ type: "error", status: 500, error: { type: "server_error", message: "repair failed" } }));
  assert.equal((await probe).stopReason, "error");
  assert.equal(requests.length, 5, "no replay after failed full-history repair");
  context.mock.timers.tick(179_999);
  await ask(); assert.equal(requests.at(-1)?.store, undefined);
  context.mock.timers.tick(1);
  await ask(); assert.equal(requests.at(-2)?.store, true, "repair failure renews three minutes, not four");
});

test("unsent handshake, abort and SSE-only requests leave checkpoint probe immediately available", { timeout: 10_000 }, async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: 0 });
  const requests: Array<Record<string, unknown>> = [];
  const upstream = await server((body, _connection, socket) => {
    requests.push(body);
    if (body.store === true && requests.length === 1) { reject(socket, REFERENCE_FAILURES.storeRejected); return; }
    completed(socket, `resp_${requests.length}`, "ok");
  });
  const wss = servers.at(-1) as WebSocketServer;
  const provider = createOpenAIApiProvider();
  const opts = { ...options("probe-unsent"), maxRetries: 0 };
  const ask = (extra: Record<string, unknown> = {}) => provider.streamSimple(model(upstream.baseUrl),
    { messages: [{ role: "user", content: "one", timestamp: 1 }] }, { ...opts, ...extra }).result();
  await ask(); context.mock.timers.tick(120_000);
  await Promise.all([...wss.clients].map((socket) => new Promise<void>((resolve) => {
    socket.once("close", () => resolve()); socket.close(1000, "force handshake probe");
  })));
  wss.options.verifyClient = (_info, done) => done(false, 503);
  assert.equal((await ask()).stopReason, "error");
  assert.equal(requests.length, 2, "failed handshake transmits no frame");
  wss.options.verifyClient = undefined;
  const controller = new AbortController(); controller.abort();
  assert.equal((await ask({ signal: controller.signal })).stopReason, "aborted");
  const sse = responseEvents("resp_sse_only", "ok").map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n";
  assert.equal((await ask({ transport: "sse", fetch: async () => new Response(sse, { headers: { "content-type": "text/event-stream" } }) })).stopReason, "stop");
  const success: any = await ask();
  assert.equal(requests.at(-1)?.store, true, "unsent/abort/SSE neither renew nor consume progression");
  assert.ok(success.responseCheckpoint, success.errorMessage);
});

test("transport SSE cooldown never consumes expired checkpoint probe; WS recovery can own both", { timeout: 10_000 }, async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: 0 });
  const requests: Array<Record<string, unknown>> = [];
  const upstream = await server((body, _connection, socket) => {
    requests.push(body);
    if (requests.length === 1) { reject(socket, REFERENCE_FAILURES.storeRejected); return; }
    completed(socket, `resp_${requests.length}`, "ok");
  });
  const wss = servers.at(-1) as WebSocketServer;
  const provider = createOpenAIApiProvider();
  let sse = 0;
  const opts = { ...options("independent-probes"), transport: "auto" as const, maxRetries: 0,
    fetch: async () => {
      sse++;
      return new Response(responseEvents(`resp_sse_${sse}`, "ok").map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } });
    } };
  const ask = () => provider.streamSimple(model(upstream.baseUrl),
    { messages: [{ role: "user", content: "one", timestamp: 1 }] }, opts).result();
  await ask();
  context.mock.timers.tick(60_000);
  await Promise.all([...wss.clients].map((socket) => new Promise<void>((resolve) => {
    socket.once("close", () => resolve()); socket.close(1000, "force handshake");
  })));
  wss.options.verifyClient = (_info, done) => done(false, 503);
  for (let i = 0; i < 3; i++) assert.equal((await ask()).stopReason, "error");
  assert.equal((await ask()).stopReason, "stop");
  context.mock.timers.tick(60_000); // checkpoint deadline reached; transport still cooled
  assert.equal((await ask()).stopReason, "stop");
  assert.equal(sse, 2);
  assert.equal(requests.length, 2, "SSE-only attempts cannot transmit/consume checkpoint probe");
  wss.options.verifyClient = undefined;
  context.mock.timers.tick(60_000);
  const recovered: any = await ask();
  assert.equal(requests.at(-1)?.store, true, "one admitted WS request probes independent storage state too");
  assert.equal(requests.at(-1)?.previous_response_id, undefined);
  assert.ok(recovered.responseCheckpoint, recovered.errorMessage);
});

test("late captured success resets progression but only owner clears checkpoint deadline", { timeout: 10_000 }, async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: 0 });
  const requests: Array<Record<string, unknown>> = [];
  let oldSocket!: import("ws").WebSocket;
  let probeSocket!: import("ws").WebSocket;
  let markOld!: () => void;
  let markProbe!: () => void;
  const oldSeen = new Promise<void>((resolve) => { markOld = resolve; });
  const probeSeen = new Promise<void>((resolve) => { markProbe = resolve; });
  const upstream = await server((body, _connection, socket) => {
    requests.push(body);
    if (requests.length === 1) { oldSocket = socket; markOld(); return; }
    if (requests.length === 2) { reject(socket, REFERENCE_FAILURES.storeRejected); return; }
    if (requests.length === 4) { probeSocket = socket; markProbe(); return; }
    completed(socket, `resp_${requests.length}`, "ok");
  });
  const provider = createOpenAIApiProvider();
  const opts = { ...options("late-checkpoint-owner"), maxRetries: 0 };
  const ask = () => provider.streamSimple(model(upstream.baseUrl),
    { messages: [{ role: "user", content: "one", timestamp: 1 }] }, opts).result();
  const old = ask(); await oldSeen;
  await ask();
  context.mock.timers.tick(120_000);
  const probe = ask(); await probeSeen;
  completed(oldSocket, "resp_old", "ok");
  assert.ok((await old as any).responseCheckpoint, "late success captured valid checkpoint");
  await ask(); assert.equal(requests.at(-1)?.store, undefined, "non-owner success cannot clear active deadline/claim");
  for (const event of responseEvents("resp_probe", "ok")) {
    if (event.type === "response.completed") (event as any).response.store = false;
    probeSocket.send(JSON.stringify(event));
  }
  assert.equal((await probe).stopReason, "stop");
  context.mock.timers.tick(119_999);
  await ask(); assert.equal(requests.at(-1)?.store, undefined);
  context.mock.timers.tick(1);
  const success: any = await ask();
  assert.equal(requests.at(-1)?.store, true, "late captured success reset next duration to two minutes");
  assert.ok(success.responseCheckpoint, success.errorMessage);
  const immediate: any = await ask();
  assert.equal(requests.at(-1)?.store, true, "owner success cleared cooldown");
  assert.ok(immediate.responseCheckpoint, immediate.errorMessage);
});
