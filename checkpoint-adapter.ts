import { isDeepStrictEqual } from "node:util";
import type { ContextEvent, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import * as piAI from "@earendil-works/pi-ai";
import type { AssistantMessage, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { openAIResponsesApi } from "@earendil-works/pi-ai/compat";
import { minimatch } from "minimatch";
import type { CheckpointCandidate } from "./response-checkpoints.ts";

export type CheckpointOptions = SimpleStreamOptions & { responseCheckpointExclude?: unknown; responseCheckpointMode?: unknown };

export type ResponseAncestry = "local" | "server-dependent";
export type ResponseAncestryState = ResponseAncestry | "legacy" | "unknown";
type AncestryMessage = Context["messages"][number] & { responseAncestry?: unknown };
type ProjectionManager = Pick<ExtensionContext["sessionManager"], "getBranch"> & {
  buildSessionProjection?(): { entries: { sourceEntry: SessionEntry; messages: ContextEvent["messages"] }[] };
};

/** Associate cloned hook input with public canonical provenance before adopting copies. */
export function adoptResponseAncestry(messages: ContextEvent["messages"], manager: ProjectionManager): ContextEvent["messages"] | undefined {
  if (!manager.buildSessionProjection) return undefined;
  const entries = manager.buildSessionProjection().entries;
  const canonical = entries.flatMap((entry) => entry.messages.filter((message) => message.role !== "system"));
  // JSON equality loses own undefined facts; reference identity is lost in the host's structuredClone.
  if (!isDeepStrictEqual(messages, canonical)) return undefined;
  const branch = manager.getBranch();
  const positions = new Map(branch.map((entry, index) => [entry.id, index]));
  if (positions.size !== branch.length || entries.some(({ sourceEntry }) =>
    !isDeepStrictEqual(sourceEntry, branch[positions.get(sourceEntry.id) ?? -1]))) return undefined;
  let boundary = -1;
  for (let i = 0; i < branch.length; i++) {
    const entry = branch[i];
    if (entry.type === "compaction" || (entry.type === "branch_summary" && entry.summary)) boundary = i;
  }
  const latest = branch[boundary];
  if (latest && !entries.some(({ sourceEntry, messages }) => sourceEntry.id === latest.id
    && messages.some((message) => message.role === (latest.type === "compaction" ? "compactionSummary" : "branchSummary")))) return undefined;
  const adopted = new Set(branch.slice(0, Math.max(0, boundary)).map((entry) => entry.id));
  // Identical messages from different entries cannot certify an individual cloned message's origin.
  if (entries.some(({ sourceEntry, messages: projected }) => adopted.has(sourceEntry.id)
    && projected.some((message) => (message.role === "assistant" || message.role === "user")
      && canonical.filter((other) => isDeepStrictEqual(message, other)).length > 1))) return undefined;
  let index = 0;
  let changed = false;
  const result: ContextEvent["messages"] = [];
  for (const { sourceEntry, messages: projected } of entries) {
    let visible = projected.filter((message) => message.role !== "system");
    // Older hosts can omit edited assistants entirely; omit content, not unsafe/legacy ancestry.
    if (visible.length === 0 && !adopted.has(sourceEntry.id) && sourceEntry.type === "message" && sourceEntry.message.role === "assistant"
      && (!Object.hasOwn(sourceEntry.message, "responseAncestry")
        || (sourceEntry.message as AncestryMessage).responseAncestry !== "local")) {
      visible = [{ ...sourceEntry.message, content: [] }];
      changed = true;
    }
    for (const projectedMessage of visible) {
      const message = projected.length === 0 ? projectedMessage : messages[index++];
      let copy = message;
      if (adopted.has(sourceEntry.id)) {
        if (message.role === "assistant") {
          const { responseId: _id, responseCheckpoint: _checkpoint, ...rest } = message as typeof message & { responseCheckpoint?: unknown };
          copy = { ...rest, responseAncestry: "local" } as typeof message;
        } else if (message.role === "user" && Object.hasOwn(message, "responseAncestry")) {
          copy = { ...message, responseAncestry: "local" } as typeof message;
        }
      }
      changed ||= !isDeepStrictEqual(copy, message);
      result.push(copy);
    }
  }
  return changed ? result : undefined;
}

/** Consume projected facts before filtering; adopted copies, not user markers, establish a local baseline. */
export function responseAncestry(context: Context): ResponseAncestryState {
  let ancestry: ResponseAncestryState = "local";
  for (const message of context.messages as AncestryMessage[]) {
    if (!Object.hasOwn(message, "responseAncestry")) {
      if (message.role === "assistant" && ancestry === "local") ancestry = "legacy";
    } else if (message.responseAncestry === "server-dependent") ancestry = "server-dependent";
    else if (message.responseAncestry !== "local") ancestry = "unknown";
  }
  return ancestry;
}

export function permitsFullHistory(ancestry: ResponseAncestryState): boolean {
  return ancestry === "local" || ancestry === "legacy";
}

export function recordResponseAncestry(output: AssistantMessage, ancestry: ResponseAncestryState): void {
  const message = output as AssistantMessage & { responseAncestry?: ResponseAncestry };
  if (ancestry === "legacy") delete message.responseAncestry;
  else message.responseAncestry = ancestry === "local" ? "local" : "server-dependent";
}

const CHECKPOINT_MODES = new Set(["always", "auto", "declared"]);

/** Mode resolution: absent stays absent => "always"; malformed values fail closed (disabled). */
export function checkpointMode(raw: unknown): "always" | "auto" | "declared" | undefined {
  if (raw === undefined) return "always";
  return typeof raw === "string" && CHECKPOINT_MODES.has(raw) ? (raw as "always" | "auto" | "declared") : undefined;
}
const publicAI = piAI as typeof piAI & {
  normalizeContext?: (context: Context) => Context;
  getDeclaredTools?: (messages: Context["messages"]) => Context["tools"];
};

/** Merge caller header layers case-insensitively, like the native provider. */
export function responseHeaders(model: Model<"openai-responses">, options: Pick<CheckpointOptions, "headers">): Headers {
  const headers = new Headers();
  for (const source of [model.headers, options.headers]) {
    for (const [name, value] of Object.entries(source ?? {})) {
      if (value === null) headers.delete(name);
      else headers.set(name, value);
    }
  }
  return headers;
}

/**
 * Plugin policy: [Response checkpoints](README.md#response-checkpoints); absent list defaults to [].
 * Paired native owner: https://github.com/xz-dev/pi/blob/patch/responses-websocket-transport/packages/ai/src/api/openai-responses.ts
 */
export function checkpointsEnabled(model: Model<"openai-responses">, options: CheckpointOptions, raw: unknown): boolean {
  if (options.cacheRetention === "none" || !["auto", "websocket-cached"].includes(options.transport ?? "auto")) return false;
  let host = "";
  try { host = new URL(model.baseUrl).hostname.toLowerCase(); } catch { return false; }
  if (model.provider === "openai-codex" || host === "chatgpt.com" || host.endsWith(".chatgpt.com")) return false;
  const official = model.baseUrl === "https://api.openai.com/v1";
  const headers = responseHeaders(model, options);
  const key = headers.get("authorization")?.replace(/^Bearer\s+/i, "")
    ?? (headers.has("cf-aig-authorization") ? undefined : options.apiKey);
  if (official && !key?.startsWith("sk-")) return false;
  const mode = checkpointMode(options.responseCheckpointMode);
  const capability = (model.compat as { supportsResponseCheckpoints?: boolean } | undefined)?.supportsResponseCheckpoints;
  // "always": try even when compat declares false. "auto": try unless declared false.
  // "declared": exact true, or the official service default. Malformed mode is disabled.
  const eligible = mode === "always" || (mode === "auto" && capability !== false)
    || (mode === "declared" && (capability === true || (capability === undefined && official)));
  if (!eligible) return false;
  const exclude = raw === undefined ? [] : raw;
  if (!Array.isArray(exclude) || !Array.from(exclude).every((pattern) => typeof pattern === "string")) return false;
  return !exclude.some((pattern) => pattern === "*" || [model.provider, model.id, `${model.provider}/${model.id}`]
    .some((target) => minimatch(target, pattern, { nocase: true })));
}

export function checkpointCandidate(context: Context): CheckpointCandidate | undefined {
  for (let i = context.messages.length - 1; i >= 0; i--) {
    const message = context.messages[i];
    if (message.role !== "assistant") continue;
    if (message.stopReason !== "stop" && message.stopReason !== "toolUse") return undefined;
    return message.responseId ? { responseId: message.responseId,
      responseCheckpoint: (message as AssistantMessage & { responseCheckpoint?: unknown }).responseCheckpoint } : undefined;
  }
  return undefined;
}

/** Run the owning SDK's public preparation hook, then stop before transport. */
export async function encodeCheckpointOutput(
  api: ReturnType<typeof openAIResponsesApi>,
  model: Model<"openai-responses">,
  context: Context,
  output: AssistantMessage,
): Promise<unknown[]> {
  const tools = context.tools ?? publicAI.getDeclaredTools?.(context.messages);
  const single = structuredClone({ messages: [output], ...(tools ? { tools } : {}) });
  const stop = new Error("Checkpoint encoding stopped before transport");
  let encoded: unknown[] | undefined;
  let attemptedTransport = false;
  const result = await api.stream(model, publicAI.normalizeContext?.(single) ?? single, {
    apiKey: "sk-checkpoint-encoding-only",
    transport: "sse",
    cacheRetention: "none",
    maxRetries: 0,
    // No caller options/callbacks/sessionId: preparation cannot recurse into the bridge.
    onPayload(payload) {
      const input = (payload as { input?: unknown[] }).input;
      if (Array.isArray(input)) encoded = input.filter((item) => {
        const type = (item as { type?: unknown })?.type;
        return type !== "function_call_output" && type !== "custom_tool_call_output";
      });
      throw stop;
    },
    // Fail closed even if a future host changes hook ordering. Never perform I/O.
    fetch: async () => { attemptedTransport = true; throw stop; },
  }).result();
  if (!encoded || attemptedTransport || result.stopReason !== "error") throw stop;
  return encoded;
}
