/**
 * Pi provider for OpenAI-compatible gateways exposing the Responses API.
 *
 * Configuration (environment values override stored fields independently):
 * - /login openai-api-extension
 * - OPENAI_API_EXTENSION_BASE_URL / OPENAI_API_EXTENSION_API_KEY
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  getAgentDir,
  type ExtensionAPI,
  SettingsManager,
  VERSION,
} from "@earendil-works/pi-coding-agent";
import * as piAI from "@earendil-works/pi-ai";
import {
  type ApiKeyAuth,
  type ApiKeyCredential,
  type AuthContext,
  type AuthResult,
  type Context,
  type Message,
  type Model,
  type Provider,
  type RefreshModelsContext,
} from "@earendil-works/pi-ai";
import { openAIResponsesApi } from "@earendil-works/pi-ai/compat";
import { adoptResponseAncestry, checkpointCandidate, checkpointsEnabled, encodeCheckpointOutput, responseAncestry, type CheckpointOptions,
  type ResponseAncestryState } from "./checkpoint-adapter.ts";
import { compileCatalogInWorker } from "./metadata-compile.ts";
import {
  externalFields,
  fieldIsMissing,
  makeResolver,
  mergePatch,
  MetadataConfigError,
  normalizeFields,
  type CompiledCatalog,
  type CompiledModel,
  type MetadataFields,
} from "./model-metadata.ts";
import { parseMetadataConfig } from "./metadata-config.ts";
import { renderCompiledCatalog } from "./metadata-view.ts";
import { formatPluginOutput, notifyPlugin } from "./notification.ts";
import { createMetadataCommands, type MetadataCommandOptions } from "./metadata-commands.ts";
import { writeMetadataTempFile } from "./metadata-tmpfile.ts";
import {
  createResponsesWebSocketBridge,
  getActualResponsesTransport,
  redactAssistantStream,
  type ResponsesWebSocketBridge,
  wrapResponsesWebSocketStream,
} from "./responses-websocket-fetch.ts";

const PROVIDER = "openai-api-extension";
// Newer hosts require transcript-normalized tools/system messages; stock has no normalizer.
const normalizeContext = (piAI as typeof piAI & { normalizeContext?: (context: Context) => Context }).normalizeContext;

/**
 * Drop messages whose content is empty or whitespace-only before delegating to
 * Pi's Responses adapter. Extension-injected custom messages (for example
 * watchdog inquiry fold markers) surface here as empty user messages, which
 * some gateways reject (Gemini-style `contents.parts must not be empty`).
 * Kept regardless of emptiness:
 * - system messages: their content and control metadata must reach Pi unchanged
 * - toolResult messages: they answer tool calls and must not be dropped
 * - assistant messages with tool calls: dropping them would orphan tool results
 * - blocks carrying signatures (textSignature/thinkingSignature, including
 *   redacted thinking): providers require them echoed back
 * Unknown block types are kept for the downstream adapter to decide.
 */
function isEmptyContent(message: Message): boolean {
  if (message.role !== "user" && message.role !== "assistant") return false;
  if (message.role === "user") {
    if (typeof message.content === "string") return message.content.trim().length === 0;
    return message.content.every((block) => block.type === "text" && block.text.trim().length === 0);
  }
  return message.content.every((block) => {
    if (block.type === "toolCall") return false;
    if (block.type === "text") return !block.textSignature && block.text.trim().length === 0;
    if (block.type === "thinking") return !block.thinkingSignature && block.thinking.trim().length === 0;
    return false;
  });
}

export function dropEmptyMessages(messages: Message[]): Message[] {
  return messages.filter((message) => !isEmptyContent(message));
}
const PROVIDER_NAME = "OpenAI API Extension";
const ENV_BASE_URL = "OPENAI_API_EXTENSION_BASE_URL";
const ENV_API_KEY = "OPENAI_API_EXTENSION_API_KEY";
const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const CONNECTION_TIMEOUT_MS = 15_000;
/** Ported omniroute fallback: gateways may omit limits; never reject the catalog for it. */
const DEFAULT_CONTEXT_WINDOW = 128_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  return Boolean(signal?.aborted) || (error instanceof Error && error.name === "AbortError");
}

/** Normalizes a user-supplied base URL: trims, strips trailing slashes, http(s) only. */
export function normalizeBaseUrl(raw: string | undefined): string | undefined {
  const value = raw?.trim().replace(/\/+$/, "");
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) return undefined;
    return url.toString().replace(/\/+$/, "");
  } catch {
    return undefined;
  }
}

const REASONING_EFFORTS = new Set(["none", "low", "medium", "high", "xhigh", "max"]);

type ReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max";

