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

import { captureCheckpoint, hashCanonical, planCheckpoint, responseEventOutput, responseOutputItemsCapturable,
  type CheckpointCandidate, type ResponseCheckpoint } from "./response-checkpoints.ts";

const SOCKET_TTL_MS = 5 * 60 * 1000;
const AUTO_SSE_COOLDOWN_MS = 5 * 60 * 1000;
const encoder = new TextEncoder();
const MESSAGE_ID_REJECTION = "previous_response_id must be a response.id (resp_*), not a message id";

type RequestBody = Omit<ResponsesClientEvent, "type"> & { input?: ResponseInputItem[]; stream?: boolean };
type Continuation = {
  request: RequestBody;
  responseId: string;
  // Caller-owned roots can leave history only on the server.
  hasFullHistory: boolean;
  encodedOutput?: unknown[];
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
  hasFullHistory: boolean;
  iterator: AsyncIterator<ResponsesStreamMessage>;
  scopeHash?: string;
  completion?: Record<string, unknown>;
  onStreamError?: (error: unknown) => void;
};

type BridgeOptions = Pick<
  SimpleStreamOptions,
  "apiKey" | "cacheRetention" | "fetch" | "sessionId" | "timeoutMs" | "transport" | "websocketConnectTimeoutMs"
> & {
  headers?: SimpleStreamOptions["headers"];
  checkpoints?: {
    enabled: boolean;
    candidate?: CheckpointCandidate;
    encodeOutput(output: AssistantMessage): Promise<unknown[]>;
  };
  // Optional public host capability; stock Pi need not expose it.
  onTransport?: (transport: string | undefined, model: Model<"openai-responses">) => void | Promise<void>;
};

const connections = new Map<string, Connection>();
// Presence records a WS failure: 0 retries next request; a deadline enforces cooldown.
const autoSseFallbackUntil = new Map<string, number>();
const autoSseRecoveryInFlight = new Set<string>();
const actualTransports = new Map<string, "sse" | "websocket" | "websocket-cached">();
// Connection scopes where a cached continuation anchor was explicitly rejected
// as an invalid reference. Further requests on that scope keep full input
// instead of repeating the same rejected-anchor class every turn. Scoped to
// the connection key, never to an ID prefix or a whole endpoint family.
const rejectedContinuationKeys = new Set<string>();

function transportKey(baseUrl: string, sessionId?: string): string {
  return `${baseUrl}\0${sessionId ?? ""}`;
}

function cacheEnabled(options: BridgeOptions): boolean {
  return options.cacheRetention !== "none" && (options.transport === "auto" || options.transport === "websocket-cached");
}

