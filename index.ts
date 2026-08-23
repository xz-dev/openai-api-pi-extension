/**
 * Pi provider for OpenAI-compatible gateways exposing the Responses API.
 *
 * Configuration (environment values override stored fields independently):
 * - /login openai-api-extension
 * - OPENAI_API_EXTENSION_BASE_URL / OPENAI_API_EXTENSION_API_KEY
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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
const DEFAULT_CONTEXT_WINDOW = 128000;
const DEFAULT_MAX_TOKENS = 16384;

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

type UpstreamModel = {
  id?: unknown;
  name?: unknown;
  display_name?: unknown;
  context_window?: unknown;
  context_length?: unknown;
  max_tokens?: unknown;
  max_output_tokens?: unknown;
  max_completion_tokens?: unknown;
};

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

export type GatewayModel = Model<"openai-responses">;

/** Maps an OpenAI-compatible /models payload entry to a Pi model. */
export function mapModel(entry: unknown, baseUrl = DEFAULT_BASE_URL): GatewayModel | undefined {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return undefined;
  const row = entry as UpstreamModel;
  const id = typeof row.id === "string" ? row.id.trim() : "";
  if (!id) return undefined;
  const name =
    [row.name, row.display_name].find((value): value is string => typeof value === "string" && value.trim() !== "")
      ?.trim() ?? id;
  return {
    id,
    name,
    provider: PROVIDER,
    api: "openai-responses",
    baseUrl,
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: num(row.context_window) ?? num(row.context_length) ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens:
      num(row.max_output_tokens) ?? num(row.max_completion_tokens) ?? num(row.max_tokens) ?? DEFAULT_MAX_TOKENS,
  };
}

/** Fetches and maps the gateway catalog; throws on HTTP or invalid/empty catalogs. */
export async function fetchModels(baseUrl: string, apiKey: string, signal?: AbortSignal): Promise<GatewayModel[]> {
  const response = await fetch(`${baseUrl}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal,
  });
  if (!response.ok) throw new Error(`Model discovery failed: HTTP ${response.status}`);
  const payload: unknown = await response.json();
  const rows =
    typeof payload === "object" && payload !== null && Array.isArray((payload as { data?: unknown }).data)
      ? (payload as { data: unknown[] }).data
      : [];
  const models = rows
    .flatMap((entry) => {
      const model = mapModel(entry, baseUrl);
      return model ? [model] : [];
    })
    .sort((left, right) => left.id.localeCompare(right.id));
  if (models.length === 0) throw new Error("Model discovery returned no usable models");
  return models;
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
      const models = await fetchModels(baseUrl, apiKey, interaction.signal);
      onValidated(baseUrl, apiKey, models);
      interaction.notify({ type: "info", message: `Found ${models.length} models.` });
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

export function createOpenAIApiProvider(initialModels: readonly GatewayModel[] = []): Provider<"openai-responses"> {
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
      const refreshed = await fetchModels(baseUrl, apiKey, context.signal);
      if (context.signal.aborted) return;
      await context.publish({
        persist: { models: refreshed, checkedAt: Date.now() },
        update: () => { models = refreshed; },
      });
    },
    stream: (model, context, options) => api.stream(model, context, options),
    streamSimple: (model, context, options) => api.streamSimple(model, context, options),
  };
  return provider;
}

export default async function (pi: ExtensionAPI): Promise<void> {
  const baseUrl = normalizeBaseUrl(process.env[ENV_BASE_URL]);
  const apiKey = process.env[ENV_API_KEY]?.trim();
  let models: readonly GatewayModel[] = [];
  if (!process.env.PI_OFFLINE && baseUrl && apiKey) {
    try {
      models = await fetchModels(baseUrl, apiKey, AbortSignal.timeout(15_000));
    } catch (error) {
      console.warn(
        `[openai-api-extension] model discovery failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  pi.registerProvider(createOpenAIApiProvider(models));
}