type UpstreamModel = {
  id?: unknown;
  slug?: unknown;
  name?: unknown;
  display_name?: unknown;
  type?: unknown;
  context_window?: unknown;
  context_length?: unknown;
  max_tokens?: unknown;
  max_output_tokens?: unknown;
  max_completion_tokens?: unknown;
  input_modalities?: unknown;
  output_modalities?: unknown;
  supported_reasoning_levels?: unknown;
  capabilities?: unknown;
};

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Model kinds Pi's chat catalog cannot use (ported from omniroute-pi-extension). */
const NON_CHAT_TYPES = new Set(["embedding", "image", "video", "audio"]);

function identifierSegments(value: string): string[] {
  return value
    .trim()
    .toLowerCase()
    .split(/[\/:\-_]/)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

/** Entry identity used for both filtering and mapping: id (id/slug) plus display name. */
function entryIdentity(row: UpstreamModel): { id: string; name: string } | undefined {
  const id = [row.id, row.slug].find((value): value is string => typeof value === "string" && value.trim() !== "")?.trim();
  if (!id) return undefined;
  const name =
    [row.name, row.display_name].find((value): value is string => typeof value === "string" && value.trim() !== "")
      ?.trim() ?? id;
  return { id, name };
}

/** Keeps only conversational text models (Pi chat usage); drops unambiguous non-chat kinds. */
export function isConversationalTextModel(row: UpstreamModel): boolean {
  const identity = entryIdentity(row);
  if (!identity) return false;
  const type = typeof row.type === "string" ? row.type.trim().toLowerCase() : "";
  if (type && NON_CHAT_TYPES.has(type)) return false;
  if (Array.isArray(row.output_modalities) && row.output_modalities.length > 0) {
    const outputs = row.output_modalities.filter((value): value is string => typeof value === "string");
    if (outputs.length > 0 && !outputs.some((modality) => modality.trim().toLowerCase() === "text")) return false;
  }
  for (const value of [identity.id, identity.name]) {
    const segments = identifierSegments(value);
    if (segments.some((segment) => NON_CHAT_TYPES.has(segment))) return false;
  }
  return true;
}

function parseEfforts(value: unknown): ReasoningEffort[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const effort = typeof item === "string" ? item : isRecord(item) ? item.effort : undefined;
    const normalized = typeof effort === "string" ? effort.trim().toLowerCase() : undefined;
    return normalized && REASONING_EFFORTS.has(normalized) ? [normalized as ReasoningEffort] : [];
  });
}

function thinkingLevelMap(efforts: ReasoningEffort[]) {
  const available = new Set(efforts);
  if (![...available].some((effort) => effort !== "none")) return undefined;
  return {
    off: null,
    minimal: available.has("low") ? "low" : null,
    low: available.has("low") ? "low" : null,
    medium: available.has("medium") ? "medium" : null,
    high: available.has("high") ? "high" : null,
    xhigh: available.has("xhigh") ? "xhigh" : null,
    max: available.has("max") ? "max" : null,
  };
}

export type GatewayModel = Model<"openai-responses">;

/**
 * Maps an OpenAI-compatible /models payload entry to a Pi model.
 * `enriched` supplies already-merged metadata fields (canonical names);
 * when absent the raw upstream row itself is used.
 */
export function mapModel(
  entry: unknown,
  baseUrl = DEFAULT_BASE_URL,
  enriched?: Readonly<Record<string, unknown>>,
): GatewayModel | undefined {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return undefined;
  const row = entry as UpstreamModel;
  const identity = entryIdentity(row);
  if (!identity) return undefined;
  // Canonical metadata fields, in alias-preference order. Enriched fields (if
  // provided) carry the same canonical names produced by model-metadata.ts.
  const meta = enriched ?? (row as Readonly<Record<string, unknown>>);
  const pick = (...keys: string[]) => keys.map((key) => meta[key]).find((value) => value !== undefined && value !== null);
  const contextWindow = num(pick("context_window", "context_length")) ?? DEFAULT_CONTEXT_WINDOW;
  const maxTokens = num(pick("max_output_tokens", "max_completion_tokens", "max_tokens"));
  // Ported omniroute semantics: a gateway entry without declared limits uses the
  // default context window instead of rejecting the whole catalog. Defaults fill
  // last so source ordering sees real missing values.
  const resolvedMaxTokens = maxTokens ?? contextWindow;
  // capabilities.effort_tiers is raw UPSTREAM data: only the unenriched
  // direct-mapping path may read it. A resolved chain without @self must not
  // recover upstream capability fields through this nested back door.
  const effortTiers =
    enriched === undefined && isRecord(row.capabilities) ? row.capabilities.effort_tiers : undefined;
  const map = thinkingLevelMap(
    parseEfforts(pick("supported_reasoning_levels") ?? effortTiers),
  );
  const inputModalities = pick("input_modalities");
  // The display name is always the gateway's own (name/display_name, else id);
  // external metadata names never replace it — only user overrides can.
  return {
    id: identity.id,
    name: identity.name,
    provider: PROVIDER,
    api: "openai-responses",
    baseUrl,
    reasoning: map !== undefined,
    ...(map ? { thinkingLevelMap: map } : {}),
    input: Array.isArray(inputModalities) && inputModalities.includes("image") ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens: resolvedMaxTokens,
  };
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.trim() !== "")?.trim();
}

