import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROVIDER = "openai-api";
const PROVIDER_DISPLAY_NAME = "OpenAI API";
const DEFAULT_CONTEXT_WINDOW = 128000;
const DEFAULT_MAX_TOKENS = 16384;

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

/** Maps an OpenAI-compatible /models payload entry to a pi Responses-API model config. */
export function mapModel(entry: UpstreamModel) {
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

/**
 * Async factory: discovers the catalog before startup finishes (the documented
 * pattern for remote model lists), then registers the provider.
 */
export default async function (pi: ExtensionAPI) {
  const baseUrl = normalizeBaseUrl(process.env.OPENAI_API_BASE_URL);
  if (!baseUrl) return; // Inert unless OPENAI_API_BASE_URL is configured.

  const response = await fetch(`${baseUrl}/models`, {
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY ?? ""}` },
  });
  if (!response.ok) throw new Error(`GET ${baseUrl}/models failed: HTTP ${response.status}`);
  const payload = (await response.json()) as { data?: UpstreamModel[] };
  const models = (Array.isArray(payload.data) ? payload.data : [])
    .flatMap((entry) => {
      const model = mapModel(entry);
      return model ? [model] : [];
    })
    .sort((left, right) => left.id.localeCompare(right.id));
  if (models.length === 0) throw new Error(`${baseUrl}/models returned no usable models`);

  pi.registerProvider(PROVIDER, {
    name: PROVIDER_DISPLAY_NAME,
    baseUrl,
    apiKey: "$OPENAI_API_KEY",
    api: "openai-responses",
    models,
  });
}
