import { createHash } from "node:crypto";
import OpenAI from "openai";
import { ResponsesWS } from "openai/resources/responses/ws";
import type { ResponsesStreamMessage } from "openai/resources/responses/internal-base";
import type { ResponseInputItem, ResponseStreamEvent, ResponsesClientEvent } from "openai/resources/responses/responses";
import {
  type AssistantMessage,
  type AssistantMessageEventStream,
  createAssistantMessageEventStream,
  type Model,
  registerSessionResourceCleanup,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";

const SOCKET_TTL_MS = 5 * 60 * 1000;
const AUTO_SSE_COOLDOWN_MS = 15 * 1000;
const encoder = new TextEncoder();

type RequestBody = Omit<ResponsesClientEvent, "type"> & { input?: ResponseInputItem[]; stream?: boolean };
type Continuation = {
  request: RequestBody;
  responseId: string;
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
  reused: boolean;
  iterator: AsyncIterator<ResponsesStreamMessage>;
};

type BridgeOptions = Pick<
  SimpleStreamOptions,
  "apiKey" | "cacheRetention" | "fetch" | "sessionId" | "timeoutMs" | "transport" | "websocketConnectTimeoutMs"
>;

class ResponsesWebSocketResponseError extends Error {
  constructor(error: Error) {
    super(error.message);
    this.name = "ResponsesWebSocketResponseError";
  }
}

const connections = new Map<string, Connection>();
const autoSseFallbackUntil = new Map<string, number>();
const autoSseRecoveryInFlight = new Set<string>();
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

function websocketHeaders(headers: Headers): Record<string, string> {
  return Object.fromEntries([...headers].filter(([name]) => name !== "authorization"));
}

function createConnection(model: Model<"openai-responses">, options: BridgeOptions, headers: Headers): Connection {
  const apiKey = options.apiKey ?? headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  const client = new OpenAI({ apiKey, baseURL: model.baseUrl, maxRetries: 0 });
  return {
    ws: new ResponsesWS(client, {
      handshakeTimeout: options.websocketConnectTimeoutMs,
      headers: websocketHeaders(headers),
    }),
    busy: true,
  };
}

function acquire(
  model: Model<"openai-responses">,
  options: BridgeOptions,
  headers: Headers,
  forceFresh = false,
): Pick<Pending, "connection" | "key" | "keep" | "reused"> {
  const key = connectionKey(model, options, headers);
  const existing = !forceFresh && key ? connections.get(key) : undefined;
  if (existing && !existing.busy && existing.ws.socket.readyState === 1) {
    if (existing.timer) clearTimeout(existing.timer);
    existing.busy = true;
    return { connection: existing, key, keep: true, reused: true };
  }

  const connection = createConnection(model, options, headers);
  const keep = Boolean(key);
  if (key) connections.set(key, connection);
  return { connection, key, keep, reused: false };
}

function withoutInput(body: RequestBody): Omit<RequestBody, "input" | "previous_response_id"> {
  const { input: _input, previous_response_id: _previousResponseId, ...rest } = body;
  return rest;
}

function isAssistantResponseItem(item: ResponseInputItem): boolean {
  return (
    (item.type === "message" && item.role === "assistant") ||
    item.type === "reasoning" ||
    item.type === "function_call" ||
    item.type === "custom_tool_call"
  );
}

function cachedBody(connection: Connection, body: RequestBody): RequestBody {
  const previous = connection.continuation;
  if (!previous || JSON.stringify(withoutInput(body)) !== JSON.stringify(withoutInput(previous.request))) return body;
  const input = body.input ?? [];
  const previousInput = previous.request.input ?? [];
  if (input.length <= previousInput.length || JSON.stringify(input.slice(0, previousInput.length)) !== JSON.stringify(previousInput)) return body;
  let deltaStart = previousInput.length;
  if (!isAssistantResponseItem(input[deltaStart]!)) return body;
  while (deltaStart < input.length && isAssistantResponseItem(input[deltaStart]!)) deltaStart++;
  if (deltaStart >= input.length) return body;
  return { ...body, previous_response_id: previous.responseId, input: input.slice(deltaStart) } as RequestBody;
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
      if (item.value.type === "error") {
        if (item.value.error.error) throw new ResponsesWebSocketResponseError(item.value.error);
        throw item.value.error;
      }
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
          await pending.iterator.return?.();
        }
      })();
    },
    async cancel() {
      closeConnection(pending.key, pending.connection, "cancelled");
      await pending.iterator.return?.();
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
      let recoveryProbe = false;
      if (options.transport === "auto" && options.sessionId) {
        const fallbackUntil = autoSseFallbackUntil.get(statusKey);
        if (autoSseRecoveryInFlight.has(statusKey) || (fallbackUntil !== undefined && Date.now() < fallbackUntil)) {
          actualTransports.set(statusKey, "sse");
          return fallbackFetch(fallbackRequest);
        }
        if (fallbackUntil !== undefined) {
          autoSseFallbackUntil.delete(statusKey);
          autoSseRecoveryInFlight.add(statusKey);
          recoveryProbe = true;
        }
      }

      const requestBody = JSON.parse(await request.text()) as RequestBody;
      const attempt = async (
        acquired: Pick<Pending, "connection" | "key" | "keep" | "reused">,
        body: RequestBody,
      ): Promise<ResponseStreamEvent> => {
        const iterator = acquired.connection.ws.stream();
        pending = {
          ...acquired,
          idleTimeoutMs: options.timeoutMs,
          request: requestBody,
          iterator,
        };
        pending.connection.ws.send({ type: "response.create", ...body } as ResponsesClientEvent);
        return firstMessage(pending, request.signal);
      };

      try {
        const acquired = acquire(model, options, request.headers);
        let first: ResponseStreamEvent;
        try {
          const body = cacheEnabled(options) ? cachedBody(acquired.connection, requestBody) : requestBody;
          first = await attempt(acquired, body);
        } catch (error) {
          const failed = pending;
          if (
            options.transport !== "auto" ||
            request.signal.aborted ||
            !failed?.reused ||
            error instanceof ResponsesWebSocketResponseError
          ) throw error;
          // An OPEN cached socket can still be half-closed. Retry only that
          // cache-specific transport failure, once, with the full request.
          closeConnection(failed.key, failed.connection, "cached request failed");
          pending = undefined;
          const { previous_response_id: _previousResponseId, ...freshBody } = requestBody;
          first = await attempt(acquire(model, options, request.headers, true), freshBody);
        }
        if (recoveryProbe) autoSseRecoveryInFlight.delete(statusKey);
        autoSseFallbackUntil.delete(statusKey);
        actualTransports.set(statusKey, cacheEnabled(options) ? "websocket-cached" : "websocket");
        return streamResponse(pending!, first, request.signal);
      } catch (error) {
        if (pending) closeConnection(pending.key, pending.connection, "request failed");
        pending = undefined;
        if (recoveryProbe) autoSseRecoveryInFlight.delete(statusKey);
        if (options.transport !== "auto" || request.signal.aborted) throw error;
        if (options.sessionId) autoSseFallbackUntil.set(statusKey, Date.now() + AUTO_SSE_COOLDOWN_MS);
        actualTransports.set(statusKey, "sse");
        return fallbackFetch(fallbackRequest);
      }
    },
    async finish(output) {
      if (!pending) return;
      if (output.stopReason !== "error" && output.stopReason !== "aborted" && output.responseId && cacheEnabled(options)) {
        pending.connection.continuation = { request: pending.request, responseId: output.responseId };
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
    for (const key of autoSseFallbackUntil.keys()) if (key.endsWith(`\0${sessionId}`)) autoSseFallbackUntil.delete(key);
    for (const key of autoSseRecoveryInFlight) if (key.endsWith(`\0${sessionId}`)) autoSseRecoveryInFlight.delete(key);
    for (const key of actualTransports.keys()) if (key.endsWith(`\0${sessionId}`)) actualTransports.delete(key);
  } else {
    autoSseFallbackUntil.clear();
    autoSseRecoveryInFlight.clear();
    actualTransports.clear();
  }
}

registerSessionResourceCleanup(closeResponsesWebSockets);