/** Fetches the raw gateway catalog; throws only on transport/shape failures (HTTP, auth, non-Codex payload). */
export async function fetchCatalog(baseUrl: string, apiKey: string, signal?: AbortSignal): Promise<unknown[]> {
  const url = new URL(`${baseUrl}/models`);
  url.searchParams.set("client_version", VERSION);
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal,
  });
  if (!response.ok) {
    const body = (await response.text().catch(() => "")).replace(/\s+/g, " ").trim().slice(0, 160);
    const safeBody = apiKey ? body.split(apiKey).join("[REDACTED]") : body;
    throw new Error(`Model discovery failed: HTTP ${response.status}${safeBody ? `: ${safeBody}` : ""}`);
  }
  const payload: unknown = await response.json();
  const entries =
    typeof payload === "object" && payload !== null
      ? ((payload as { models?: unknown; data?: unknown }).models ?? (payload as { data?: unknown }).data)
      : undefined;
  if (!Array.isArray(entries)) {
    throw new Error("Model discovery did not return a Codex or OpenAI model catalog");
  }
  return entries;
}

/**
 * Maps a raw catalog atomically for Pi chat usage: non-conversational entries
 * (embedding/image/video/audio) are filtered before mapping, so their missing
 * capability limits never reject the catalog; any remaining unusable entry
 * still rejects the whole list, never a partial one.
 */
/**
 * Maps a raw catalog atomically for Pi chat usage. `resolveMetadata`, when
 * provided, returns the merged metadata fields for a public id (upstream row
 * is the second argument) for the enrichment chain; it runs before default
 * filling so fill-only can see real missing values.
 */
export function mapCatalog(
  entries: readonly unknown[],
  baseUrl = DEFAULT_BASE_URL,
  resolveMetadata?: (publicId: string, row: Readonly<Record<string, unknown>>) => Readonly<Record<string, unknown>>,
): GatewayModel[] {
  const models = entries
    .flatMap((entry) => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        throw new Error("Model discovery returned an invalid catalog entry");
      }
      const row = entry as UpstreamModel;
      if (!entryIdentity(row)) throw new Error("Model discovery returned an invalid catalog entry");
      if (!isConversationalTextModel(row)) return [];
      const enriched = resolveMetadata?.(entryIdentity(row)!.id, row as Readonly<Record<string, unknown>>);
      const model = mapModel(entry, baseUrl, enriched);
      if (!model) throw new Error("Model discovery returned an invalid catalog entry");
      return [model];
    })
    .sort((left, right) => left.id.localeCompare(right.id));
  if (models.length === 0) throw new Error("Model discovery returned no usable models");
  return models;
}

/** Fetches and maps the gateway catalog atomically; throws on transport, shape, or entry-level failures. */
export async function fetchModels(
  baseUrl: string,
  apiKey: string,
  signal?: AbortSignal,
  resolveMetadata?: (publicId: string, row: Readonly<Record<string, unknown>>) => Readonly<Record<string, unknown>>,
): Promise<GatewayModel[]> {
  return mapCatalog(await fetchCatalog(baseUrl, apiKey, signal), baseUrl, resolveMetadata);
}

const METADATA_CONFIG_FILE = "openai-api-extension.yaml";

export type CatalogEnrichment = {
  models: GatewayModel[];
  /** Human-readable one-line notes: ignored config fields and degraded sources. */
  notes: string[];
};

/**
 * The single enriched-catalog path shared by login validation,
 * refreshModels, /provider-info, and /provider-metadata. Reads
 * the YAML config once per call, compiles config+data inside the Worker, then
 * maps the upstream catalog against the compiled entries.
 * - Missing config file = empty config (built-in default chain applies).
 * - MetadataConfigError propagates: callers keep the previous catalog and
 *   must not surface it as an auth failure.
 * - Unloadable data packages degrade only their own site's entries.
 * - Caller-abort propagates; an aborted compile never publishes.
 */
export async function enrichCatalog(
  entries: readonly unknown[],
  baseUrl: string,
  signal: AbortSignal | undefined,
  deps?: Parameters<typeof compileCatalogInWorker>[2],
): Promise<CatalogEnrichment> {
  let text: string | undefined;
  try {
    text = await readFile(join(getAgentDir(), METADATA_CONFIG_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new MetadataConfigError(METADATA_CONFIG_FILE, errorMessage(error));
    }
  }
  const config = parseMetadataConfig(text);
  // Validate identity and filter non-chat entries first so an embedding
  // model's conflicting creator can't block chat-model compilation.
  const chatEntries: { entry: unknown; id: string }[] = [];
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error("Model discovery returned an invalid catalog entry");
    }
    const row = entry as UpstreamModel;
    const identity = entryIdentity(row);
    if (!identity) throw new Error("Model discovery returned an invalid catalog entry");
    if (!isConversationalTextModel(row)) continue;
    chatEntries.push({ entry, id: identity.id });
  }
  const publicIds = chatEntries.map((item) => item.id);
  signal?.throwIfAborted();
  const compiled = (await compileCatalogInWorker(config, publicIds, deps, signal)).catalog;
  return mapCompiledCatalog(entries, baseUrl, compiled);
}

