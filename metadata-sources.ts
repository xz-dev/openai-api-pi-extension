/**
 * Public bulk metadata sources for the fallback chain: models.dev (api.json +
 * flat models.json) and modelparams.dev (api/v1/models.json).
 *
 * Guardrails per spec: fixed HTTPS endpoints, no gateway credentials or user
 * model lists are ever sent, one shared read per endpoint per refresh, 16 MiB
 * response cap, 5 s timeout bounded by the caller's signal, and cross-origin
 * redirects are refused. A failed source only degrades the models whose
 * resolved chain depends on it.
 */
import {
  classifyAccess,
  type MetadataSite,
  type SourceRecord,
} from "./model-metadata.ts";

/** Endpoint URLs are variables so tests can point them at a loopback server. */
export const SOURCE_URLS = {
  modelsDevApi: "https://models.dev/api.json",
  modelsDevFlat: "https://models.dev/models.json",
  modelparams: "https://modelparams.dev/api/v1/models.json",
} as const;

const MAX_SOURCE_BYTES = 16 << 20;
const SOURCE_TIMEOUT_MS = 5_000;

export type SourceFetchResult = {
  records: SourceRecord[];
  /** Sites whose fetch failed; dependent selectors degrade instead of failing the refresh. */
  failed: ReadonlySet<MetadataSite>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.trim() !== "")?.trim();
}

/** Bounded JSON GET with caller cancellation; refuses cross-origin redirects. */
async function readSource(url: string, signal: AbortSignal | undefined): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("metadata source timed out")), SOURCE_TIMEOUT_MS);
  const onAbort = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  try {
    const response = await fetch(url, { redirect: "manual", signal: controller.signal });
    try {
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location") ?? "";
        throw new Error(`metadata source redirected to ${location || "another origin"}`);
      }
      if (!response.ok) throw new Error(`metadata source HTTP ${response.status}`);
      const body = await response.text();
      if (body.length > MAX_SOURCE_BYTES) throw new Error("metadata source exceeded 16 MiB");
      return JSON.parse(body);
    } finally {
      await response.body?.cancel().catch(() => undefined);
    }
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onAbort);
  }
}

// ---------------------------------------------------------------------------
// Normalization into SourceRecord entries (only fields mapModel consumes).
// ---------------------------------------------------------------------------

function effortValuesToLevels(values: unknown): unknown[] | undefined {
  if (!Array.isArray(values)) return undefined;
  return values.map((value) => (isRecord(value) ? value : { effort: value }));
}

/** api.json hit: provider-keyed map; `id` may alias the model inside the provider. */
function normalizeModelsDevRecord(provider: string, key: string, raw: Record<string, unknown>): SourceRecord {
  const limit = isRecord(raw.limit) ? raw.limit : {};
  const modalities = isRecord(raw.modalities) ? raw.modalities : {};
  const fields: Record<string, unknown> = {
    name: firstString(raw.name),
    context_window: limit.context,
    max_input_tokens: limit.input,
    max_output_tokens: limit.output,
    input_modalities: modalities.input,
    output_modalities: modalities.output,
  };
  if (Array.isArray(raw.reasoning_options)) {
    for (const option of raw.reasoning_options) {
      if (isRecord(option) && firstString(option.type) === "effort") {
        fields.supported_reasoning_levels = effortValuesToLevels(option.values);
      }
    }
  }
  return {
    site: "models.dev",
    provider: provider.toLowerCase(),
    modelId: key,
    canonicalModelId: firstString(raw.canonical_model_id),
    fields,
  };
}

function indexModelsDevApi(payload: unknown): SourceRecord[] {
  const out: SourceRecord[] = [];
  if (!isRecord(payload)) return out;
  for (const [provider, entry] of Object.entries(payload)) {
    if (!isRecord(entry) || !isRecord(entry.models)) continue;
    for (const [key, raw] of Object.entries(entry.models)) {
      if (!isRecord(raw)) continue;
      const record = normalizeModelsDevRecord(provider, key, raw);
      out.push(record);
      // m.id is an in-namespace alias of the same record, not a new product.
      const alias = firstString(raw.id);
      if (alias && alias !== key) {
        out.push({ ...record, modelId: alias });
      }
    }
  }
  return out;
}

/** flat models.json: keys are "<provider>/<model>"; keys without "/" are skipped. */
function indexModelsDevFlat(payload: unknown): SourceRecord[] {
  const out: SourceRecord[] = [];
  if (!isRecord(payload)) return out;
  for (const [key, raw] of Object.entries(payload)) {
    if (!isRecord(raw)) continue;
    const slash = key.indexOf("/");
    if (slash <= 0 || slash === key.length - 1) continue;
    out.push(normalizeModelsDevRecord(key.slice(0, slash), key.slice(slash + 1), raw));
  }
  return out;
}

