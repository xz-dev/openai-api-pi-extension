import { createHash } from "node:crypto";
import OpenAI from "openai";
import { ResponsesWS } from "openai/resources/responses/ws";
import type { ResponsesStreamMessage } from "openai/resources/responses/internal-base";
import type { ResponseInput, ResponseStreamEvent, ResponsesClientEvent } from "openai/resources/responses/responses";
import {
  type AssistantMessage,
  type AssistantMessageEventStream,
  createAssistantMessageEventStream,
  type Model,
  registerSessionResourceCleanup,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";

const OPENAI_TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode", "openai-api-extension"]);
const SOCKET_TTL_MS = 5 * 60 * 1000;
const encoder = new TextEncoder();

type RequestBody = Omit<ResponsesClientEvent, "type"> & { stream?: boolean };
type Continuation = {
  request: RequestBody;
  responseId: string;
  responseItems: ResponseInput;
};
type Connection = {
  ws: ResponsesWS;
  busy: boolean;
  timer?: ReturnType<typeof setTimeout>;
  continuation?: Continuation;
};
type Pending = {
  connection: Connection;
  idleTimeoutMs?: number;
  key?: string;
  keep: boolean;
  request: RequestBody;
  iterator: AsyncIterator<ResponsesStreamMessage>;
};

type BridgeOptions = Pick<
  SimpleStreamOptions,
  "apiKey" | "cacheRetention" | "fetch" | "sessionId" | "timeoutMs" | "transport" | "websocketConnectTimeoutMs"
>;

const connections = new Map<string, Connection>();
const autoSseFallbacks = new Set<string>();
const actualTransports = new Map<string, "sse" | "websocket" | "websocket-cached">();

function transportKey(baseUrl: string, sessionId?: string): string {
  return `${baseUrl}\0${sessionId ?? ""}`;
}

function cacheEnabled(options: BridgeOptions): boolean {
  return options.cacheRetention !== "none" && (options.transport === "auto" || options.transport === "websocket-cached");
}

function connectionKey(model: Model<"openai-responses">, options: BridgeOptions, headers: Headers): string | undefined {
  if (!cacheEnabled(options) || !options.sessionId) return undefined;
  const identity = createHash("sha256").update(JSON.stringify([...headers])).digest("hex");
  return `${model.baseUrl}\0${options.sessionId}\0${identity}`;
}

function closeConnection(key: string | undefined, connection: Connection, reason: string): void {
  if (connection.timer) clearTimeout(connection.timer);
  try { connection.ws.close({ code: 1000, reason }); } catch {}
  if (key && connections.get(key) === connection) connections.delete(key);
}

function release(pending: Pending): void {
  if (pending.keep && pending.key) {
    pending.connection.busy = false;
    pending.connection.timer = setTimeout(() => {
      if (!pending.connection.busy) closeConnection(pending.key, pending.connection, "idle timeout");
    }, SOCKET_TTL_MS);
  } else {
    closeConnection(pending.key, pending.connection, "complete");
  }
}

function createConnection(model: Model<"openai-responses">, options: BridgeOptions, headers: Headers): Connection {
  const apiKey = options.apiKey ?? headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  const client = new OpenAI({ apiKey, baseURL: model.baseUrl, maxRetries: 0 });
  return {
    ws: new ResponsesWS(client, {
      handshakeTimeout: options.websocketConnectTimeoutMs,
      headers: Object.fromEntries(headers),
    }),
    busy: true,
  };
}

function acquire(
  model: Model<"openai-responses">,
  options: BridgeOptions,
  headers: Headers,
): Pick<Pending, "connection" | "key" | "keep"> {
  const key = connectionKey(model, options, headers);
  const existing = key ? connections.get(key) : undefined;
  if (existing && !existing.busy && existing.ws.socket.readyState === 1) {
    if (existing.timer) clearTimeout(existing.timer);
    existing.busy = true;
    return { connection: existing, key, keep: true };
  }

  const connection = createConnection(model, options, headers);
  const keep = Boolean(key);
  if (key) connections.set(key, connection);
  return { connection, key, keep };
}

function withoutInput(body: RequestBody): Omit<RequestBody, "input" | "previous_response_id"> {
  const { input: _input, previous_response_id: _previousResponseId, ...rest } = body;
  return rest;
}

function cachedBody(connection: Connection, body: RequestBody): RequestBody {
  const previous = connection.continuation;
  if (!previous || JSON.stringify(withoutInput(body)) !== JSON.stringify(withoutInput(previous.request))) return body;
  const input = body.input ?? [];
  const baseline = [...(previous.request.input ?? []), ...previous.responseItems];
  if (input.length < baseline.length || JSON.stringify(input.slice(0, baseline.length)) !== JSON.stringify(baseline)) return body;
  return { ...body, previous_response_id: previous.responseId, input: input.slice(baseline.length) };
}

async function nextItem(pending: Pending) {
  if (!pending.idleTimeoutMs || pending.idleTimeoutMs <= 0) return pending.iterator.next();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending.iterator.next(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          closeConnection(pending.key, pending.connection, "idle timeout");
          reject(new Error(`Responses WebSocket idle timeout after ${pending.idleTimeoutMs}ms`));
        }, pending.idleTimeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function firstMessage(pending: Pending, signal: AbortSignal): Promise<ResponseStreamEvent> {
  const abort = () => closeConnection(pending.key, pending.connection, "aborted");
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      const item = await nextItem(pending);
      if (item.done) throw new Error("Responses WebSocket closed before response started");
      if (item.value.type === "error") throw item.value.error;
      if (item.value.type === "close") throw new Error(`Responses WebSocket closed (${item.value.code}): ${item.value.reason}`);
      if (item.value.type === "message") return item.value.message;
    }
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

function streamResponse(pending: Pending, first: ResponseStreamEvent, signal: AbortSignal): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: ResponseStreamEvent) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      const terminal = (event: ResponseStreamEvent) =>
        event.type === "response.completed" || event.type === "response.incomplete" || event.type === "response.failed";
      const abort = () => closeConnection(pending.key, pending.connection, "aborted");
      signal.addEventListener("abort", abort, { once: true });
      void (async () => {
        try {
          send(first);
          if (!terminal(first)) {
            while (true) {
              const item = await nextItem(pending);
              if (item.done) throw new Error("Responses WebSocket closed before response completed");
              if (item.value.type === "error") throw item.value.error;
              if (item.value.type === "close") throw new Error(`Responses WebSocket closed (${item.value.code}): ${item.value.reason}`);
              if (item.value.type !== "message") continue;
              send(item.value.message);
              if (terminal(item.value.message)) break;
            }
          }
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        } catch (error) {
          controller.error(error);
        } finally {
          signal.removeEventListener("abort", abort);
          await pending.iterator.return();
        }
      })();
    },
    async cancel() {
      closeConnection(pending.key, pending.connection, "cancelled");
      await pending.iterator.return();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

export type ResponsesWebSocketBridge = {
  fetch: typeof globalThis.fetch;
  finish(output: AssistantMessage): Promise<void>;
};

export function createResponsesWebSocketBridge(
  model: Model<"openai-responses">,
  options: BridgeOptions,
): ResponsesWebSocketBridge {
  let pending: Pending | undefined;
  const fallbackFetch = options.fetch ?? globalThis.fetch;
  const statusKey = transportKey(model.baseUrl, options.sessionId);

  return {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const fallbackRequest = request.clone();
      if (request.method !== "POST" || !new URL(request.url).pathname.replace(/\/+$/, "").endsWith("/responses")) {
        return fallbackFetch(fallbackRequest);
      }
      if (options.transport === "auto" && options.sessionId && autoSseFallbacks.has(statusKey)) {
        actualTransports.set(statusKey, "sse");
        return fallbackFetch(fallbackRequest);
      }

      const acquired = acquire(model, options, request.headers);
      const iterator = acquired.connection.ws.stream();
      pending = {
        ...acquired,
        idleTimeoutMs: options.timeoutMs,
        request: JSON.parse(await request.text()) as RequestBody,
        iterator,
      };
      const body = cacheEnabled(options) ? cachedBody(pending.connection, pending.request) : pending.request;
      pending.connection.ws.send({ type: "response.create", ...body } as ResponsesClientEvent);
      try {
        const first = await firstMessage(pending, request.signal);
        actualTransports.set(statusKey, cacheEnabled(options) ? "websocket-cached" : "websocket");
        return streamResponse(pending, first, request.signal);
      } catch (error) {
        closeConnection(pending.key, pending.connection, "request failed");
        pending = undefined;
        if (options.transport !== "auto" || request.signal.aborted) throw error;
        if (options.sessionId) autoSseFallbacks.add(statusKey);
        actualTransports.set(statusKey, "sse");
        return fallbackFetch(fallbackRequest);
      }
    },
    async finish(output) {
      if (!pending) return;
      if (output.stopReason !== "error" && output.stopReason !== "aborted" && output.responseId && cacheEnabled(options)) {
        const { convertResponsesMessages } = await import("@earendil-works/pi-ai/api/openai-responses-shared");
        const responseItems = convertResponsesMessages(model, { messages: [output] }, OPENAI_TOOL_CALL_PROVIDERS)
          .filter((item) => item.type !== "function_call_output" && item.type !== "custom_tool_call_output");
        pending.connection.continuation = { request: pending.request, responseId: output.responseId, responseItems };
      }
      if (output.stopReason === "error" || output.stopReason === "aborted") closeConnection(pending.key, pending.connection, "request failed");
      else release(pending);
      pending = undefined;
    },
  };
}