/**
 * Maps upstream entries against a compiled catalog: metadata merge, mapModel,
 * then RFC 7396 overrides on the final Pi model.
 */
export function mapCompiledCatalog(
  entries: readonly unknown[],
  baseUrl: string,
  compiled: CompiledCatalog,
): CatalogEnrichment {
  const resolver = makeResolver(compiled);
  const models = entries
    .flatMap((entry) => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        throw new Error("Model discovery returned an invalid catalog entry");
      }
      const row = entry as UpstreamModel;
      const identity = entryIdentity(row);
      if (!identity) throw new Error("Model discovery returned an invalid catalog entry");
      if (!isConversationalTextModel(row)) return [];
      const enriched = resolver.resolve(identity.id, row as Readonly<Record<string, unknown>>);
      const model = mapModel(entry, baseUrl, enriched);
      if (!model) throw new Error("Model discovery returned an invalid catalog entry");
      for (const patch of resolver.overridePatches(identity.id)) {
        mergePatch(model as unknown as Record<string, unknown>, patch);
      }
      return [model];
    })
    .sort((left, right) => left.id.localeCompare(right.id));
  if (models.length === 0) throw new Error("Model discovery returned no usable models");
  const notes = compiled.warnings.length > 0
    ? [`ignored unsupported fields: ${compiled.warnings.join(", ")}`]
    : [];
  if (compiled.sourceWarning) notes.push(`metadata data fallback: ${compiled.sourceWarning}`);
  for (const item of compiled.degraded) {
    const scope = item.scope ? ` ${item.scope}` : "";
    notes.push(`metadata source ${item.site}${scope} unavailable (${item.reason}); its declared entries were skipped`);
  }
  const categories = matchCategories(compiled.models);
  const enabled = categories.complete + categories.partial + categories.unmatched;
  if (enabled > 0 && (categories.partial > 0 || categories.unmatched > 0)) {
    notes.push(
      `metadata match: ${categories.complete} complete, ${categories.partial} partial-source-missing, ` +
        `${categories.unmatched} unmatched of ${enabled} enabled` +
        (categories.disabled > 0 ? ` (${categories.disabled} with external chain disabled)` : ""),
    );
  }
  return { models, notes };
}

/**
 * Capability keys that count as real external metadata; a `name`-only record
 * is not a capability hit.
 */
const CAPABILITY_KEYS = new Set([
  "context_window",
  "max_input_tokens",
  "max_output_tokens",
  "supported_reasoning_levels",
  "default_reasoning_level",
  "input_modalities",
  "output_modalities",
]);

/** True when the compiled model gained at least one valid capability field. */
function hasCapabilityField(model: CompiledModel): boolean {
  const fields = externalFields(model);
  return Object.keys(fields).some(
    (key) => CAPABILITY_KEYS.has(key) && !fieldIsMissing(key, fields[key]),
  );
}

/**
 * Per-model match categories over the compiled catalog. Models with an
 * enabled external chain are complete (external capability fields, nothing
 * unresolved), partial-source-missing (external capability fields but some
 * entry unresolved), or fully unmatched (no external capability field at
 * all). Upstream (@self) values never count as an external hit. Models whose
 * effective chain declares no external source are counted separately as
 * disabled — never as match failures. The four buckets are mutually
 * exclusive and conservative.
 */
export function matchCategories(models: readonly CompiledModel[]): {
  complete: number;
  partial: number;
  unmatched: number;
  disabled: number;
} {
  const out = { complete: 0, partial: 0, unmatched: 0, disabled: 0 };
  for (const model of models) {
    if (!model.externalChain) {
      out.disabled += 1;
    } else if (!hasCapabilityField(model)) {
      out.unmatched += 1;
    } else if (model.unresolved.length > 0) {
      out.partial += 1;
    } else {
      out.complete += 1;
    }
  }
  return out;
}

/**
 * Per-report note filter: a note identical to one in the immediately previous
 * report is suppressed; a note that dropped out of a report may reappear.
 * Returned function is stateful across reports.
 */
export function makeConsecutiveNoteDedupe(): (notes: readonly string[]) => string[] {
  let previous: ReadonlySet<string> = new Set();
  return (notes) => {
    const fresh = notes.filter((note) => !previous.has(note));
    previous = new Set(notes);
    return fresh;
  };
}

export async function fetchEnrichedCatalog(
  baseUrl: string,
  apiKey: string,
  signal: AbortSignal | undefined,
  deps?: Parameters<typeof compileCatalogInWorker>[2],
): Promise<CatalogEnrichment> {
  return enrichCatalog(await fetchCatalog(baseUrl, apiKey, signal), baseUrl, signal, deps);
}

