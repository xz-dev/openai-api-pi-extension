import { createHash } from "node:crypto";
import OpenAI from "openai";
import { ResponsesWS } from "openai/resources/responses/ws";
import type { NodeWebSocket } from "openai/internal/ws-adapter-node";
import { WebSocketError, type ResponsesStreamMessage } from "openai/resources/responses/internal-base";
import type { ResponseInputItem, ResponseStreamEvent, ResponsesClientEvent } from "openai/resources/responses/responses";
import {
  type AssistantMessage,
  type AssistantMessageEventStream,
  createAssistantMessageEventStream,
  appendAssistantMessageDiagnostic,
  type Model,
  registerSessionResourceCleanup,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { permitsFullHistory, recordResponseAncestry, responseHeaders, type ResponseAncestryState } from "./checkpoint-adapter.ts";
import { compressionFetch, getRequestCompressionEncoding, getWebSocketCompressionEncoding,
  getWebSocketCompressionPolicy, transportLabel } from "./request-compression.ts";

import { captureCheckpoint, hashCanonical, planCheckpoint, responseEventOutput, responseOutputItemsCapturable,
  type CheckpointCandidate, type ResponseCheckpoint } from "./response-checkpoints.ts";

const SOCKET_TTL_MS = 5 * 60 * 1000;
const ANCHOR_TTL_MS = 10 * 60 * 1000;
const MAX_ANCHORS = 32;
const AUTO_SSE_COOLDOWN_MS = 2 * 60 * 1000;
const MAX_COOLDOWN_MS = 5 * 60 * 1000;
const AUTO_WEBSOCKET_RETRIES = 3;
const CHECKPOINT_COOLDOWN_MS = AUTO_SSE_COOLDOWN_MS;
const encoder = new TextEncoder();
const MESSAGE_ID_REJECTION = "previous_response_id must be a response.id (resp_*), not a message id";

type RequestBody = Omit<ResponsesClientEvent, "type"> & { input?: ResponseInputItem[]; stream?: boolean };
type Continuation = {
  request: RequestBody;
  responseId: string;
  // Caller-owned roots can leave history only on the server.
  hasFullHistory: boolean;
  ancestry: ResponseAncestryState;
  encodedOutput?: unknown[];
  // Non-wire caller identity bound to this continuation's verified wire request.
  preparationScope?: string;
  requestUrl?: string;
  // Present only on a server-confirmed anchor carried across sockets.
  expiresAt?: number;
};
type Connection = {
  ws: ResponsesWS;
  transportCauses: Set<unknown>;
  busy: boolean;
  timer?: ReturnType<typeof setTimeout>;
  continuation?: Continuation;
  anchorGeneration: object;
};
type Pending = {
  connection: Connection;
  idleTimeoutMs?: number;
  key?: string;
  keep: boolean;
  request: RequestBody;
  hasFullHistory: boolean;
  ancestry: ResponseAncestryState;
  anchorGeneration: object;
  preparationScope?: string;
  requestUrl: string;
  iterator: AsyncIterator<ResponsesStreamMessage>;
  scopeHash?: string;
  // Whether the wire body actually carried the policy-owned store:true.
  sentStore?: boolean;
  // The socket reached OPEN, so a queued frame was flushed to the server.
  opened?: boolean;
  completion?: Record<string, unknown>;
  streamError?: unknown;
  onStreamError?: (error: unknown) => void;
  onSent?: () => void;
};

type BridgeOptions = Pick<
  SimpleStreamOptions,
  "apiKey" | "cacheRetention" | "fetch" | "sessionId" | "signal" | "timeoutMs" | "transport" | "websocketConnectTimeoutMs"
> & {
  headers?: SimpleStreamOptions["headers"];
  responseAncestry?: ResponseAncestryState;
  checkpoints?: {
    enabled: boolean;
    candidate?: CheckpointCandidate;
    encodeOutput(output: AssistantMessage): Promise<unknown[]>;
  };
  // Optional public host capability; stock Pi need not expose it.
  onTransport?: (transport: string | undefined, model: Model<"openai-responses">) => void | Promise<void>;
};

const connections = new Map<string, Connection>();
const anchors = new Map<string, Continuation>();
type WebSocketRecoveryState = {
  failures: number;
  retryAt: number;
  cooldownMs: number;
  nextCooldownMs: number;
  recovering: boolean;
};
const autoSseFallback = new Map<string, WebSocketRecoveryState>();
const actualTransports = new Map<string, "sse" | "websocket" | "websocket-cached">();
// Connection scopes where a cached continuation anchor was explicitly rejected
// as an invalid reference. Further requests on that scope keep full input
// instead of repeating the same rejected-anchor class every turn. Scoped to
// the connection key, never to an ID prefix or a whole endpoint family.
const rejectedContinuationKeys = new Set<string>();
type CheckpointCooldownState = {
  retryAt: number;
  cooldownMs: number;
  nextCooldownMs: number;
  probing: boolean;
};
type CheckpointProbe = { state: CheckpointCooldownState; attempted: boolean; failed: boolean };
// Independent checkpoint/transport progression; state objects preserve probe ownership.
const checkpointCooldown = new Map<string, CheckpointCooldownState>();

function transportKey(baseUrl: string, sessionId?: string): string {
  return `${baseUrl}\0${sessionId ?? ""}`;
}

function cacheEnabled(options: BridgeOptions): boolean {
  return options.cacheRetention !== "none" && (options.transport === "auto" || options.transport === "websocket-cached");
}

function effectiveResponseHeaders(model: Model<"openai-responses">, options: BridgeOptions, source?: Headers): Headers {
  const supplied = responseHeaders(model, options);
  const headers = new Headers(source ?? supplied);
  if (supplied.has("authorization")) headers.set("authorization", supplied.get("authorization")!);
  else if (supplied.has("cf-aig-authorization")) headers.delete("authorization");
  else if (!headers.has("authorization") && !headers.has("cf-aig-authorization") && options.apiKey) headers.set("authorization", `Bearer ${options.apiKey}`);
  if (supplied.has("cf-aig-authorization")) headers.set("cf-aig-authorization", supplied.get("cf-aig-authorization")!);
  return headers;
}

function preparationScopeKey(model: Model<"openai-responses">, options: BridgeOptions, wire?: Headers): string | undefined {
  if (!cacheEnabled(options) || !options.sessionId) return undefined;
  const headers = effectiveResponseHeaders(model, options);
  if (!headers.has("authorization") && !headers.has("cf-aig-authorization")) return undefined;
  if (wire && [...headers].some(([name, value]) => wire.get(name) !== value)) return undefined;
  return `${transportKey(model.baseUrl, options.sessionId)}\0${createHash("sha256").update(JSON.stringify({ model: [model.provider, model.api, model.id], headers: [...headers] })).digest("hex")}`;
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
  if (pending.keep && pending.key && connections.get(pending.key) === pending.connection) {
    pending.connection.busy = false;
    pending.connection.timer = setTimeout(() => {
      if (!pending.connection.busy) closeConnection(pending.key, pending.connection, "idle timeout");
    }, SOCKET_TTL_MS);
  } else {
    // A busy pooled entry overtaken by a replacement connection is
    // unreachable: close it rather than leaking the socket.
    closeConnection(pending.key, pending.connection, "complete");
  }
}

function websocketHeaders(headers: Headers): Record<string, string> {
  const supplied = Object.fromEntries([...headers].filter(([name]) => name !== "authorization"));
  // Match SDK authHeaders casing: supplied auth must replace, never duplicate it.
  const authorization = headers.get("authorization");
  return authorization === null ? supplied : { ...supplied, Authorization: authorization };
}

type CompressionPolicy = Awaited<ReturnType<typeof getWebSocketCompressionPolicy>>;

function createConnection(model: Model<"openai-responses">, options: BridgeOptions, headers: Headers, compression: CompressionPolicy, key: string | undefined): Connection {
  const apiKey = headers.get("authorization")?.replace(/^Bearer\s+/i, "")
    ?? (headers.has("cf-aig-authorization") ? "" : options.apiKey);
  const client = new OpenAI({ apiKey: apiKey || "unused", baseURL: model.baseUrl, maxRetries: 0 });
  // SDK constructor requires a key; alternate credential must not emit a dummy bearer.
  if (headers.has("cf-aig-authorization") && !headers.has("authorization")) client.apiKey = null;
  const ws = new ResponsesWS(client, {
    handshakeTimeout: options.websocketConnectTimeoutMs,
    headers: websocketHeaders(headers),
    perMessageDeflate: compression.perMessageDeflate,
  });
  // SDK merges API, local and socket errors into WebSocketError; tag only real I/O causes.
  const transportCauses = new Set<unknown>();
  ws.socket.on("error", (error) => transportCauses.add(error));
  const send = ws.socket.send.bind(ws.socket);
  ws.socket.send = (data) => {
    try { send(data); }
    catch (error) { transportCauses.add(error); throw error; }
  };
  ws.socket.once("open", () => compression.recordNegotiated((ws.socket as NodeWebSocket).platformSocket.extensions));
  const connection: Connection = { ws, transportCauses, busy: true, anchorGeneration: {} };
  // The request iterator drops its error listener on cleanup; the connection must still own late errors.
  ws.on("error", () => closeConnection(key, connection, "socket error"));
  return connection;
}

function acquire(
  model: Model<"openai-responses">,
  options: BridgeOptions,
  headers: Headers,
  compression: CompressionPolicy,
  forceFresh = false,
): Pick<Pending, "connection" | "key" | "keep"> {
  const key = connectionKey(model, options, headers);
  const existing = key ? connections.get(key) : undefined;
  if (!forceFresh && existing && !existing.busy && existing.ws.socket.readyState === 1) {
    if (existing.timer) clearTimeout(existing.timer);
    existing.busy = true;
    return { connection: existing, key, keep: true };
  }
  if (existing && !existing.busy) closeConnection(key, existing, "reconnect");

  const connection = createConnection(model, options, headers, compression, key);
  const anchor = key ? anchors.get(key) : undefined;
  if (anchor && anchor.expiresAt! <= Date.now()) anchors.delete(key!);
  else if (!forceFresh) connection.continuation = anchor;
  const keep = Boolean(key);
  if (key) connections.set(key, connection);
  return { connection, key, keep };
}

class ResponsesWebSocketTransportError extends Error {}

function socketError(pending: Pending, error: unknown): unknown {
  if (error instanceof WebSocketError && error.error === undefined
    && (pending.connection.transportCauses.has(error.cause)
      || (error.cause === undefined && pending.connection.ws.socket.readyState >= 2))) {
    return new ResponsesWebSocketTransportError(error.message, { cause: error });
  }
  return error;
}

function isConnectionLimitError(error: unknown): boolean {
  const event = error instanceof Error ? (error as { error?: Record<string, unknown> }).error : undefined;
  if (!event || typeof event !== "object") return false;
  const nested = event.error && typeof event.error === "object" ? event.error as Record<string, unknown> : undefined;
  const code = typeof event.code === "string" ? event.code : nested?.code;
  return code === "websocket_connection_limit_reached";
}

class ResponsesWebSocketCloseError extends ResponsesWebSocketTransportError {
  code: number;
  reason: string;

  constructor(code: number, reason: string) {
    super(`Responses WebSocket closed (${code}): ${reason}`);
    this.code = code;
    this.reason = reason;
  }
}

// Any status other than 400, a non-invalid-request type or an auth-like code
// anywhere in the envelope makes the legacy message-ID rejection ambiguous.
function hasConflictingEvidence(error: unknown): boolean {
  if (error instanceof ResponsesWebSocketCloseError) return false; // exact WS1008 signature only
  const event = error instanceof Error ? (error as { error?: unknown }).error : undefined;
  if (!event || typeof event !== "object") return true;
  const frame = event as Record<string, unknown>;
  const detail = frame.error && typeof frame.error === "object" ? frame.error as Record<string, unknown> : {};
  return [frame.status, detail.status].some((status) => typeof status === "number" && status !== 400)
    || (typeof detail.type === "string" && detail.type !== "invalid_request_error")
    || [frame.code, detail.code].some((code) => typeof code === "string"
      && code !== "invalid_request" && code !== "invalid_request_error");
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

const REJECTION_WORDING = /unsupported|not supported|unknown|invalid|not allowed|unrecognized/i;
const REFERENCE_UNAVAILABLE = /previous_response_id[^\n]*not available|previous[ _]response[^\n]*not found/i;

// The four checkpoint failure signals (spec B), mirroring the native owner:
// the coded retention miss; Sub2API's code-less "previous_response_id is not
// available"; a store-parameter rejection; a previous_response_id capability
// rejection. Every fence runs first: a non-400 status, a non-invalid-request
// type or an unrelated code (auth, quota, server error) never replays.
function isCheckpointReferenceFailure(error: unknown): boolean {
  const event = error instanceof Error ? (error as { error?: unknown }).error : undefined;
  if (!event || typeof event !== "object") return false;
  const object = (value: unknown) => value && typeof value === "object" ? value as Record<string, unknown> : undefined;
  const frame = event as Record<string, unknown>;
  const detail = object(frame.error);
  if (!detail) return false;
  // Read every envelope location; any disagreement is conflicting evidence.
  const envelopes = [frame, detail, object(object(frame.response)?.error)].filter((entry) => entry !== undefined);
  const values = (field: string, kind: "string" | "number") => envelopes.map((entry) => entry[field])
    .filter((value) => typeof value === kind && !(field === "type" && (value === "error" || value === "response.failed")));
  const statuses = values("status", "number");
  const types = values("type", "string");
  const codes = new Set(values("code", "string"));
  const params = new Set(values("param", "string"));
  if (statuses.some((status) => status !== 400)) return false;
  if (types.some((type) => type !== "invalid_request_error")) return false;
  if (codes.size > 1 || params.size > 1) return false;
  const [code] = codes;
  const [param] = params;
  const message = typeof detail.message === "string" ? detail.message : "";
  const checkpointParam = param === "store" || param === "previous_response_id";
  if (code === "unsupported_parameter" || code === "unknown_parameter") return checkpointParam;
  if (code !== undefined) return code === "previous_response_not_found";
  // Code-less shapes must positively prove an invalid-request rejection.
  if (statuses.length === 0 && types.length === 0) return false;
  if (checkpointParam) return REJECTION_WORDING.test(message) || REFERENCE_UNAVAILABLE.test(message);
  return REFERENCE_UNAVAILABLE.test(message)
    || (/\bstore\b/i.test(message) && REJECTION_WORDING.test(message))
    || (/\bprevious_response_id\b/i.test(message) && REJECTION_WORDING.test(message));
}

async function checkpointScope(model: Model<"openai-responses">, options: BridgeOptions, request: Request): Promise<string> {
  const headers = new Headers(request.headers);
  const supplied = responseHeaders(model, options);
  // Ignore only SDK-generated transport values; caller values stay in provenance.
  for (const name of ["x-client-request-id", "x-session-id", "session_id", "x-stainless-retry-count", "x-stainless-timeout"]) {
    if (!supplied.has(name)) headers.delete(name);
  }
  const credential = headers.get("authorization") ?? headers.get("cf-aig-authorization") ?? "";
  headers.delete("authorization");
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

function cachedBody(connection: Pick<Connection, "continuation">, body: RequestBody): RequestBody {
  const previous = connection.continuation;
  if (!previous || (previous.expiresAt !== undefined && (previous.expiresAt <= Date.now() || body.previous_response_id != null))
    || JSON.stringify(withoutInput(body)) !== JSON.stringify(withoutInput(previous.request))) return body;
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

function lineageBody(previous: Continuation | undefined, body: RequestBody, options: BridgeOptions,
  ancestry: ResponseAncestryState): RequestBody | undefined {
  const latest = options.checkpoints?.candidate;
  if (!previous || !cacheEnabled(options)
    || (Object.hasOwn(options.checkpoints ?? {}, "candidate") && latest?.responseId !== previous.responseId)
    || (!permitsFullHistory(ancestry) && previous.encodedOutput === undefined)) return undefined;
  const { store: _previousStore, ...previousRequest } = previous.request;
  const { store: _requestStore, ...unstored } = body;
  const chained = cachedBody({ continuation: { ...previous, request: previousRequest } }, unstored);
  return chained.previous_response_id == null ? undefined : chained;
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
          reject(new ResponsesWebSocketTransportError(`Responses WebSocket idle timeout after ${pending.idleTimeoutMs}ms`));
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
      if (item.done) throw new ResponsesWebSocketTransportError("Responses WebSocket closed before response started");
      if (item.value.type === "open") { pending.opened = true; pending.onSent?.(); }
      if (item.value.type === "error") throw socketError(pending, item.value.error);
      if (item.value.type === "raw") throw new Error("Invalid Responses WebSocket frame");
      if (item.value.type === "close") throw new ResponsesWebSocketCloseError(item.value.code, item.value.reason);
      if (item.value.type === "message") {
        const message = item.value.message as { type?: string; response?: { error?: unknown; status?: unknown } };
        // A first-frame response.failed is a pre-output rejection: classify it like an error event.
        // Other response.failed frames keep the original stream path (no replay).
        if (message.type === "response.failed" && message.response?.error) {
          // Keep the frame-level status/code so conflicting evidence is still fenced.
          const { response: _response, type: _type, ...frame } = message as Record<string, unknown>;
          const failure = Object.assign(new Error("Responses request failed"), { error: { ...frame, error: message.response.error } });
          if (isCheckpointReferenceFailure(failure) || isConnectionLimitError(failure)) throw failure;
        }
        return item.value.message;
      }
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
              if (item.done) throw new ResponsesWebSocketTransportError("Responses WebSocket closed before response completed");
              if (item.value.type === "error") throw socketError(pending, item.value.error);
              if (item.value.type === "raw") throw new Error("Invalid Responses WebSocket frame");
              if (item.value.type === "close") throw new ResponsesWebSocketCloseError(item.value.code, item.value.reason);
              if (item.value.type !== "message") continue;
              send(item.value.message);
              if (terminal(item.value.message)) break;
            }
          }
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        } catch (error) {
          pending.streamError = error;
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
  /** Internal public-payload-hook preparation; no I/O or host guard exemption. */
  prepare(payload: unknown, prepareRequest?: (payload: unknown) => Promise<Request>): unknown | Promise<unknown>;
  observeProviderEvent(event: unknown): void;
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
  let wireAncestry = options.responseAncestry ?? "legacy";
  // Provider retries reuse this bridge; a failed repair must stay terminal.
  let terminalRepairFailure: { error: unknown; response?: () => Response } | undefined;
  let referenceRepairAttempted = false;
  let referenceRepairStarted = false;
  let prepared: { full: RequestBody; payload: RequestBody; chain: RequestBody; key: string; scope: string; previous: Continuation;
    connection?: Connection; generation?: object } | undefined;
  let coldPrepared: { full: RequestBody; payload: RequestBody; plan: NonNullable<Awaited<ReturnType<typeof planCheckpoint>>>;
    key: string; scopeHash: string; requestUrl: string; candidate: string } | undefined;
  const coldEligible = (key: string) => {
    const cooldown = checkpointCooldown.get(key);
    const fallback = options.transport === "auto" ? autoSseFallback.get(key) : undefined;
    return options.checkpoints?.enabled === true && (!cooldown || (Date.now() >= cooldown.retryAt && !cooldown.probing))
      && (!fallback || (!fallback.recovering && Date.now() >= fallback.retryAt));
  };
  let connectionLimitRetried = false;
  // Compression applies only at the real HTTP send; WS/JSON bridge input stays raw.
  const fallbackFetch = compressionFetch(options.fetch ?? globalThis.fetch);
  const statusKey = transportKey(model.baseUrl, options.sessionId);
  // Both recovery policies bind to effective wire identity, never an unused API key.
  let checkpointKey = statusKey;
  let anchorKey: string | undefined;
  const clearAnchor = (retireLineage = false) => {
    if (!anchorKey) return;
    anchors.delete(anchorKey);
    const connection = connections.get(anchorKey);
    if (connection) {
      connection.anchorGeneration = {};
      if (retireLineage || connection.continuation?.expiresAt !== undefined) connection.continuation = undefined;
    }
  };
  const bindCheckpointKey = (headers: Headers) => {
    checkpointKey = `${statusKey}\0${createHash("sha256").update(JSON.stringify([...headers])).digest("hex")}`;
    // Invalidation follows identity even when SSE/uncached policy forbids reuse.
    anchorKey = options.sessionId ? checkpointKey : undefined;
  };
  const notifyTransport = async (transport: string) => {
    try { await options.onTransport?.(transport, model); } catch { /* observation must not cause inference replay */ }
  };
  let recoveryState: WebSocketRecoveryState | undefined;
  let recoveryProbe = false;
  // Pi may retry fetch within one model request; SSE stays selected until it ends.
  let useSse = false;
  let checkpointProbe: CheckpointProbe | undefined;
  const releaseProbes = () => {
    if (recoveryState) recoveryState.recovering = false;
    recoveryState = undefined;
    if (checkpointProbe) checkpointProbe.state.probing = false;
    checkpointProbe = undefined;
  };
  const resolveCheckpoints = (policyStore: boolean): boolean => {
    if (options.checkpoints?.enabled !== true) return false;
    if (!options.sessionId) return true;
    const state = checkpointCooldown.get(checkpointKey);
    if (!state) return true;
    // A hook store:false never claims the probe; cooldown still forces full context.
    if (!policyStore || Date.now() < state.retryAt || state.probing) return false;
    state.probing = true;
    checkpointProbe = { state, attempted: false, failed: false };
    return true;
  };
  const openCheckpointCooldown = () => {
    clearAnchor();
    if (!options.sessionId) return;
    let state = checkpointCooldown.get(checkpointKey);
    if (!state) {
      state = { retryAt: 0, cooldownMs: CHECKPOINT_COOLDOWN_MS, nextCooldownMs: CHECKPOINT_COOLDOWN_MS, probing: false };
      checkpointCooldown.set(checkpointKey, state);
    }
    const advance = checkpointProbe?.state === state && checkpointProbe.attempted && !checkpointProbe.failed;
    if (checkpointProbe?.attempted) checkpointProbe.failed = true;
    // Rejection and its repair are one logical probe; late failures only renew.
    if (state.retryAt === 0 || advance) {
      state.cooldownMs = state.nextCooldownMs;
      state.nextCooldownMs = Math.min(state.cooldownMs + 60_000, MAX_COOLDOWN_MS);
    }
    state.retryAt = Date.now() + state.cooldownMs;
  };
  const recordFailure = () => {
    if (options.transport !== "auto" || !options.sessionId) return undefined;
    clearAnchor();
    let state = autoSseFallback.get(checkpointKey);
    if (!state) {
      state = { failures: 0, retryAt: 0, cooldownMs: AUTO_SSE_COOLDOWN_MS, nextCooldownMs: AUTO_SSE_COOLDOWN_MS, recovering: false };
      autoSseFallback.set(checkpointKey, state);
    }
    state.failures++;
    if (state.retryAt > 0 || state.failures > AUTO_WEBSOCKET_RETRIES) {
      if (state.retryAt === 0 || (recoveryProbe && recoveryState === state)) {
        state.cooldownMs = state.nextCooldownMs;
        state.nextCooldownMs = Math.min(state.cooldownMs + 60_000, MAX_COOLDOWN_MS);
      }
      state.retryAt = Date.now() + state.cooldownMs;
    }
    return state;
  };

  // SSE is a hard checkpoint gate: drop the policy-owned store:true (a hook's
  // explicit store:false and a caller parent pass through unchanged).
  const sseFetch = async (fallbackRequest: Request, input?: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(await fallbackRequest.text()) as RequestBody;
    wireAncestry = body.previous_response_id != null ? "server-dependent" : options.responseAncestry ?? "legacy";
    if (body.previous_response_id != null) clearAnchor(true);
    else if (!permitsFullHistory(wireAncestry)) {
      const error = new Error("Cannot continue server-dependent or unknown response ancestry without a validated parent");
      terminalRepairFailure = { error };
      throw error;
    }
    if (options.checkpoints?.enabled === true && body.store === true) delete body.store;
    const wireRequest = new Request(fallbackRequest, { body: JSON.stringify(body) });
    // Preserve the SDK's URL/init send shape for caller fetch and shared compression.
    const response = input === undefined ? await fallbackFetch(wireRequest)
      : await fallbackFetch(input, { ...init, headers: wireRequest.headers, body: JSON.stringify(body) });
    await notifyTransport(transportLabel("SSE", getRequestCompressionEncoding(response)));
    return response;
  };

  return {
    prepare(payload, prepareRequest) {
      if (terminalRepairFailure) throw terminalRepairFailure.error;
      if (coldPrepared) {
        if (JSON.stringify(payload) === JSON.stringify(coldPrepared.payload)) return payload;
        if (JSON.stringify(payload) !== JSON.stringify(coldPrepared.full)) {
          const error = new Error("Prepared continuation changed before transport");
          terminalRepairFailure = { error };
          throw error;
        }
      }
      if (prepared) {
        if (JSON.stringify(payload) === JSON.stringify(prepared.payload)) return payload;
        if (JSON.stringify(payload) !== JSON.stringify(prepared.full)) {
          const error = new Error("Prepared continuation changed before transport");
          terminalRepairFailure = { error };
          throw error;
        }
      }
      if (!payload || typeof payload !== "object" || Array.isArray(payload)
        || permitsFullHistory(options.responseAncestry ?? "legacy") || options.transport === "sse"
        || !options.checkpoints?.candidate || (payload as RequestBody).previous_response_id != null) return payload;
      const scope = preparationScopeKey(model, options);
      if (!scope) return payload;
      const full = JSON.parse(JSON.stringify(payload)) as RequestBody;
      let selected: typeof prepared;
      const keys = new Set([...connections.keys(), ...anchors.keys()]);
      for (const key of keys) {
        if (!key.startsWith(`${statusKey}\0`) || (options.transport === "auto" && autoSseFallback.has(key))) continue;
        const connection = connections.get(key);
        const live = connection && !connection.busy && connection.ws.socket.readyState === 1 && connection.continuation;
        const previous = live ? connection.continuation : anchors.get(key);
        if (!previous || !previous.requestUrl || previous.preparationScope !== scope
          || (previous.expiresAt !== undefined && previous.expiresAt <= Date.now())
          || (previous.expiresAt !== undefined && options.checkpoints.enabled && checkpointCooldown.has(key))) continue;
        const chain = lineageBody(previous, full, options, options.responseAncestry ?? "legacy");
        if (!chain) continue;
        if (selected) return payload; // Different complete wire identities are not interchangeable.
        selected = { full, payload: { ...full, previous_response_id: chain.previous_response_id },
          chain: JSON.parse(JSON.stringify(chain)), key, scope, previous,
          ...(live ? { connection, generation: connection.anchorGeneration } : {}) };
      }
      if (!selected) {
        if (!prepareRequest || full.store !== true || options.checkpoints?.enabled !== true) return payload;
        return (async () => {
          const initial = await prepareRequest(full);
          initial.signal.throwIfAborted();
          const request = new Request(initial, { headers: effectiveResponseHeaders(model, options, initial.headers) });
          const key = connectionKey(model, options, request.headers);
          if (!key || !coldEligible(key) || request.method !== "POST"
            || !new URL(request.url).pathname.replace(/\/+$/, "").endsWith("/responses")) return payload;
          const scopeHash = await checkpointScope(model, options, request);
          const candidate = JSON.stringify(options.checkpoints!.candidate);
          const plan = await planCheckpoint({ request: full as Record<string, unknown>,
            candidate: options.checkpoints!.candidate!, scopeHash, now: Date.now(), eligible: true });
          if (!plan || !coldEligible(key)) return payload;
          const planned = { ...full, previous_response_id: plan.request.previous_response_id } as RequestBody;
          coldPrepared = { full, payload: planned, plan, key, scopeHash, requestUrl: request.url, candidate };
          return JSON.parse(JSON.stringify(planned));
        })();
      }
      prepared = selected;
      // Retain independent snapshots: later payload hooks cannot mutate validation evidence.
      return JSON.parse(JSON.stringify(selected.payload));
    },
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      let request = new Request(input, init);
      const headers = effectiveResponseHeaders(model, options, request.headers);
      request = new Request(request, { headers });
      const responseRequest = request.method === "POST" && new URL(request.url).pathname.replace(/\/+$/, "").endsWith("/responses");
      if (!responseRequest && !prepared && !coldPrepared) return fallbackFetch(request.clone());
      if (terminalRepairFailure) {
        if (terminalRepairFailure.response && !request.signal.aborted) return terminalRepairFailure.response();
        throw terminalRepairFailure.error;
      }
      if (coldPrepared) {
        try {
          request.signal.throwIfAborted();
          const received = JSON.parse(await request.clone().text()) as RequestBody;
          const scopeHash = await checkpointScope(model, options, request);
          const plan = await planCheckpoint({ request: coldPrepared.full as Record<string, unknown>,
            candidate: options.checkpoints!.candidate!, scopeHash, now: Date.now(), eligible: true });
          if (!responseRequest || request.url !== coldPrepared.requestUrl || !coldEligible(coldPrepared.key)
            || connectionKey(model, options, headers) !== coldPrepared.key || scopeHash !== coldPrepared.scopeHash
            || JSON.stringify(options.checkpoints?.candidate) !== coldPrepared.candidate
            || JSON.stringify(received) !== JSON.stringify(coldPrepared.payload)
            || JSON.stringify(plan) !== JSON.stringify(coldPrepared.plan)) throw new Error("Prepared continuation changed before transport");
          request = new Request(request, { body: JSON.stringify(coldPrepared.full) });
        } catch (error) {
          terminalRepairFailure = { error };
          throw error;
        }
      }
      if (prepared) {
        try {
          if (!responseRequest) throw new Error("Prepared continuation changed before transport");
          const received = JSON.parse(await request.clone().text()) as RequestBody;
          const originValid = prepared.connection
            ? connections.get(prepared.key) === prepared.connection && !prepared.connection.busy
              && prepared.connection.ws.socket.readyState === 1 && prepared.connection.continuation === prepared.previous
              && prepared.connection.anchorGeneration === prepared.generation
            : anchors.get(prepared.key) === prepared.previous && prepared.previous.expiresAt! > Date.now();
          const chain = lineageBody(prepared.previous, prepared.full, options, options.responseAncestry ?? "legacy");
          if (!originValid || request.url !== prepared.previous.requestUrl || connectionKey(model, options, headers) !== prepared.key
            || preparationScopeKey(model, options, headers) !== prepared.scope
            || JSON.stringify(received) !== JSON.stringify(prepared.payload)
            || JSON.stringify(chain) !== JSON.stringify(prepared.chain)) throw new Error("Prepared continuation changed before transport");
          // The SDK saw a real validated parent; bridge planning still owns the original full request.
          request = new Request(request, { body: JSON.stringify(prepared.full) });
        } catch (error) {
          terminalRepairFailure = { error };
          throw error;
        }
      }
      const fallbackRequest = request.clone();
      bindCheckpointKey(request.headers);
      if (options.transport === "sse") {
        actualTransports.set(statusKey, "sse");
        return sseFetch(fallbackRequest, input, init);
      }
      if (options.transport === "auto") {
        const state = autoSseFallback.get(checkpointKey);
        if (useSse || (state?.recovering && state !== recoveryState) || (state && Date.now() < state.retryAt)) {
          useSse = true;
          clearAnchor();
          actualTransports.set(statusKey, "sse");
          return sseFetch(fallbackRequest);
        }
        recoveryState = state;
        recoveryProbe = (state?.retryAt ?? 0) > 0;
        if (state) state.recovering = true;
      }

      let connectionLimitFailure = false;
      // Stored reconnects allow only the explicit reference repair, never HTTP replay.
      let storedAnchorAttempted = false;
      // Durable intent reached the wire: fences provider retries regardless
      // of whether the server accepted the request.
      let durableSent = false;
      // The server accepted a request on this fetch (first event arrived):
      // only then may checkpoint eligibility suppress the SSE fallback.
      let wireAccepted = false;
      // Checkpoint failure signals seen on this fetch (first failure only).
      let checkpointFailedSignal: unknown;
      let checkpointIntentSent = false;
      // true when resolveCheckpoints() suppressed checkpoints for this request
      // (cooldown active); distinct from policy-disabled, whose wire body keeps
      // the SDK-default store value verbatim.
      let cooldownSuppressed = false;
      try {
        const requestBody = JSON.parse(await request.text()) as RequestBody;
        wireAncestry = options.responseAncestry ?? "legacy";
        const { previous_response_id: _previousResponseId, store: _policyStore, ...strippedBody } = requestBody;
        // Keep a hook's explicit store:false (privacy veto); only policy store:true is dropped.
        const bareBody: RequestBody = requestBody.store === false ? { ...strippedBody, store: false } : strippedBody;
        request.signal.throwIfAborted();
        const durable = resolveCheckpoints(requestBody.store === true);
        cooldownSuppressed = options.checkpoints?.enabled === true && !durable;
        if (cooldownSuppressed || checkpointProbe || recoveryProbe) clearAnchor();
        const fullBody = durable && requestBody.previous_response_id != null ? requestBody : bareBody;
        // Repair/cooldown body: full history, no previous_response_id, policy
        // store omitted (a hook's explicit store:false is kept).
        const repairBody = bareBody;
        // Cooldown body: a caller-owned parent keeps its lineage (hasFullHistory stays false).
        const cooldownBody: RequestBody = requestBody.previous_response_id != null
          ? { ...bareBody, previous_response_id: requestBody.previous_response_id } : bareBody;
        const scopeHash = durable && requestBody.store === true ? await checkpointScope(model, options, request) : undefined;
        const candidate = durable ? options.checkpoints?.candidate : undefined;
        const plan = scopeHash && candidate ? await planCheckpoint({ request: requestBody as Record<string, unknown>,
          candidate, scopeHash, now: Date.now(), eligible: true }) : undefined;
        // A pre-execution rejection of the bridge-owned cached anchor may
        // retry once on a fresh WebSocket with the saved complete request and
        // the parent removed. Only an explicit invalid-reference rejection of
        // a bridge-owned previous_response_id qualifies: caller-owned
        // references fail closed, and ambiguous closes, partial output and
        // auth/policy failures never replay.
        let invalidRefRetry = true;
        let stripRejectedParent = false;
        for (;;) {
          const socketUrl = new URL(request.url);
          socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";
          const compressionHeaders = new Headers(request.headers);
          // Host helper keys Authorization; alias alternate auth for identity only, never on wire.
          if (!compressionHeaders.has("authorization") && compressionHeaders.has("cf-aig-authorization")) {
            compressionHeaders.set("authorization", compressionHeaders.get("cf-aig-authorization")!);
          }
          const compression = await getWebSocketCompressionPolicy(socketUrl.toString(), compressionHeaders);
          // Resolve policy before entering the synchronous connection-pool critical section.
          const acquired = acquire(model, options, request.headers, compression, recoveryState !== undefined || connectionLimitRetried);
          const iterator = acquired.connection.ws.stream();
          pending = {
            ...acquired,
            idleTimeoutMs: options.timeoutMs,
            request: requestBody,
            hasFullHistory: permitsFullHistory(wireAncestry),
            ancestry: wireAncestry,
            anchorGeneration: acquired.connection.anchorGeneration,
            preparationScope: preparationScopeKey(model, options, request.headers),
            requestUrl: request.url,
            iterator,
            scopeHash,
            // Every accepted attempt belongs to this logical request, including a replacement repair.
            onStreamError: (error) => { terminalRepairFailure = { error }; },
            onSent: () => { if (checkpointProbe && pending?.sentStore) checkpointProbe.attempted = true; },
          };
          // Recovery must not reference state from the discarded connection,
          // and a scope that already rejected a cached anchor must not emit
          // another one on later turns.
          const anchorRejected = acquired.key !== undefined && rejectedContinuationKeys.has(acquired.key);
          // Preserve caller ancestry and proven nonpersistent continuations without durable planning.
          const inherited = durable && requestBody.previous_response_id == null
            && (acquired.connection.continuation?.hasFullHistory === false
              || acquired.connection.continuation?.expiresAt !== undefined
              || (requestBody.store !== true && acquired.connection.continuation?.encodedOutput !== undefined))
            ? cachedBody(acquired.connection, requestBody) : undefined;
          const delta = recoveryState !== undefined || stripRejectedParent || anchorRejected || !cacheEnabled(options)
            ? undefined
            : durable ? ((inherited !== requestBody ? inherited : undefined) ?? (plan?.request as RequestBody | undefined))
              : cachedBody(acquired.connection, requestBody);
          // Cooldown keeps checkpoints fully off: full history, no store, no
          // parent — even though the payload hook already set store:true.
          // A post-deadline probe sends store:true with full history. A repair
          // resends full history with checkpoint fields omitted. Normal durable
          // operation keeps the policy store (or a hook's explicit store value)
          // and any caller-owned parent verbatim.
          // Transport recovery keeps explicit caller fields, but never reuses an old delta.
          // A caller-rooted connection lineage (unknown server history) under cooldown
          // or probe keeps chaining it, whatever the store value; replacing it with
          // local input would silently drop history, so an unchainable request fails closed.
          const callerRooted = requestBody.previous_response_id == null
            && (!permitsFullHistory(wireAncestry) || ((cooldownSuppressed || checkpointProbe)
              && acquired.connection.continuation?.hasFullHistory === false && cacheEnabled(options)));
          let lineageChain: RequestBody | undefined;
          if (callerRooted) {
            const chained = lineageBody(acquired.connection.continuation, requestBody, options, wireAncestry);
            if (chained?.previous_response_id == null && !plan) {
              // Nothing sent: retain same-socket lineage, but never escape through SSE or provider retry.
              release(pending);
              pending = undefined;
              const failure = new Error("Cannot continue server-dependent or unknown response ancestry without a validated parent");
              terminalRepairFailure = { error: failure };
              throw Object.assign(failure, { checkpointLineageUnavailable: true });
            }
            lineageChain = chained?.previous_response_id != null ? chained : plan!.request as RequestBody;
            if (cooldownSuppressed) delete lineageChain.store;
            if (requestBody.store === false) lineageChain = { ...lineageChain, store: false };
            else if (!cooldownSuppressed) lineageChain = { ...lineageChain, store: requestBody.store };
          }
          const body = stripRejectedParent ? repairBody
            : lineageChain ? lineageChain
            : checkpointProbe ? ({ ...fullBody, store: true } as RequestBody)
            : cooldownSuppressed ? cooldownBody
            : (delta ?? requestBody);
          // A parent is bridge-owned only when cachedBody rewrote the request
          // into a delta; a caller-supplied previous_response_id is never a
          // bridge-owned baseline.
          const bridgeOwnedParent = lineageChain?.previous_response_id ?? (delta !== undefined && delta !== requestBody
            ? delta.previous_response_id
            : undefined);
          const storedAnchorSent = acquired.connection.continuation?.expiresAt !== undefined
            && bridgeOwnedParent === acquired.connection.continuation.responseId && body.previous_response_id === bridgeOwnedParent;
          if (body.previous_response_id != null && body.previous_response_id !== bridgeOwnedParent) {
            clearAnchor(true);
            pending.anchorGeneration = acquired.connection.anchorGeneration;
            pending.hasFullHistory = false;
          }
          storedAnchorAttempted ||= storedAnchorSent;
          pending.hasFullHistory &&= bridgeOwnedParent === undefined || (durable && delta === plan?.request)
            || acquired.connection.continuation?.hasFullHistory === true;
          if (lineageChain) pending.hasFullHistory = false;
          if (!pending.hasFullHistory) pending.ancestry = "server-dependent";
          else if (bridgeOwnedParent !== undefined && acquired.connection.continuation?.ancestry === "legacy") pending.ancestry = "legacy";
          wireAncestry = pending.ancestry;
          checkpointIntentSent ||= body.store === true || bridgeOwnedParent !== undefined;
          pending.sentStore = body.store === true;
          pending.connection.ws.send({ type: "response.create", ...body } as ResponsesClientEvent);
          if (pending.connection.ws.socket.readyState === 1) { pending.opened = true; pending.onSent?.(); }
          try {
            const first = await firstMessage(pending, request.signal);
            wireAccepted = true;
            durableSent = durableSent || durable;
            actualTransports.set(statusKey, cacheEnabled(options) ? "websocket-cached" : "websocket");
            await notifyTransport(transportLabel(body.previous_response_id ? "WS/continuation" : "WS/full",
              getWebSocketCompressionEncoding((pending.connection.ws.socket as NodeWebSocket).platformSocket.extensions)));
            return streamResponse(pending, first, request.signal);
          } catch (error) {
            // ResponsesWS queues send() until OPEN: a failed handshake never
            // transmitted the frame, so auto may still fall back to SSE.
            durableSent ||= durable && pending.opened === true;
            const hasFullHistory = pending.hasFullHistory;
            closeConnection(pending.key, pending.connection, "request failed");
            pending = undefined;
            // Only checkpoint-active requests need local history; opt-out keeps caller params intact.
            const connectionLimitBeforeStart = isConnectionLimitError(error) && !referenceRepairAttempted
              && (!(durable && requestBody.store === true) || hasFullHistory) && !request.signal.aborted;
            if (connectionLimitBeforeStart && !connectionLimitRetried) {
              connectionLimitRetried = true;
              durableSent = false;
              storedAnchorAttempted = false;
              continue;
            }
            // A checkpoint failure signal on a request that actually carried
            // checkpoint intent: repair once (full history, fields omitted)
            // and open the cooldown. Auth/ambiguous failures never qualify.
            if (durable && checkpointIntentSent && !request.signal.aborted && !stripRejectedParent && isCheckpointReferenceFailure(error)
              && hasFullHistory) {
              checkpointFailedSignal = error;
              openCheckpointCooldown(); // first signal: cooldown opens now,
              // whether the repair below succeeds, fails or is fenced.
              if (invalidRefRetry && !request.signal.aborted) {
                invalidRefRetry = false;
                stripRejectedParent = true;
                referenceRepairAttempted = true;
                continue;
              }
            }
            if (hasFullHistory && bridgeOwnedParent !== undefined
              && ((isInvalidPreviousResponseIdError(error) && !hasConflictingEvidence(error))
                || (isMissingPreviousResponseError(error) && isCheckpointReferenceFailure(error)))) {
              clearAnchor();
              if (acquired.key && isInvalidPreviousResponseIdError(error)) rejectedContinuationKeys.add(acquired.key);
              if (invalidRefRetry && !request.signal.aborted) {
                invalidRefRetry = false;
                stripRejectedParent = true;
                referenceRepairAttempted = true;
                continue;
              }
            }
            connectionLimitFailure = connectionLimitBeforeStart;
            throw error;
          }
        }
      } catch (error) {
        if ((error as { checkpointLineageUnavailable?: boolean }).checkpointLineageUnavailable) {
          releaseProbes();
          throw error;
        }
        // Unsent/aborted probes only release; rejection plus failed repair advances once.
        if (checkpointProbe?.attempted && !request.signal.aborted) openCheckpointCooldown();
        const transportFailure = error instanceof ResponsesWebSocketTransportError;
        if (referenceRepairAttempted || (!connectionLimitFailure && (!transportFailure || durableSent || storedAnchorAttempted))) {
          terminalRepairFailure = { error };
        }
        if (pending) closeConnection(pending.key, pending.connection, "request failed");
        pending = undefined;
        if ((!connectionLimitFailure && (!transportFailure || durableSent || storedAnchorAttempted))
          || options.transport !== "auto" || request.signal.aborted || wireAccepted) {
          releaseProbes();
          const event = error instanceof WebSocketError
            ? error.error as { status?: unknown; error?: { status?: unknown } } | undefined : undefined;
          const status = event?.status ?? event?.error?.status;
          if (!request.signal.aborted && typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599) {
            // Fetch rejections become SDK connection errors; keep explicit application status/body on every retry.
            const response = () => Response.json(event, { status });
            if (terminalRepairFailure) terminalRepairFailure.response = response;
            return response();
          }
          throw error;
        }
        const failure = recordFailure();
        // Native outer retry owner gets three WS retries before SSE; failed repairs stay terminal.
        if (referenceRepairAttempted || (failure && failure.retryAt === 0)) {
          releaseProbes();
          throw error;
        }
        if (checkpointProbe) { checkpointProbe.state.probing = false; checkpointProbe = undefined; }
        useSse = true;
        actualTransports.set(statusKey, "sse");
        return sseFetch(fallbackRequest);
      }
    },
    observeProviderEvent(event) {
      if (referenceRepairAttempted && event && typeof event === "object" && "type" in event
        && typeof event.type === "string" && event.type.length > 0 && event.type !== "error" && event.type !== "response.failed") {
        referenceRepairStarted = true;
      }
    },
    async finish(output) {
      if (output.api === "openai-responses" && output.stopReason === "error"
        && referenceRepairStarted && !options.signal?.aborted) {
        // Classification only: raw errors can carry credentials outside top-level redaction.
        appendAssistantMessageDiagnostic(output, { type: "provider_reference_repair_terminal", timestamp: Date.now() });
      }
      recordResponseAncestry(output, pending?.ancestry ?? wireAncestry);
      if (!pending) { releaseProbes(); return; }
      const completed = responseEventOutput(pending.completion ?? {});
      let encodedOutput: unknown[] | undefined;
      if (options.checkpoints && (options.checkpoints.enabled || !pending.hasFullHistory || (pending.sentStore && completed?.store === true))
        && completed && completed.id === output.responseId) {
        try { encodedOutput = await options.checkpoints.encodeOutput(output); }
        catch { /* Unsupported host codec: no locally proven continuation. */ }
      }
      const outputComplete = encodedOutput !== undefined && completed !== undefined
        && responseOutputItemsCapturable(completed.output, encodedOutput);
      if (pending.scopeHash && pending.hasFullHistory && pending.sentStore === true
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
      const currentGeneration = pending.anchorGeneration === pending.connection.anchorGeneration
        && (!pending.key || connections.get(pending.key) === pending.connection);
      if (!currentGeneration) pending.keep = false;
      if (currentGeneration && output.stopReason !== "error" && output.stopReason !== "aborted" && output.responseId && cacheEnabled(options)) {
        pending.connection.continuation = {
          request: pending.request,
          responseId: output.responseId,
          hasFullHistory: pending.hasFullHistory,
          ancestry: pending.ancestry,
          preparationScope: pending.preparationScope,
          requestUrl: pending.requestUrl,
          ...(outputComplete ? { encodedOutput } : {}),
        };
      }
      if (output.stopReason === "error" || output.stopReason === "aborted") {
        closeConnection(pending.key, pending.connection, "request failed");
        if (output.stopReason === "error") {
          if (!terminalRepairFailure) pending.onStreamError?.(new Error(output.errorMessage ?? "Responses request failed"));
          if (pending.streamError instanceof ResponsesWebSocketTransportError) recordFailure();
        }
      } else {
        const current = autoSseFallback.get(checkpointKey);
        if (current) current.nextCooldownMs = AUTO_SSE_COOLDOWN_MS;
        if (current && current === recoveryState) autoSseFallback.delete(checkpointKey);
        release(pending);
      }
      const captured = output.stopReason !== "error" && output.stopReason !== "aborted"
        && (output as AssistantMessage & { responseCheckpoint?: ResponseCheckpoint }).responseCheckpoint !== undefined;
      if (captured) {
        const current = checkpointCooldown.get(checkpointKey);
        if (current) current.nextCooldownMs = CHECKPOINT_COOLDOWN_MS;
        if (current && current === checkpointProbe?.state) checkpointCooldown.delete(checkpointKey);
      } else if (checkpointProbe?.attempted && output.stopReason !== "aborted") openCheckpointCooldown();
      const continuation = pending.connection.continuation;
      if (continuation && pending.key && connections.get(pending.key) === pending.connection
        && pending.anchorGeneration === pending.connection.anchorGeneration && pending.sentStore === true && completed?.store === true
        && completed.id === output.responseId && outputComplete
        && (output.stopReason === "stop" || output.stopReason === "toolUse")
        && !recoveryProbe && !checkpointCooldown.has(checkpointKey) && !rejectedContinuationKeys.has(pending.key)) {
        const now = Date.now();
        for (const [key, anchor] of anchors) if (anchor.expiresAt! <= now) anchors.delete(key);
        anchors.delete(pending.key);
        anchors.set(pending.key, { ...continuation, expiresAt: now + ANCHOR_TTL_MS });
        if (anchors.size > MAX_ANCHORS) anchors.delete(anchors.keys().next().value!);
      }
      releaseProbes();
      pending = undefined;
    },
  };
}

export type ResponseReplayOwnership = {
  enabled: boolean;
  requested: boolean;
  reason: "host_unsupported" | "bridge_owns_transport";
  configuredTransport: NonNullable<SimpleStreamOptions["transport"]>;
};

export function wrapResponsesWebSocketStream(
  source: AssistantMessageEventStream,
  bridge: ResponsesWebSocketBridge,
  replay?: ResponseReplayOwnership,
): AssistantMessageEventStream {
  const target = createAssistantMessageEventStream();
  const finish = async (output: AssistantMessage) => {
    await bridge.finish(output);
    if (replay?.requested && !replay.enabled) {
      appendAssistantMessageDiagnostic(output, { type: "provider_response_replay_passthrough", timestamp: Date.now(),
        details: { reason: replay.reason, configuredTransport: replay.configuredTransport } });
    }
  };
  void (async () => {
    try {
      for await (const event of source) {
        if (event.type === "done") await finish(event.message);
        else if (event.type === "error") await finish(event.error);
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
      await finish(output);
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
    for (const key of autoSseFallback.keys()) if (key.includes(`\0${sessionId}\0`)) autoSseFallback.delete(key);
    for (const key of actualTransports.keys()) if (key.endsWith(`\0${sessionId}`)) actualTransports.delete(key);
    for (const key of anchors.keys()) if (key.includes(`\0${sessionId}\0`)) anchors.delete(key);
    for (const key of rejectedContinuationKeys) if (key.includes(`\0${sessionId}\0`)) rejectedContinuationKeys.delete(key);
    for (const key of checkpointCooldown.keys()) if (key.includes(`\0${sessionId}\0`)) checkpointCooldown.delete(key);
  } else {
    autoSseFallback.clear();
    actualTransports.clear();
    anchors.clear();
    rejectedContinuationKeys.clear();
    checkpointCooldown.clear();
  }
}

registerSessionResourceCleanup(closeResponsesWebSockets);
