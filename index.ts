/**
 * Minimal Pi provider extension for any OpenAI-compatible gateway via the
 * OpenAI Responses API.
 *
 * Configuration (either way; env wins when both are set):
 * 1. `/login openai-api-extension` — prompts for gateway base URL and API key,
 *    validates via GET {baseUrl}/models, and stores both in auth.json.
 * 2. Env vars: OPENAI_API_EXTENSION_BASE_URL / OPENAI_API_EXTENSION_API_KEY
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";

const PROVIDER = "openai-api-extension";
const PROVIDER_NAME = "OpenAI API Extension";
const ENV_BASE_URL = "OPENAI_API_EXTENSION_BASE_URL";
const ENV_API_KEY = "OPENAI_API_EXTENSION_API_KEY";
const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_CONTEXT_WINDOW = 128000;
const DEFAULT_MAX_TOKENS = 16384;
const CREDENTIAL_TTL_MS = 365 * 24 * 60 * 60 * 1000;

/** Normalizes a user-supplied base URL: trims, strips trailing slashes, http(s) only. */
export function normalizeBaseUrl(raw: string | undefined): string | undefined {
  const value = raw?.trim().replace(/\/+$/, "");
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
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

export type GatewayModel = {
  id: string;
  name: string;
  reasoning: boolean;
  input: string[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
};

/** Maps an OpenAI-compatible /models payload entry to a pi model config. */
export function mapModel(entry: UpstreamModel): GatewayModel | undefined {
  const id = typeof entry.id === "string" ? entry.id.trim() : "";
  if (!id) return undefined;
  const name =
    [entry.name, entry.display_name].find((v): v is string => typeof v === "string" && v.trim() !== "")?.trim() ?? id;
  return {
    id,
    name,
    // The gateway is trusted to accept and normalize reasoning parameters for
    // every served model; per-model overrides live in ~/.pi/agent/models.json.
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: num(entry.context_window) ?? num(entry.context_length) ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens:
      num(entry.max_output_tokens) ?? num(entry.max_completion_tokens) ?? num(entry.max_tokens) ?? DEFAULT_MAX_TOKENS,
  };
}

/** Fetches and maps the gateway catalog; throws on HTTP or empty-catalog errors. */
export async function fetchModels(baseUrl: string, apiKey: string): Promise<GatewayModel[]> {
  const response = await fetch(`${baseUrl}/models`, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!response.ok) throw new Error(`GET ${baseUrl}/models failed: HTTP ${response.status}`);
  const payload = (await response.json()) as { data?: UpstreamModel[] };
  const models = (Array.isArray(payload.data) ? payload.data : [])
    .flatMap((entry) => {
      const model = mapModel(entry);
      return model ? [model] : [];
    })
    .sort((left, right) => left.id.localeCompare(right.id));
  if (models.length === 0) throw new Error(`${baseUrl}/models returned no usable models`);
  return models;
}

// --- /login credential storage (base URL rides in the OAuth refresh field) ---

export function encodeRefreshMeta(baseUrl: string): string {
  return JSON.stringify({ baseUrl });
}

export function decodeRefreshMeta(refresh: unknown): string | undefined {
  if (typeof refresh !== "string" || !refresh.trim()) return undefined;
  try {
    const parsed = JSON.parse(refresh) as { baseUrl?: unknown };
    if (typeof parsed.baseUrl === "string" && parsed.baseUrl.trim()) return parsed.baseUrl.trim();
  } catch {
    // Ignore non-JSON refresh payloads.
  }
  return undefined;
}

function loadStoredConnection(agentDir: string): { baseUrl?: string; apiKey?: string } {
  try {
    const auth = JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf8")) as Record<string, unknown>;
    const entry = auth[PROVIDER];
    if (!entry || typeof entry !== "object") return {};
    const record = entry as { refresh?: unknown; access?: unknown };
    return {
      baseUrl: decodeRefreshMeta(record.refresh),
      apiKey: typeof record.access === "string" && record.access ? record.access : undefined,
    };
  } catch {
    return {};
  }
}

// --- provider registration ---

function register(pi: ExtensionAPI, agentDir: string, options: { baseUrl: string; apiKey?: string; models: GatewayModel[] }): void {
  // OAuth-only when a /login credential exists so `/login openai-api-extension` skips
  // the api-key-vs-account selector; apiKey is passed only for env setups.
  pi.unregisterProvider(PROVIDER);
  pi.registerProvider(PROVIDER, {
    name: PROVIDER_NAME,
    baseUrl: options.baseUrl,
    ...(options.apiKey ? { apiKey: options.apiKey } : {}),
    api: "openai-responses",
    models: options.models,
    oauth: createOAuthHandlers(pi, agentDir),
  });
}

function createOAuthHandlers(pi: ExtensionAPI, agentDir: string) {
  return {
    name: PROVIDER_NAME,

    async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
      while (true) {
        const baseUrlInput = await callbacks.onPrompt({
          message: `Gateway base URL [${DEFAULT_BASE_URL}]:`,
          placeholder: DEFAULT_BASE_URL,
          allowEmpty: true,
        });
        const baseUrl = normalizeBaseUrl(baseUrlInput) ?? DEFAULT_BASE_URL;
        const apiKey = (
          await callbacks.onPrompt({ message: "Gateway API key:", placeholder: "sk-...", allowEmpty: false })
        ).trim();
        if (!apiKey) {
          callbacks.onProgress?.("API key cannot be empty.");
          continue;
        }

        callbacks.onProgress?.("Validating credentials via the models endpoint...");
        try {
          const models = await fetchModels(baseUrl, apiKey);
          register(pi, agentDir, { baseUrl, models }); // oauth-only: credential is stored by pi
          callbacks.onProgress?.(`Registered ${models.length} models from ${baseUrl}.`);
          return { refresh: encodeRefreshMeta(baseUrl), access: apiKey, expires: Date.now() + CREDENTIAL_TTL_MS };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          callbacks.onProgress?.(`Validation failed: ${message}\nRe-enter base URL and API key.`);
        }
      }
    },

    async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
      return { ...credentials, expires: Date.now() + CREDENTIAL_TTL_MS }; // API keys do not expire.
    },

    getApiKey(credentials: OAuthCredentials): string {
      return credentials.access;
    },
  };
}

export default async function (pi: ExtensionAPI): Promise<void> {
  const agentDir = getAgentDir();
  const stored = loadStoredConnection(agentDir);
  const baseUrl = normalizeBaseUrl(process.env[ENV_BASE_URL]) ?? stored.baseUrl;
  const envKey = process.env[ENV_API_KEY]?.trim() || undefined;
  const apiKey = envKey ?? stored.apiKey;

  if (!baseUrl || !apiKey) {
    register(pi, agentDir, { baseUrl: baseUrl ?? DEFAULT_BASE_URL, models: [] }); // visible in /login immediately.
    console.info(
      `[openai-api-extension] not configured. Use /login ${PROVIDER}, or set ${ENV_BASE_URL} and ${ENV_API_KEY}.`,
    );
    return;
  }

  try {
    const models = await fetchModels(baseUrl, apiKey);
    register(pi, agentDir, { baseUrl, apiKey: stored.apiKey ? undefined : envKey, models });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[openai-api-extension] model discovery failed (${message}); starting without models.`);
    register(pi, agentDir, { baseUrl, apiKey: stored.apiKey ? undefined : envKey, models: [] });
  }
}