function credentialBaseUrl(credential: ApiKeyCredential | undefined): string | undefined {
  return normalizeBaseUrl(credential?.env?.[ENV_BASE_URL]);
}

async function resolveConnection(
  ctx: AuthContext,
  credential: ApiKeyCredential | undefined,
  signal: AbortSignal,
): Promise<{ baseUrl: string; apiKey: string; source: string } | undefined> {
  const rawEnvBaseUrl = await ctx.env(ENV_BASE_URL);
  signal.throwIfAborted();
  const rawEnvApiKey = await ctx.env(ENV_API_KEY);
  signal.throwIfAborted();
  const envBaseUrl = normalizeBaseUrl(rawEnvBaseUrl);
  const envApiKey = rawEnvApiKey?.trim();
  if ((rawEnvBaseUrl !== undefined && !envBaseUrl) || (rawEnvApiKey !== undefined && !envApiKey)) return undefined;
  const baseUrl = envBaseUrl ?? credentialBaseUrl(credential);
  const apiKey = envApiKey ?? credential?.key?.trim();
  if (!baseUrl || !apiKey) return undefined;
  return {
    baseUrl,
    apiKey,
    source: envBaseUrl || envApiKey ? "environment" : "stored credential",
  };
}

function apiKeyAuth(
  onValidated: (baseUrl: string, apiKey: string, models: readonly GatewayModel[]) => void,
  deps?: Parameters<typeof compileCatalogInWorker>[2],
): ApiKeyAuth {
  return {
    name: `${PROVIDER_NAME} connection`,
    login: async (interaction): Promise<ApiKeyCredential> => {
      const enteredBaseUrl = await interaction.prompt({
        type: "text",
        message: formatPluginOutput("Gateway base URL"),
        placeholder: DEFAULT_BASE_URL,
      });
      interaction.signal.throwIfAborted();
      const baseUrl = normalizeBaseUrl(enteredBaseUrl || DEFAULT_BASE_URL);
      if (!baseUrl) throw new Error(formatPluginOutput("Gateway base URL must be an HTTP(S) URL"));

      const apiKey = (
        await interaction.prompt({ type: "secret", message: formatPluginOutput("Gateway API key"), placeholder: "sk-..." })
      ).trim();
      interaction.signal.throwIfAborted();
      if (!apiKey) throw new Error(formatPluginOutput("Gateway API key cannot be empty"));

      interaction.notify({ type: "progress", message: formatPluginOutput("Validating connection...") });
      const entries = await fetchCatalog(baseUrl, apiKey, interaction.signal).catch((error) => {
        interaction.signal.throwIfAborted();
        throw new Error(formatPluginOutput(errorMessage(error), [apiKey]), { cause: error });
      });
      try {
        const { models, notes } = await enrichCatalog(entries, baseUrl, interaction.signal, deps);
        // A cancelled login must not publish the catalogue it fetched.
        interaction.signal.throwIfAborted();
        onValidated(baseUrl, apiKey, models);
        for (const note of notes) interaction.notify({ type: "info", message: formatPluginOutput(`Metadata: ${note}`, [apiKey]) });
        interaction.notify({ type: "info", message: formatPluginOutput(`Found ${models.length} models.`) });
      } catch (error) {
        // Caller cancel is not a catalog problem: propagate, never degrade.
        interaction.signal.throwIfAborted();
        const reason = errorMessage(error);
        // Config failures must not look like an invalid API key or an unusable catalog.
        const message =
          error instanceof MetadataConfigError
            ? `Connected, but the metadata config is invalid: ${reason} API key saved; models were not updated.`
            : `Connected, but the model catalog is not usable: ${reason} API key saved; models were not updated.`;
        interaction.notify({ type: "info", message: formatPluginOutput(message, [apiKey]) });
      }
      return { type: "api_key", key: apiKey, env: { [ENV_BASE_URL]: baseUrl } };
    },
    check: async ({ ctx, credential, signal }) => {
      const connection = await resolveConnection(ctx, credential, signal);
      return connection ? { type: "api_key", source: connection.source } : undefined;
    },
    resolve: async ({ ctx, credential, signal }): Promise<AuthResult | undefined> => {
      const connection = await resolveConnection(ctx, credential, signal);
      if (!connection) return undefined;
      return {
        auth: { apiKey: connection.apiKey, baseUrl: connection.baseUrl },
        env: { [ENV_BASE_URL]: connection.baseUrl },
        source: connection.source,
      };
    },
  };
}