export function wrapResponsesWebSocketStream(
  source: AssistantMessageEventStream,
  bridge: ResponsesWebSocketBridge,
): AssistantMessageEventStream {
  const target = createAssistantMessageEventStream();
  void (async () => {
    try {
      for await (const event of source) {
        if (event.type === "done") await bridge.finish(event.message);
        else if (event.type === "error") await bridge.finish(event.error);
        target.push(event);
      }
    } catch (error) {
      const output = {
        role: "assistant",
        content: [],
        api: "openai-responses",
        provider: "openai-api-extension",
        model: "unknown",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "error",
        errorMessage: error instanceof Error ? error.message : String(error),
        timestamp: Date.now(),
      } as AssistantMessage;
      await bridge.finish(output);
      target.push({ type: "error", reason: "error", error: output });
    }
  })();
  return target;
}

export function redactAssistantStream(
  source: AssistantMessageEventStream,
  secret: string | undefined,
): AssistantMessageEventStream {
  if (!secret) return source;
  const target = createAssistantMessageEventStream();
  void (async () => {
    for await (const event of source) {
      if (event.type === "error" && event.error.errorMessage) {
        event.error.errorMessage = event.error.errorMessage.split(secret).join("[REDACTED]");
      }
      target.push(event);
    }
  })();
  return target;
}

export function getActualResponsesTransport(
  baseUrl: string,
  sessionId?: string,
): "sse" | "websocket" | "websocket-cached" | undefined {
  return actualTransports.get(transportKey(baseUrl, sessionId));
}

export function recordActualResponsesTransport(
  baseUrl: string,
  transport: "sse" | "websocket" | "websocket-cached",
  sessionId?: string,
): void {
  actualTransports.set(transportKey(baseUrl, sessionId), transport);
}

export function closeResponsesWebSockets(sessionId?: string): void {
  for (const [key, connection] of connections) {
    if (!sessionId || key.includes(`\0${sessionId}\0`)) closeConnection(key, connection, "session shutdown");
  }
  if (sessionId) {
    for (const key of autoSseFallbacks) if (key.endsWith(`\0${sessionId}`)) autoSseFallbacks.delete(key);
    for (const key of actualTransports.keys()) if (key.endsWith(`\0${sessionId}`)) actualTransports.delete(key);
  } else {
    autoSseFallbacks.clear();
    actualTransports.clear();
  }
}

registerSessionResourceCleanup(closeResponsesWebSockets);