/** modelparams records carry provider/authType/model/params. */
function indexModelparams(payload: unknown): SourceRecord[] {
  const out: SourceRecord[] = [];
  const models = isRecord(payload) && Array.isArray(payload.models) ? payload.models : [];
  for (const raw of models) {
    if (!isRecord(raw)) continue;
    const modelId = firstString(raw.model);
    const provider = firstString(raw.provider);
    if (!modelId || !provider) continue;
    const fields: Record<string, unknown> = {};
    if (Array.isArray(raw.params)) {
      for (const param of raw.params) {
        if (!isRecord(param)) continue;
        const path = firstString(param.path);
        const rangeMax = isRecord(param.range) ? param.range.max : undefined;
        switch (path) {
          case "max_completion_tokens":
          case "max_tokens":
          case "max_output_tokens":
            fields.max_output_tokens = rangeMax;
            break;
          case "context_window":
          case "context_length":
            fields.context_window = rangeMax;
            break;
          case "reasoning_effort":
          case "reasoning.effort":
          case "output_config.effort":
            fields.supported_reasoning_levels = effortValuesToLevels(param.values);
            if (typeof param.default === "string") fields.default_reasoning_level = param.default;
            break;
        }
      }
    }
    out.push({
      site: "modelparams.dev",
      provider: provider.toLowerCase(),
      modelId,
      authType: raw.authType,
      fields,
    });
  }
  return out;
}

/**
 * Reads the bulk endpoints the resolved chains actually use, once per
 * refresh. `needed` holds the sites any model's chain touches; an absent site
 * is never requested.
 */
export async function fetchMetadataSources(
  needed: ReadonlySet<MetadataSite>,
  signal?: AbortSignal,
  urls: typeof SOURCE_URLS = SOURCE_URLS,
): Promise<SourceFetchResult> {
  const records: SourceRecord[] = [];
  const failed = new Set<MetadataSite>();
  const jobs: Array<Promise<void>> = [];

  if (needed.has("models.dev")) {
    // api.json is canonical; flat models.json only fills fields api.json lacks.
    const apiJob = readSource(urls.modelsDevApi, signal).catch(() => {
      failed.add("models.dev");
      return undefined;
    });
    const flatJob = readSource(urls.modelsDevFlat, signal).catch(() => {
      failed.add("models.dev");
      return undefined;
    });
    jobs.push(
      Promise.all([apiJob, flatJob]).then(([api, flat]) => {
        const apiRecords = api === undefined ? [] : indexModelsDevApi(api);
        const apiKeys = new Set(apiRecords.map((record) => `${record.provider} ${record.modelId}`));
        records.push(...apiRecords);
        if (flat === undefined) return;
        for (const record of indexModelsDevFlat(flat)) {
          const existing = apiKeys.has(`${record.provider} ${record.modelId}`)
            ? apiRecords.find(
                (item) => item.provider === record.provider && item.modelId === record.modelId,
              )
            : undefined;
          if (existing) {
            // Same full identity: flat only fills fields api.json lacks.
            for (const [key, value] of Object.entries(record.fields)) {
              if (existing.fields[key] === undefined) existing.fields[key] = value;
            }
          } else {
            records.push(record);
          }
        }
      }),
    );
  }

  if (needed.has("modelparams.dev")) {
    jobs.push(
      readSource(urls.modelparams, signal)
        .then((payload) => { records.push(...indexModelparams(payload)); })
        .catch(() => { failed.add("modelparams.dev"); }),
    );
  }

  await Promise.all(jobs);
  return { records, failed };
}

// ---------------------------------------------------------------------------
// Per-model resolution over the shared record list.
// ---------------------------------------------------------------------------

import {
  applyOverrides,
  mergeMetadata,
  mergeProviderPrefixMaps,
  resolveMetadataChain,
  resolveModelPolicy,
  type MetadataConfig,
  type ResolutionDiagnostic,
} from "./model-metadata.ts";

export type ResolvedModel = {
  fields: Record<string, unknown>;
  diagnostics: ResolutionDiagnostic[];
};

/**
 * Builds the mapCatalog `resolveMetadata` callback from the loaded config and
 * the shared source records of one refresh. Pure: the caller owns fetch order,
 * cancellation, and lifecycle publishing.
 */
export function createMetadataResolver(
  config: MetadataConfig,
  records: readonly SourceRecord[],
): (publicId: string, upstream: Readonly<Record<string, unknown>>) => Readonly<Record<string, unknown>> {
  return (publicId, upstream) => {
    const policy = resolveModelPolicy(config, publicId);
    const prefixMap = mergeProviderPrefixMaps(
      config.providerPrefixMap,
      policy.channel ? config.channels?.[policy.channel]?.providerPrefixMap : undefined,
    );
    // Query identity uses the channel-relative id so channel rules and prefix
    // maps see the same name the gateway used.
    const queryId = policy.channelId;
    const resolved =
      policy.sourcePriority.length > 0
        ? resolveMetadataChain(policy, publicId, queryId, prefixMap, records)
        : undefined;
    const merged = mergeMetadata(upstream, resolved?.fields ?? {}, policy.fillMissingOnly);
    return applyOverrides(merged, policy.overrides);
  };
}

/** Sites any selector in the effective chains needs across all public ids. */
export function neededSites(config: MetadataConfig, publicIds: readonly string[]): Set<MetadataSite> {
  const out = new Set<MetadataSite>();
  for (const id of publicIds) {
    const policy = resolveModelPolicy(config, id);
    for (const token of policy.sourcePriority) {
      const [site] = token.split("/");
      if (site === "*") {
        out.add("models.dev");
        out.add("modelparams.dev");
      } else if (site === "models.dev" || site === "modelparams.dev") {
        out.add(site);
      }
    }
  }
  return out;
}

export { classifyAccess };
