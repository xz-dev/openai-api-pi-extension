/**
 * Pi provider for OpenAI-compatible gateways exposing the Responses API.
 *
 * Configuration (environment values override stored fields independently):
 * - /login openai-api-extension
 * - OPENAI_API_EXTENSION_BASE_URL / OPENAI_API_EXTENSION_API_KEY
 */
import { type ExtensionAPI, VERSION } from "@earendil-works/pi-coding-agent";
import {
  type ApiKeyAuth,
  type ApiKeyCredential,
  type AuthContext,
  type AuthResult,
  type Model,
  type Provider,
  type RefreshModelsContext,
} from "@earendil-works/pi-ai";
import { openAIResponsesApi } from "@earendil-works/pi-ai/compat";

const PROVIDER = "openai-api-extension";
const PROVIDER_NAME = "OpenAI API Extension";
const ENV_BASE_URL = "OPENAI_API_EXTENSION_BASE_URL";
const ENV_API_KEY = "OPENAI_API_EXTENSION_API_KEY";
const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const ERROR_ENTRY = "openai-api-extension.error";

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
  context_window?: unknown;
  context_length?: unknown;
  max_tokens?: unknown;
  max_output_tokens?: unknown;
  max_completion_tokens?: unknown;
  input_modalities?: unknown;
  supported_reasoning_levels?: unknown;
  capabilities?: unknown;
};

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

/** Maps an OpenAI-compatible /models payload entry to a Pi model. */
export function mapModel(entry: unknown, baseUrl = DEFAULT_BASE_URL): GatewayModel | undefined {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return undefined;
  const row = entry as UpstreamModel;
  const id = [row.id, row.slug].find((value): value is string => typeof value === "string" && value.trim() !== "")?.trim();
  if (!id) return undefined;
  const contextWindow = num(row.context_window) ?? num(row.context_length);
  const maxTokens = num(row.max_output_tokens) ?? num(row.max_completion_tokens) ?? num(row.max_tokens);
  if (!contextWindow) throw new Error(`Model ${id} is missing capability limits`);
  // Gateways commonly omit output-token limits; the model's own context
  // window is the gateway-declared upper bound, so use it rather than
  // rejecting the whole catalog.
  const resolvedMaxTokens = maxTokens ?? contextWindow;
  const name =
    [row.name, row.display_name].find((value): value is string => typeof value === "string" && value.trim() !== "")
      ?.trim() ?? id;
  const map = thinkingLevelMap(
    parseEfforts(
      row.supported_reasoning_levels ?? (isRecord(row.capabilities) ? row.capabilities.effort_tiers : undefined),
    ),
  );
  return {
    id,
    name,
    provider: PROVIDER,
    api: "openai-responses",
    baseUrl,
    reasoning: map !== undefined,
    ...(map ? { thinkingLevelMap: map } : {}),
    input: Array.isArray(row.input_modalities) && row.input_modalities.includes("image") ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens: resolvedMaxTokens,
  };
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
    throw new Error(`Model discovery failed: HTTP ${response.status}${body ? `: ${body}` : ""}`);
  }
  const payload: unknown = await response.json();
  if (typeof payload !== "object" || payload === null || !Array.isArray((payload as { models?: unknown }).models)) {
    throw new Error("Model discovery did not return a Codex model catalog");
  }
  return (payload as { models: unknown[] }).models;
}

/** Maps a raw catalog atomically: any unusable entry rejects the whole list, never a partial one. */
export function mapCatalog(entries: readonly unknown[], baseUrl = DEFAULT_BASE_URL): GatewayModel[] {
  const models = entries
    .map((entry) => {
      const model = mapModel(entry, baseUrl);
      if (!model) throw new Error("Model discovery returned an invalid catalog entry");
      return model;
    })
    .sort((left, right) => left.id.localeCompare(right.id));
  if (models.length === 0) throw new Error("Model discovery returned no usable models");
  return models;
}

/** Fetches and maps the gateway catalog atomically; throws on transport, shape, or entry-level failures. */
export async function fetchModels(baseUrl: string, apiKey: string, signal?: AbortSignal): Promise<GatewayModel[]> {
  return mapCatalog(await fetchCatalog(baseUrl, apiKey, signal), baseUrl);
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
        const models = mapCatalog(entries, baseUrl);
        onValidated(baseUrl, apiKey, models);
        interaction.notify({ type: "info", message: `Found ${models.length} models.` });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        interaction.notify({
          type: "info",
          message: `Connected, but the model catalog is not usable: ${reason} API key saved; models were not updated.`,
        });
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
): Provider<"openai-responses"> {
  let models = initialModels;
  let initialModelsPublished = false;
  let validatedLogin:
    | { baseUrl: string; apiKey: string; models: readonly GatewayModel[]; checkedAt: number }
    | undefined;
  const api = openAIResponsesApi();
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
        const refreshed = await fetchModels(baseUrl, apiKey, context.signal);
        if (context.signal.aborted) return;
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
    stream: (model, context, options) => api.stream(model, context, options),
    streamSimple: (model, context, options) => api.streamSimple(model, context, options),
  };
  return provider;
}

export default async function (pi: ExtensionAPI): Promise<void> {
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
  const baseUrl = normalizeBaseUrl(process.env[ENV_BASE_URL]);
  const apiKey = process.env[ENV_API_KEY]?.trim();
  let models: readonly GatewayModel[] = [];
  if (!process.env.PI_OFFLINE && baseUrl && apiKey) {
    try {
      models = await fetchModels(baseUrl, apiKey, AbortSignal.timeout(15_000));
    } catch (error) {
      console.warn(`[openai-api-extension] model discovery failed: ${errorMessage(error)}`);
    }
  }
  pi.registerProvider(createOpenAIApiProvider(models, reportCatalogError));
}
