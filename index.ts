/**
 * Pi provider for OpenAI-compatible gateways exposing the Responses API.
 *
 * Configuration (environment values override stored fields independently):
 * - /login openai-api-extension
 * - OPENAI_API_EXTENSION_BASE_URL / OPENAI_API_EXTENSION_API_KEY
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, SettingsManager, VERSION } from "@earendil-works/pi-coding-agent";
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
import {
  createMetadataResolver,
  fetchMetadataSources,
  neededSites,
} from "./metadata-sources.ts";
import { MetadataConfigError, parseMetadataConfig } from "./model-metadata.ts";
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
const ERROR_ENTRY = "openai-api-extension.error";
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
  // last so fill_missing_only can see real missing values upstream.
  const resolvedMaxTokens = maxTokens ?? contextWindow;
  const map = thinkingLevelMap(
    parseEfforts(
      pick("supported_reasoning_levels") ??
        (isRecord(row.capabilities) ? row.capabilities.effort_tiers : undefined),
    ),
  );
  const inputModalities = pick("input_modalities");
  const name = firstString(meta.name, meta.display_name) ?? identity.name;
  return {
    id: identity.id,
    name,
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
 * The single enriched-catalog path shared by startup prefetch, login
 * validation, refreshModels, and /provider-info. Reads the YAML config once
 * per call, fetches only the sites the resolved chains need (shared per
 * refresh), then maps the upstream catalog.
 * - Missing config file = empty config (built-in default chain applies).
 * - MetadataConfigError (invalid known values / bad YAML) propagates: callers
 *   keep the previous catalog and must not surface it as an auth failure.
 * - Failed sources degrade to upstream-mapped models with a note.
 * - Caller-abort propagates; a source phase that outlives the caller's
 *   deadline degrades to upstream-only so a slow metadata host never drops
 *   an already-valid gateway catalog.
 */
export async function enrichCatalog(
  entries: readonly unknown[],
  baseUrl: string,
  signal: AbortSignal | undefined,
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
  // One aggregated warning per refresh listing every ignored field path.
  const notes = config.warnings.length > 0
    ? [`ignored unsupported fields: ${config.warnings.join(", ")}`]
    : [];
  const publicIds = entries.flatMap((entry) => {
    const id =
      typeof entry === "object" && entry !== null && !Array.isArray(entry)
        ? entryIdentity(entry as UpstreamModel)?.id
        : undefined;
    return id ? [id] : [];
  });
  const needed = neededSites(config, publicIds);
  let records: Awaited<ReturnType<typeof fetchMetadataSources>>["records"] = [];
  if (needed.size > 0 && !signal?.aborted) {
    try {
      const result = await fetchMetadataSources(needed, signal);
      records = result.records;
      for (const site of result.failed) notes.push(`metadata source ${site} unavailable; using upstream values`);
      for (const site of result.malformed) {
        if (!result.failed.has(site)) notes.push(`metadata source ${site} returned no usable records; using upstream values`);
      }
    } catch (error) {
      if (!signal?.aborted) throw error;
      // The shared deadline fired inside the source phase: degrade instead of
      // dropping a verified gateway catalog.
      notes.push("metadata sources timed out; using upstream values");
    }
  }
  const resolver = createMetadataResolver(config, records);
  const models = mapCatalog(entries, baseUrl, resolver.resolve);
  for (const diagnostic of resolver.diagnostics) {
    notes.push(`metadata ambiguity: ${diagnostic.detail} (selector ${diagnostic.token}); source skipped`);
  }
  return { models, notes };
}

