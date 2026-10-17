import * as piAI from "@earendil-works/pi-ai";
import type { AssistantMessage, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { openAIResponsesApi } from "@earendil-works/pi-ai/compat";
import { minimatch } from "minimatch";
import type { CheckpointCandidate } from "./response-checkpoints.ts";

export type CheckpointOptions = SimpleStreamOptions & { responseCheckpointExclude?: unknown };
const publicAI = piAI as typeof piAI & {
  normalizeContext?: (context: Context) => Context;
  getDeclaredTools?: (messages: Context["messages"]) => Context["tools"];
};

/**
 * Plugin policy: [Response checkpoints](README.md#response-checkpoints); absent list defaults to [].
 * Paired native owner: https://github.com/xz-dev/pi/blob/patch/responses-websocket-transport/packages/ai/src/api/openai-responses.ts
 */
export function checkpointsEnabled(model: Model<"openai-responses">, options: CheckpointOptions, raw: unknown): boolean {
  if (options.cacheRetention === "none" || !["auto", "websocket-cached"].includes(options.transport ?? "")) return false;
  if (model.provider === "openai-codex" || model.baseUrl.includes("chatgpt.com")) return false;
  const official = model.baseUrl === "https://api.openai.com/v1";
  // The bridge authenticates WS with apiKey, not an HTTP Authorization override.
  const key = options.apiKey ?? new Headers(options.headers as HeadersInit).get("authorization")?.replace(/^Bearer\s+/i, "");
  if (official && !key?.startsWith("sk-")) return false;
  const capability = (model.compat as { supportsResponseCheckpoints?: boolean } | undefined)?.supportsResponseCheckpoints;
  if (capability !== true && !(capability === undefined && official)) return false;
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