export function createOpenAIApiProvider(
  initialModels: readonly GatewayModel[] = [],
  onCatalogError?: (message: string) => void,
  getRawCheckpointExclude: () => unknown = () => undefined,
  getRawCheckpointMode: () => unknown = () => undefined,
  /** Called once per report with that report's notes so the caller can
   *  suppress only repeats of the immediately previous report. */
  onCatalogNotes?: (notes: readonly string[]) => void,
  metadataDeps?: Parameters<typeof compileCatalogInWorker>[2],
): Provider<"openai-responses"> {
  let models = initialModels;
  let initialModelsPublished = false;
  let validatedLogin:
    | { baseUrl: string; apiKey: string; models: readonly GatewayModel[]; checkedAt: number }
    | undefined;
  const api = openAIResponsesApi();
  const bridgeOptions = (model: GatewayModel, context: Context, options: CheckpointOptions, ancestry: ResponseAncestryState) => {
    const raw = Object.hasOwn(options, "responseCheckpointExclude") ? options.responseCheckpointExclude : getRawCheckpointExclude();
    const mode = Object.hasOwn(options, "responseCheckpointMode") ? options.responseCheckpointMode : getRawCheckpointMode();
    return { ...options, responseAncestry: ancestry, checkpoints: {
      enabled: checkpointsEnabled(model, { ...options, responseCheckpointMode: mode }, raw),
      candidate: checkpointCandidate(context),
      encodeOutput: (output: piAI.AssistantMessage) => encodeCheckpointOutput(api, model, context, output),
    } };
  };
  const payloadHook = (bridge: ResponsesWebSocketBridge, enabled: boolean, original: CheckpointOptions["onPayload"]) =>
    async (payload: unknown, model: GatewayModel, prepareRequest?: (payload: unknown) => Promise<Request>) => {
      if (enabled && payload && typeof payload === "object") (payload as { store?: boolean }).store = true;
      const next = await original?.(payload, model, prepareRequest);
      return bridge.prepare(next === undefined ? payload : next, prepareRequest);
    };
  const providerEventHook = (bridge: ResponsesWebSocketBridge, options: CheckpointOptions & {
    onProviderStreamEvent?: (event: unknown, model: GatewayModel) => void | Promise<void>;
  }) => async (event: unknown, model: GatewayModel) => {
    await options.onProviderStreamEvent?.(event, model);
    // SDK SSE start precedes decoding; only an accepted mapped provider event proves repair start.
    bridge.observeProviderEvent(event);
  };
  const provider: Provider<"openai-responses"> = {
    id: PROVIDER,
    name: PROVIDER_NAME,
    auth: {
      apiKey: apiKeyAuth((baseUrl, apiKey, validatedModels) => {
        validatedLogin = { baseUrl, apiKey, models: validatedModels, checkedAt: Date.now() };
      }, metadataDeps),
    },
    getModels: () => models,
    refreshModels: async (context: RefreshModelsContext) => {
      if (validatedLogin) {
        const validated = validatedLogin;
        const matchesCredential =
          context.credential?.type === "api_key" &&
          context.credential.key === validated.apiKey &&
          credentialBaseUrl(context.credential) === validated.baseUrl;
        if (!matchesCredential) {
          validatedLogin = undefined;
        } else if (!(await context.publish({
          persist: { models: validated.models, checkedAt: validated.checkedAt },
          update: () => {
            models = validated.models;
            validatedLogin = undefined;
          },
        }))) return;
      } else if (initialModels.length > 0 && !initialModelsPublished) {
        if (!(await context.publish({
          persist: { models: initialModels, checkedAt: Date.now() },
          update: () => {
            models = initialModels;
            initialModelsPublished = true;
          },
        }))) return;
      } else if (initialModels.length === 0 && context.stored) {
        const restored = context.stored.models.filter(
          (model): model is GatewayModel => model.provider === PROVIDER && model.api === "openai-responses",
        );
        if (!(await context.publish({ update: () => { models = restored; } }))) return;
      }
      if (!context.allowNetwork || context.signal.aborted || context.credential?.type !== "api_key") return;
      const baseUrl = credentialBaseUrl(context.credential);
      const apiKey = context.credential.key;
      if (!baseUrl || !apiKey) return;
      try {
        const { models: refreshed, notes } = await fetchEnrichedCatalog(baseUrl, apiKey, context.signal, metadataDeps);
        if (context.signal.aborted) return;
        // Report only after the publish is accepted: an aborted or superseded
        // refresh must not surface notes for a catalog that never went live.
        const published = await context.publish({
          persist: { models: refreshed, checkedAt: Date.now() },
          update: () => { models = refreshed; },
        });
        if (published === false) return;
        try {
          onCatalogNotes?.(notes);
        } catch {
          /* reporter must not mask the refresh */
        }
      } catch (error) {
        if (!isAbortError(error, context.signal)) {
          try {
            onCatalogError?.(errorMessage(error).split(apiKey).join("[REDACTED]"));
          } catch {
            /* reporter must not mask the catalog error */
          }
        }
        throw error;
      }
    },
    stream: (model, context, options) => {
      options = { ...options, transport: options?.transport ?? "auto" };
      const ancestry = responseAncestry(context);
      const filteredContext = { ...context, messages: dropEmptyMessages(context.messages) };
      const requestContext = normalizeContext?.(filteredContext) ?? filteredContext;
      // The bridge owns transport and ancestry, including explicit SSE without opening WS.
      const owned = bridgeOptions(model, context, options, ancestry);
      const bridge = createResponsesWebSocketBridge(model, owned);
      const sdkOptions = { ...options, transport: "sse" as const, onTransport: undefined, fetch: bridge.fetch,
        onPayload: payloadHook(bridge, owned.checkpoints.enabled, options.onPayload),
        onProviderStreamEvent: providerEventHook(bridge, options) };
      return redactAssistantStream(
        wrapResponsesWebSocketStream(api.stream(model, requestContext, sdkOptions), bridge),
        options.apiKey,
      );
    },
    streamSimple: (model, context, options) => {
      options = { ...options, transport: options?.transport ?? "auto" };
      const ancestry = responseAncestry(context);
      const filteredContext = { ...context, messages: dropEmptyMessages(context.messages) };
      const requestContext = normalizeContext?.(filteredContext) ?? filteredContext;
      const owned = bridgeOptions(model, context, options, ancestry);
      const bridge = createResponsesWebSocketBridge(model, owned);
      const sdkOptions = { ...options, transport: "sse" as const, onTransport: undefined, fetch: bridge.fetch,
        onPayload: payloadHook(bridge, owned.checkpoints.enabled, options.onPayload),
        onProviderStreamEvent: providerEventHook(bridge, options) };
      return redactAssistantStream(
        wrapResponsesWebSocketStream(api.streamSimple(model, requestContext, sdkOptions), bridge),
        options.apiKey,
      );
    },
  };
  return provider;
}