export async function fetchEnrichedCatalog(
  baseUrl: string,
  apiKey: string,
  signal: AbortSignal | undefined,
): Promise<CatalogEnrichment> {
  return enrichCatalog(await fetchCatalog(baseUrl, apiKey, signal), baseUrl, signal);
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
): ApiKeyAuth {
  return {
    name: `${PROVIDER_NAME} connection`,
    login: async (interaction): Promise<ApiKeyCredential> => {
      const enteredBaseUrl = await interaction.prompt({
        type: "text",
        message: "Gateway base URL",
        placeholder: DEFAULT_BASE_URL,
      });
      interaction.signal.throwIfAborted();
      const baseUrl = normalizeBaseUrl(enteredBaseUrl || DEFAULT_BASE_URL);
      if (!baseUrl) throw new Error("Gateway base URL must be an HTTP(S) URL");

      const apiKey = (
        await interaction.prompt({ type: "secret", message: "Gateway API key", placeholder: "sk-..." })
      ).trim();
      interaction.signal.throwIfAborted();
      if (!apiKey) throw new Error("Gateway API key cannot be empty");

      interaction.notify({ type: "progress", message: "Validating connection..." });
      const entries = await fetchCatalog(baseUrl, apiKey, interaction.signal);
      try {
        const { models, notes } = await enrichCatalog(entries, baseUrl, interaction.signal);
        // A cancelled login must not publish the catalogue it fetched.
        interaction.signal.throwIfAborted();
        onValidated(baseUrl, apiKey, models);
        for (const note of notes) interaction.notify({ type: "info", message: `Metadata: ${note}` });
        interaction.notify({ type: "info", message: `Found ${models.length} models.` });
      } catch (error) {
        // Caller cancel is not a catalog problem: propagate, never degrade.
        interaction.signal.throwIfAborted();
        const reason = errorMessage(error);
        // Config failures must not look like an invalid API key or an unusable catalog.
        const message =
          error instanceof MetadataConfigError
            ? `Connected, but the metadata config is invalid: ${reason} API key saved; models were not updated.`
            : `Connected, but the model catalog is not usable: ${reason} API key saved; models were not updated.`;
        interaction.notify({ type: "info", message });
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
      }),
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
        const { models: refreshed, notes } = await fetchEnrichedCatalog(baseUrl, apiKey, context.signal);
        if (context.signal.aborted) return;
        for (const note of notes) {
          try {
            onCatalogError?.(`metadata note: ${note}`);
          } catch {
            /* reporter must not mask the refresh */
          }
        }
        await context.publish({
          persist: { models: refreshed, checkedAt: Date.now() },
          update: () => { models = refreshed; },
        });
      } catch (error) {
        if (!isAbortError(error, context.signal)) {
          try {
            onCatalogError?.(errorMessage(error));
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

export default async function (pi: ExtensionAPI): Promise<void> {
  pi.on("context", (event, ctx) => {
    const messages = adoptResponseAncestry(event.messages, ctx.sessionManager);
    return messages ? { messages } : undefined;
  });
  pi.registerEntryRenderer(ERROR_ENTRY, (entry, _options, theme) => {
    const message =
      typeof (entry.data as { message?: unknown } | undefined)?.message === "string"
        ? (entry.data as { message: string }).message
        : "catalog refresh failed";
    return {
      render(width: number) {
        const text = `[openai-api-extension] ${message}`;
        const size = Math.max(width, 1);
        const lines: string[] = [];
        for (let i = 0; i < text.length; i += size) lines.push(theme.fg("error", text.slice(i, i + size)));
        return lines;
      },
      invalidate() {},
    };
  });
  const reportCatalogError = (message: string) => {
    try {
      pi.appendEntry(ERROR_ENTRY, { message });
    } catch {
      console.warn(`[openai-api-extension] ${message}`);
    }
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
        ctx.ui.notify([
          ...lines,
          "Connection: ✗ not configured",
          "Models: 0",
        ].join("\n"), "warning");
        return;
      }

      try {
        const { models, notes } = await fetchEnrichedCatalog(baseUrl, apiKey, AbortSignal.timeout(CONNECTION_TIMEOUT_MS));
        ctx.ui.notify([
          ...lines,
          "Connection: ✓ connected; API key valid",
          ...notes.map((note) => `Metadata note: ${note}`),
          `Models: ${models.length}`,
        ].join("\n"), "info");
      } catch (error) {
        const reason = errorMessage(error).split(apiKey).join("[REDACTED]");
        // A metadata config error is not an auth failure: the key already
        // validated upstream before enrichment ran.
        const configError = error instanceof MetadataConfigError;
        ctx.ui.notify([
          ...lines,
          configError ? "Connection: ✓ connected; API key valid" : "Connection: ✗ failed",
          configError ? `Metadata: ✗ config error: ${reason}` : `Reason: ${reason}`,
          "Models: 0",
        ].join("\n"), configError ? "warning" : "error");
      }
    },
  });
  const baseUrl = normalizeBaseUrl(process.env[ENV_BASE_URL]);
  const apiKey = process.env[ENV_API_KEY]?.trim();
  let models: readonly GatewayModel[] = [];
  if (!process.env.PI_OFFLINE && baseUrl && apiKey) {
    try {
      const enriched = await fetchEnrichedCatalog(baseUrl, apiKey, AbortSignal.timeout(CONNECTION_TIMEOUT_MS));
      models = enriched.models;
      for (const note of enriched.notes) console.warn(`[openai-api-extension] ${note}`);
    } catch (error) {
      const label = error instanceof MetadataConfigError ? "metadata config" : "model discovery";
      console.warn(`[openai-api-extension] ${label} failed: ${errorMessage(error)}`);
    }
  }
  let settingsContext: { cwd: string; isProjectTrusted(): boolean } | undefined;
  pi.on("session_start", async (_event, ctx) => { settingsContext = ctx; });
  pi.registerProvider(createOpenAIApiProvider(models, reportCatalogError, () => {
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
  }));
}