function connectionKey(model: Model<"openai-responses">, options: BridgeOptions, headers: Headers): string | undefined {
  if (!cacheEnabled(options) || !options.sessionId) return undefined;
  const identity = createHash("sha256").update(JSON.stringify([options.apiKey, [...headers]])).digest("hex");
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
): Pick<Pending, "connection" | "key" | "keep"> {
  const key = connectionKey(model, options, headers);
  const existing = !forceFresh && key ? connections.get(key) : undefined;
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

class ResponsesWebSocketCloseError extends Error {
  code: number;
  reason: string;

  constructor(code: number, reason: string) {
    super(`Responses WebSocket closed (${code}): ${reason}`);
    this.code = code;
    this.reason = reason;
  }
}

// This exact ingress validation is known to reject before generation.
function isInvalidPreviousResponseIdError(error: unknown): boolean {
  if (error instanceof ResponsesWebSocketCloseError) {
    return error.code === 1008 && error.reason === MESSAGE_ID_REJECTION;
  }
  const event = error instanceof Error ? (error as { error?: unknown }).error : undefined;
  const detail = event && typeof event === "object"
    ? (event as { error?: { type?: unknown; code?: unknown; message?: unknown } }).error
    : undefined;
  return detail !== null && typeof detail === "object"
    && detail.message === MESSAGE_ID_REJECTION
    && detail.type === "invalid_request_error"
    && (detail.code == null || detail.code === "invalid_request" || detail.code === "invalid_request_error");
}

// Documented pre-execution retention miss, not a capability rejection.
function isMissingPreviousResponseError(error: unknown): boolean {
  const event = error instanceof Error ? (error as { error?: unknown }).error : undefined;
  if (!event || typeof event !== "object") return false;
  const detail = (event as { error?: { code?: unknown; type?: unknown } }).error;
  return detail?.code === "previous_response_not_found" && detail.type === "invalid_request_error";
}

async function checkpointScope(model: Model<"openai-responses">, options: BridgeOptions, request: Request): Promise<string> {
  const headers = new Headers(request.headers);
  const supplied = new Headers({ ...model.headers, ...options.headers } as HeadersInit);
  // Ignore only SDK-generated transport values; caller values stay in provenance.
  for (const name of ["x-client-request-id", "x-session-id", "session_id", "x-stainless-retry-count", "x-stainless-timeout"]) {
    if (!supplied.has(name)) headers.delete(name);
  }
  headers.delete("authorization"); // WS uses the OpenAI client's key, unlike HTTP.
  const credential = options.apiKey ?? request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  return hashCanonical({ adapter: "openai-api-extension/responses-v1", destination: model.baseUrl,
    requestUrl: request.url, protocol: "responses-websocket", credential,
    headers: Object.fromEntries(headers), suppliedHeaders: Object.fromEntries(supplied) });
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
  // Eligible nonpersistent continuations still prove the exact assistant prefix.
  if (previous.encodedOutput) {
    const end = previousInput.length + previous.encodedOutput.length;
    if (end >= input.length || JSON.stringify(input.slice(previousInput.length, end)) !== JSON.stringify(previous.encodedOutput)) return body;
    return { ...body, previous_response_id: previous.responseId, input: input.slice(end) } as RequestBody;
  }
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
      if (item.value.type === "error") throw item.value.error;
      if (item.value.type === "close") throw new ResponsesWebSocketCloseError(item.value.code, item.value.reason);
      if (item.value.type === "message") return item.value.message;
    }
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

function streamResponse(pending: Pending, first: ResponseStreamEvent, signal: AbortSignal): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: ResponseStreamEvent) => {
        if (event.type === "response.completed") pending.completion = event as unknown as Record<string, unknown>;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };
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
          pending.onStreamError?.(error);
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

/**
 * Storage/repair policy: [Response checkpoints](README.md#response-checkpoints).
 * Paired native adapter: https://github.com/xz-dev/pi/blob/patch/responses-websocket-transport/packages/ai/src/api/openai-responses-websocket.ts
 * Portable kernel: [response-checkpoints.ts](response-checkpoints.ts).
 */