export default async function (pi: ExtensionAPI, dependencies: {
  metadataCommands?: MetadataCommandOptions;
  metadataCompile?: Parameters<typeof compileCatalogInWorker>[2];
} = {}): Promise<void> {
  const packageCommands = createMetadataCommands(dependencies.metadataCommands);
  pi.on("context", (event, ctx) => {
    const messages = adoptResponseAncestry(event.messages, ctx.sessionManager);
    return messages ? { messages } : undefined;
  });
  // Catalog diagnostics are transient: with a UI context they go through the
  // native notify channel; without UI/context they are written to stderr only.
  // Nothing is appended to the session, and stdout stays protocol-clean.
  let sessionContext: { hasUI: boolean; ui: { notify(message: string, type?: "info" | "warning" | "error"): void } } | undefined;
  const emitDiagnostic = (severity: "info" | "warning" | "error", message: string) => {
    notifyPlugin(sessionContext, message, severity);
  };
  const reportCatalogError = (message: string) => emitDiagnostic("error", message);
  // Suppress only notes identical to the immediately previous report — login
  // validation, refreshes and the metadata commands can compile the same
  // catalog back to back. When a note drops out of a report it may resurface,
  // and an empty report clears the dedupe state.
  const noteDedupe = makeConsecutiveNoteDedupe();
  const reportCatalogNotes = (notes: readonly string[]) => {
    for (const note of noteDedupe(notes)) {
      emitDiagnostic("info", `metadata note: ${note}`);
    }
    packageCommands.backgroundCheck();
  };
  const getTransport = (ctx: { cwd: string; isProjectTrusted(): boolean }) => {
    try {
      return SettingsManager.create(ctx.cwd, getAgentDir(), {
        projectTrusted: ctx.isProjectTrusted(),
      }).getTransport();
    } catch {
      return "auto";
    }
  };

  pi.registerCommand("provider-info", {
    description: "Show OpenAI API Extension connection status",
    handler: async (_args, ctx) => {
      const transport = getTransport(ctx);
      const auth = await ctx.modelRegistry.getProviderAuth(PROVIDER);
      const baseUrl = normalizeBaseUrl(auth?.auth.baseUrl);
      const apiKey = auth?.auth.apiKey?.trim();
      const sessionId = ctx.sessionManager.getSessionId();
      const actualTransport = baseUrl
        ? getActualResponsesTransport(baseUrl, sessionId) ?? "not connected yet"
        : "not connected yet";
      const lines = [
        "OpenAI API Extension:",
        `Transport: ${actualTransport}`,
        `Configured transport: ${transport}`,
        `Server: ${baseUrl ?? "not configured"}`,
      ];
      if (!baseUrl || !apiKey) {
        notifyPlugin(ctx, [
          ...lines,
          "Connection: ✗ not configured",
          "Models: 0",
        ].join("\n"), "warning");
        return;
      }

      try {
        const { models, notes } = await fetchEnrichedCatalog(baseUrl, apiKey, AbortSignal.timeout(CONNECTION_TIMEOUT_MS), dependencies.metadataCompile);
        notifyPlugin(ctx, [
          ...lines,
          "Connection: ✓ connected; API key valid",
          ...notes.map((note) => `Metadata note: ${note}`),
          `Models: ${models.length}`,
        ].join("\n"), "info", [apiKey]);
      } catch (error) {
        const reason = errorMessage(error).split(apiKey).join("[REDACTED]");
        // A metadata config error is not an auth failure: the key already
        // validated upstream before enrichment ran.
        const configError = error instanceof MetadataConfigError;
        notifyPlugin(ctx, [
          ...lines,
          configError ? "Connection: ✓ connected; API key valid" : "Connection: ✗ failed",
          configError ? `Metadata: ✗ config error: ${reason}` : `Reason: ${reason}`,
          "Models: 0",
        ].join("\n"), configError ? "warning" : "error", [apiKey]);
      }
    },
  });
  // No startup catalog prefetch: Pi restores the persisted catalog offline
  // after registration and refreshes it in the background once the UI is up.
  // Without a CLI cache, discovery needs pi --refresh --list-models;
  // interactive mode discovers models through Pi's own background refresh.
  pi.registerCommand("provider-metadata", {
    description: "Export compiled metadata, or check/update its data packages",
    handler: async (args, ctx) => {
      if (await packageCommands.handle(args, ctx)) return;
      const auth = await ctx.modelRegistry.getProviderAuth(PROVIDER);
      const baseUrl = normalizeBaseUrl(auth?.auth.baseUrl);
      const apiKey = auth?.auth.apiKey?.trim();
      if (!baseUrl || !apiKey) {
        notifyPlugin(ctx, "OpenAI API Extension: not configured", "warning");
        return;
      }
      let text: string;
      let failed = false;
      try {
        const entries = await fetchCatalog(baseUrl, apiKey, AbortSignal.timeout(CONNECTION_TIMEOUT_MS));
        let yaml: string | undefined;
        try {
          yaml = await readFile(join(getAgentDir(), METADATA_CONFIG_FILE), "utf8");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        const config = parseMetadataConfig(yaml);
        const publicIds = entries.flatMap((entry) => {
          if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return [];
          const row = entry as UpstreamModel;
          const id = entryIdentity(row)?.id;
          return id && isConversationalTextModel(row) ? [id] : [];
        });
        const compiled = (await compileCatalogInWorker(config, publicIds, dependencies.metadataCompile)).catalog;
        // Minimal read-only upstream context for the view: the same fetch's
        // rows normalized through the capability whitelist — never raw rows
        // or credentials.
        const upstreamFields: Record<string, MetadataFields> = {};
        for (const entry of entries) {
          if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
          const row = entry as UpstreamModel;
          const id = entryIdentity(row)?.id;
          if (id && isConversationalTextModel(row)) upstreamFields[id] = normalizeFields(row as Readonly<Record<string, unknown>>);
        }
        text = renderCompiledCatalog(compiled, upstreamFields);
      } catch (error) {
        failed = true;
        // A config error still produces a diagnostics file the user can page.
        const reason = errorMessage(error).split(apiKey).join("[REDACTED]");
        text = `${formatPluginOutput(`provider-metadata: ${reason}`, [apiKey])}\n`;
      }
      const file = writeMetadataTempFile(text);
      notifyPlugin(ctx, file, failed ? "warning" : "info");
    },
  });
  let settingsContext: { cwd: string; isProjectTrusted(): boolean } | undefined;
  pi.on("session_start", async (_event, ctx) => {
    settingsContext = ctx;
    // Latest interactive context wins; a stale reference is dropped on shutdown.
    sessionContext = ctx;
    packageCommands.setSession(ctx);
  });
  pi.on("session_shutdown", async () => {
    sessionContext = undefined;
    await packageCommands.shutdown();
  });
  pi.registerProvider(createOpenAIApiProvider([], reportCatalogError, () => {
    try {
      const settings = SettingsManager.create(settingsContext?.cwd ?? process.cwd(), getAgentDir(), {
        projectTrusted: settingsContext?.isProjectTrusted() ?? false,
      });
      // Raw public snapshots work on stock too; never read/materialize native defaults.
      const global = settings.getGlobalSettings() as Record<string, unknown>;
      const project = settings.getProjectSettings() as Record<string, unknown>;
      return Object.hasOwn(project, "responseCheckpointExclude") ? project.responseCheckpointExclude : global.responseCheckpointExclude;
    } catch {
      return ["*"]; // Unreadable policy must not enable storage.
    }
  }, () => {
    try {
      const settings = SettingsManager.create(settingsContext?.cwd ?? process.cwd(), getAgentDir(), {
        projectTrusted: settingsContext?.isProjectTrusted() ?? false,
      });
      const global = settings.getGlobalSettings() as Record<string, unknown>;
      const project = settings.getProjectSettings() as Record<string, unknown>;
      return Object.hasOwn(project, "responseCheckpointMode") ? project.responseCheckpointMode : global.responseCheckpointMode;
    } catch {
      return "declared"; // Unreadable mode must not widen eligibility.
    }
  }, reportCatalogNotes, dependencies.metadataCompile));
}