export function createResponsesWebSocketBridge(
  model: Model<"openai-responses">,
  options: BridgeOptions,
): ResponsesWebSocketBridge {
  let pending: Pending | undefined;
  // Provider retries reuse this bridge; a failed repair must stay terminal.
  let terminalRepairFailure: { error: unknown } | undefined;
  const fallbackFetch = options.fetch ?? globalThis.fetch;
  const statusKey = transportKey(model.baseUrl, options.sessionId);
  const notifyTransport = async (transport: string) => {
    try { await options.onTransport?.(transport, model); } catch { /* observation must not cause inference replay */ }
  };
  let recoveryProbe = false;
  // Pi may retry fetch within one model request; SSE stays selected until it ends.
  let useSse = false;
  const recordFailure = () => {
    if (options.transport === "auto" && options.sessionId) {
      autoSseFallbackUntil.set(statusKey, autoSseFallbackUntil.has(statusKey) ? Date.now() + AUTO_SSE_COOLDOWN_MS : 0);
    }
  };

  return {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const fallbackRequest = request.clone();
      if (request.method !== "POST" || !new URL(request.url).pathname.replace(/\/+$/, "").endsWith("/responses")) {
        return fallbackFetch(fallbackRequest);
      }
      if (terminalRepairFailure) throw terminalRepairFailure.error;
      if (options.transport === "auto") {
        const fallbackUntil = autoSseFallbackUntil.get(statusKey);
        if (useSse || autoSseRecoveryInFlight.has(statusKey) || (fallbackUntil !== undefined && Date.now() < fallbackUntil)) {
          useSse = true;
          actualTransports.set(statusKey, "sse");
          await notifyTransport("SSE");
          return fallbackFetch(fallbackRequest);
        }
        if (fallbackUntil !== undefined) {
          autoSseRecoveryInFlight.add(statusKey);
          recoveryProbe = true;
        }
      }

      let referenceRepairAttempted = false;
      let durableSent = false;
      try {
        const requestBody = JSON.parse(await request.text()) as RequestBody;
        const { previous_response_id: _previousResponseId, ...withoutParent } = requestBody;
        const durable = options.checkpoints?.enabled === true;
        const fullBody = durable && requestBody.previous_response_id != null ? requestBody : withoutParent;
        const scopeHash = durable && requestBody.store === true ? await checkpointScope(model, options, request) : undefined;
        const candidate = options.checkpoints?.candidate;
        const plan = scopeHash && candidate ? await planCheckpoint({ request: requestBody as Record<string, unknown>,
          candidate, scopeHash, now: Date.now(), eligible: true }) : undefined;
        // A pre-execution rejection of the bridge-owned cached anchor may
        // retry once on a fresh WebSocket with the saved complete request and
        // the parent removed. Only an explicit invalid-reference rejection of
        // a bridge-owned previous_response_id qualifies: caller-owned
        // references fail closed, and ambiguous closes, partial output and
        // auth/policy failures never replay.
        let invalidRefRetry = !recoveryProbe;
        let stripRejectedParent = recoveryProbe;
        for (;;) {
          const acquired = acquire(model, options, request.headers, recoveryProbe);
          const iterator = acquired.connection.ws.stream();
          pending = {
            ...acquired,
            idleTimeoutMs: options.timeoutMs,
            request: requestBody,
            hasFullHistory: requestBody.previous_response_id == null,
            iterator,
            scopeHash,
            onStreamError: durable ? (error) => { terminalRepairFailure = { error }; } : undefined,
          };
          // Recovery must not reference state from the discarded connection,
          // and a scope that already rejected a cached anchor must not emit
          // another one on later turns.
          const anchorRejected = acquired.key !== undefined && rejectedContinuationKeys.has(acquired.key);
          // Preserve caller ancestry and proven nonpersistent continuations without durable planning.
          const inherited = durable && requestBody.previous_response_id == null
            && (acquired.connection.continuation?.hasFullHistory === false
              || (requestBody.store !== true && acquired.connection.continuation?.encodedOutput !== undefined))
            ? cachedBody(acquired.connection, requestBody) : undefined;
          const delta = recoveryProbe || stripRejectedParent || anchorRejected || !cacheEnabled(options)
            ? undefined
            : durable ? ((inherited !== requestBody ? inherited : undefined) ?? (plan?.request as RequestBody | undefined))
              : cachedBody(acquired.connection, requestBody);
          const body = recoveryProbe || stripRejectedParent ? fullBody : (delta ?? requestBody);
          // A parent is bridge-owned only when cachedBody rewrote the request
          // into a delta; a caller-supplied previous_response_id is never a
          // bridge-owned baseline.
          const bridgeOwnedParent = delta !== undefined && delta !== requestBody
            ? delta.previous_response_id
            : undefined;
          pending.hasFullHistory &&= bridgeOwnedParent === undefined || (durable && delta === plan?.request)
            || acquired.connection.continuation?.hasFullHistory === true;
          durableSent = durable;
          pending.connection.ws.send({ type: "response.create", ...body } as ResponsesClientEvent);
          try {
            const first = await firstMessage(pending, request.signal);
            actualTransports.set(statusKey, cacheEnabled(options) ? "websocket-cached" : "websocket");
            await notifyTransport(body.previous_response_id ? "WS/continuation" : "WS/full");
            return streamResponse(pending, first, request.signal);
          } catch (error) {
            const hasFullHistory = pending.hasFullHistory;
            closeConnection(pending.key, pending.connection, "request failed");
            pending = undefined;
            if (hasFullHistory && bridgeOwnedParent !== undefined
              && (isInvalidPreviousResponseIdError(error) || (durable && isMissingPreviousResponseError(error)))) {
              if (acquired.key && isInvalidPreviousResponseIdError(error)) rejectedContinuationKeys.add(acquired.key);
              if (invalidRefRetry && !request.signal.aborted) {
                invalidRefRetry = false;
                stripRejectedParent = true;
                referenceRepairAttempted = true;
                continue;
              }
            }
            throw error;
          }
        }
      } catch (error) {
        if (referenceRepairAttempted || durableSent) terminalRepairFailure = { error };
        if (pending) closeConnection(pending.key, pending.connection, "request failed");
        pending = undefined;
        if (recoveryProbe) autoSseRecoveryInFlight.delete(statusKey);
        if (durableSent || options.transport !== "auto" || request.signal.aborted) throw error;
        recordFailure();
        // A failed repair may already have generated; do not add an HTTP replay.
        if (referenceRepairAttempted) throw error;
        useSse = true;
        actualTransports.set(statusKey, "sse");
        await notifyTransport("SSE");
        return fallbackFetch(fallbackRequest);
      }
    },
    async finish(output) {
      if (!pending) return;
      const completed = responseEventOutput(pending.completion ?? {});
      let encodedOutput: unknown[] | undefined;
      if (options.checkpoints?.enabled && completed && completed.id === output.responseId) {
        try { encodedOutput = await options.checkpoints.encodeOutput(output); }
        catch { /* Unsupported host codec: no locally proven continuation. */ }
      }
      const outputComplete = encodedOutput !== undefined && completed !== undefined
        && responseOutputItemsCapturable(completed.output, encodedOutput);
      if (pending.scopeHash && pending.hasFullHistory && pending.request.store === true
        && (output.stopReason === "stop" || output.stopReason === "toolUse")) {
        try {
          if (completed && completed.store !== false && outputComplete) {
            const checkpoint = await captureCheckpoint({ request: pending.request as Record<string, unknown>,
              responseId: completed.id, encodedPrefix: [...(pending.request.input ?? []), ...encodedOutput!],
              scopeHash: pending.scopeHash, completed: true, stored: true, fullHistory: true, now: Date.now() });
            if (checkpoint) (output as AssistantMessage & { responseCheckpoint?: ResponseCheckpoint }).responseCheckpoint = checkpoint;
          }
        } catch { /* Unsupported host codec: full history stays canonical, no attestation. */ }
      }
      if (output.stopReason !== "error" && output.stopReason !== "aborted" && output.responseId && cacheEnabled(options)) {
        pending.connection.continuation = {
          request: pending.request,
          responseId: output.responseId,
          hasFullHistory: pending.hasFullHistory,
          ...(outputComplete ? { encodedOutput } : {}),
        };
      }
      if (output.stopReason === "error" || output.stopReason === "aborted") {
        closeConnection(pending.key, pending.connection, "request failed");
        if (output.stopReason === "error") recordFailure();
      } else {
        if (options.transport === "auto") autoSseFallbackUntil.delete(statusKey);
        release(pending);
      }
      if (recoveryProbe) autoSseRecoveryInFlight.delete(statusKey);
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
    for (const key of rejectedContinuationKeys) if (key.includes(`\0${sessionId}\0`)) rejectedContinuationKeys.delete(key);
  } else {
    autoSseFallbackUntil.clear();
    autoSseRecoveryInFlight.clear();
    actualTransports.clear();
    rejectedContinuationKeys.clear();
  }
}

registerSessionResourceCleanup(closeResponsesWebSockets);
