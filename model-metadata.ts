/**
 * Pure model-metadata resolution: YAML config validation, model-rule glob
 * selection, source-chain and fill_missing_only inheritance, source selector
 * parsing, query-identity mapping, and the two merge modes.
 *
 * No network or filesystem I/O here; metadata-sources.ts owns public bulk
 * endpoint reads and index.ts owns the provider lifecycle. Field names follow
 * the gateway metadata vocabulary (context_window, max_output_tokens,
 * supported_reasoning_levels, ...) shared by upstream catalogs and the public
 * sources; mapModel consumes them last so defaults never mask real missing
 * values.
 */
import { minimatch } from "minimatch";
import { parseDocument } from "yaml";

export type MetadataFields = Record<string, unknown>;

/** Sites this change can read. `*` in a selector expands to both. */
export const METADATA_SITES = ["models.dev", "modelparams.dev"] as const;
export type MetadataSite = (typeof METADATA_SITES)[number];

/** Default chain when root source_priority is absent: subscriptions first. */
export const DEFAULT_SOURCE_PRIORITY: readonly string[] = ["*/subscription", "*/api_key"];

/**
 * models.dev does not publish an access-type field. Providers in this set are
 * classified subscription for selector purposes; every other provider
 * (including ones added later) falls into the api_key group. Source: the
 * current models.dev catalog's subscription products.
 */
export const MODELS_DEV_SUBSCRIPTION_PROVIDERS: ReadonlySet<string> = new Set([
  "alibaba-coding-plan",
  "alibaba-coding-plan-cn",
  "github-copilot",
  "kuae-cloud-coding-plan",
  "minimax-cn-coding-plan",
  "minimax-coding-plan",
  "tencent-coding-plan",
  "umans-ai-coding-plan",
  "volcengine-coding-plan",
  "zai-coding-plan",
  "zhipuai-coding-plan",
]);

export type ModelRule = {
  sourcePriority?: readonly string[];
  fillMissingOnly?: boolean;
  lookupIds?: Readonly<Record<string, string>>;
  overrides?: Readonly<Record<string, unknown>>;
};

export type ChannelConfig = {
  sourcePriority?: readonly string[];
  globalFallback?: boolean;
  fillMissingOnly?: boolean;
  providerPrefixMap?: Readonly<Record<string, readonly string[]>>;
  /** Legacy exact-name overrides: overrides.<model> -> fields. */
  overrides?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  models?: Readonly<Record<string, ModelRule>>;
};

export type MetadataConfig = {
  /** undefined = absent (use built-in default); [] = explicit opt-out. */
  sourcePriority?: readonly string[];
  fillMissingOnly?: boolean;
  providerPrefixMap?: Readonly<Record<string, readonly string[]>>;
  models?: Readonly<Record<string, ModelRule>>;
  channels?: Readonly<Record<string, ChannelConfig>>;
  /** Full dotted paths of ignored unknown fields, in document order. */
  warnings: readonly string[];
};

export class MetadataConfigError extends Error {
  readonly path: string;
  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "MetadataConfigError";
    this.path = path;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const KNOWN_ROOT_KEYS = new Set([
  "source_priority",
  "fill_missing_only",
  "provider_prefix_map",
  "models",
  "channels",
]);
const KNOWN_CHANNEL_KEYS = new Set([
  "source_priority",
  "global_fallback",
  "fill_missing_only",
  "provider_prefix_map",
  "overrides",
  "models",
]);
const KNOWN_MODEL_KEYS = new Set(["source_priority", "fill_missing_only", "lookup_ids", "overrides"]);

function readBool(value: unknown, path: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new MetadataConfigError(path, "expected a boolean");
  return value;
}

function readChain(value: unknown, path: string): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new MetadataConfigError(path, "expected a list of source selector strings");
  }
  for (const token of value as string[]) parseSelector(token, `${path} item ${JSON.stringify(token)}`);
  return value as readonly string[];
}

function readStringMap(value: unknown, path: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new MetadataConfigError(path, "expected a mapping");
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string" || item === "") {
      throw new MetadataConfigError(`${path}.${key}`, "expected a non-empty string");
    }
    out[key] = item;
  }
  return out;
}

function readProviderPrefixMap(value: unknown, path: string): Record<string, readonly string[]> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new MetadataConfigError(path, "expected a mapping");
  const component = (raw: unknown, at: string): string => {
    if (typeof raw !== "string" || raw === "" || raw.includes("/") || /\s/.test(raw)) {
      throw new MetadataConfigError(at, "provider must be a non-empty string without slash or whitespace");
    }
    return raw.toLowerCase();
  };
  const out: Record<string, readonly string[]> = {};
  for (const [key, item] of Object.entries(value)) {
    const name = component(key, `${path}.${key}`);
    const list = Array.isArray(item) ? item : [item];
    if (list.length === 0) throw new MetadataConfigError(`${path}.${key}`, "targets must not be empty");
    const targets: string[] = [];
    for (const raw of list) {
      const target = component(raw, `${path}.${key}`);
      if (!targets.includes(target)) targets.push(target);
    }
    out[name] = targets;
  }
  return out;
}

function readFieldMap(value: unknown, path: string): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new MetadataConfigError(path, "expected a mapping");
  return value;
}

function readModelRule(value: unknown, path: string, warnings: string[]): ModelRule {
  if (!isRecord(value)) throw new MetadataConfigError(path, "expected a mapping");
  for (const key of Object.keys(value)) {
    if (!KNOWN_MODEL_KEYS.has(key)) warnings.push(`${path}.${key}`);
  }
  const rule: ModelRule = {
    sourcePriority: readChain(value.source_priority, `${path}.source_priority`),
    fillMissingOnly: readBool(value.fill_missing_only, `${path}.fill_missing_only`),
    lookupIds: readStringMap(value.lookup_ids, `${path}.lookup_ids`),
    overrides: readFieldMap(value.overrides, `${path}.overrides`),
  };
  for (const token of Object.keys(rule.lookupIds ?? {})) {
    // Keys are exact concrete sources: models.dev/<provider> or
    // modelparams.dev/<provider>/<access>. A wildcard segment would apply one
    // id across several sources, so it is a config error.
    const selector = parseSelector(token, `${path}.lookup_ids key ${JSON.stringify(token)}`);
    const concrete =
      (selector.site === "models.dev" && selector.provider !== undefined && selector.access === "*") ||
      (selector.site === "modelparams.dev" && selector.providerPattern !== undefined &&
        !selector.providerPattern.includes("*") && selector.access !== "*");
    if (!concrete) {
      throw new MetadataConfigError(
        `${path}.lookup_ids key ${JSON.stringify(token)}`,
        "expected an exact concrete source (models.dev/<provider> or modelparams.dev/<provider>/<access>)",
      );
    }
  }
  return rule;
}

function readModelRules(value: unknown, path: string, warnings: string[]): Record<string, ModelRule> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new MetadataConfigError(path, "expected a mapping of pattern -> rule");
  const out: Record<string, ModelRule> = {};
  for (const [pattern, rule] of Object.entries(value)) {
    out[pattern] = readModelRule(rule, `${path}.${pattern}`, warnings);
  }
  return out;
}

function readChannel(value: unknown, path: string, warnings: string[]): ChannelConfig {
  if (!isRecord(value)) throw new MetadataConfigError(path, "expected a mapping");
  for (const key of Object.keys(value)) {
    if (!KNOWN_CHANNEL_KEYS.has(key)) warnings.push(`${path}.${key}`);
  }
  const overrides = readFieldMap(value.overrides, `${path}.overrides`);
  if (overrides) {
    for (const [model, fields] of Object.entries(overrides)) {
      if (!isRecord(fields)) {
        throw new MetadataConfigError(`${path}.overrides.${model}`, "expected a mapping of fields");
      }
    }
  }
  return {
    sourcePriority: readChain(value.source_priority, `${path}.source_priority`),
    globalFallback: readBool(value.global_fallback, `${path}.global_fallback`),
    fillMissingOnly: readBool(value.fill_missing_only, `${path}.fill_missing_only`),
    providerPrefixMap: readProviderPrefixMap(value.provider_prefix_map, `${path}.provider_prefix_map`),
    overrides: overrides as ChannelConfig["overrides"],
    models: readModelRules(value.models, `${path}.models`, warnings),
  };
}

/**
 * Parses the YAML text of openai-api-extension.yaml. Missing/empty content
 * yields an empty config (default chain applies). Invalid YAML, duplicate
 * keys, or invalid known-field values raise MetadataConfigError; unknown
 * fields are ignored and collected as warnings.
 */
export function parseMetadataConfig(yamlText: string | undefined): MetadataConfig {
  const warnings: string[] = [];
  if (yamlText === undefined || yamlText.trim() === "") {
    return { warnings };
  }
  let root: unknown;
  try {
    const doc = parseDocument(yamlText);
    if (doc.errors.length > 0) {
      const first = doc.errors[0];
      throw new MetadataConfigError(
        `line ${first.linePos?.[0]?.line ?? "?"}`,
        first.message.split("\n")[0] ?? "invalid YAML",
      );
    }
    root = doc.toJS();
  } catch (error) {
    if (error instanceof MetadataConfigError) throw error;
    throw new MetadataConfigError("openai-api-extension.yaml", error instanceof Error ? error.message : String(error));
  }
  if (root === null || root === undefined) return { warnings };
  if (!isRecord(root)) throw new MetadataConfigError("openai-api-extension.yaml", "expected a top-level mapping");
  for (const key of Object.keys(root)) {
    if (!KNOWN_ROOT_KEYS.has(key)) warnings.push(key);
  }
  const channelsValue = root.channels;
  let channels: Record<string, ChannelConfig> | undefined;
  if (channelsValue !== undefined) {
    if (!isRecord(channelsValue)) throw new MetadataConfigError("channels", "expected a mapping");
    channels = {};
    for (const [name, channel] of Object.entries(channelsValue)) {
      channels[name] = readChannel(channel, `channels.${name}`, warnings);
    }
  }
  return {
    sourcePriority: readChain(root.source_priority, "source_priority"),
    fillMissingOnly: readBool(root.fill_missing_only, "fill_missing_only"),
    providerPrefixMap: readProviderPrefixMap(root.provider_prefix_map, "provider_prefix_map"),
    models: readModelRules(root.models, "models", warnings),
    channels,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Model-rule glob: plain string match, `*` = any chars including `/` and empty.
// Case-sensitive, anchored to the whole string; not minimatch path semantics.
// ---------------------------------------------------------------------------

/**
 * Plain-string glob match: `*` matches zero or more of any character
 * (including `/`), everything else is literal. Anchored, case-sensitive,
 * consecutive `*` equal one — ordered literal-chunk matching, never a
 * generated backtracking regexp.
 */
export function matchModelPattern(pattern: string, id: string): boolean {
  const chunks = pattern.split("*");
  if (chunks.length === 1) return pattern === id;
  const first = chunks[0];
  if (first !== "" && !id.startsWith(first)) return false;
  const last = chunks[chunks.length - 1];
  if (last !== "" && !id.endsWith(last)) return false;
  if (id.length < first.length + last.length) return false; // prefix and suffix must not overlap
  let pos = first.length;
  const end = id.length - last.length;
  for (let index = 1; index < chunks.length - 1; index++) {
    const chunk = chunks[index];
    if (chunk === "") continue;
    const found = id.indexOf(chunk, pos);
    if (found === -1 || found + chunk.length > end) return false;
    pos = found + chunk.length;
  }
  return true;
}

/**
 * Selects at most one rule from a models block: an exact key wins; otherwise
 * the first matching glob in declaration order. No stacking or re-ordering.
 */
export function selectModelRule(
  rules: Readonly<Record<string, ModelRule>> | undefined,
  id: string,
): ModelRule | undefined {
  if (!rules) return undefined;
  const exact = rules[id];
  if (exact !== undefined) return exact;
  for (const [pattern, rule] of Object.entries(rules)) {
    if (pattern.includes("*") && matchModelPattern(pattern, id)) return rule;
  }
  return undefined;
}

/**
 * Strips exactly one channel prefix when the public id's first segment exactly
 * equals a configured channel key. Returns the channel-relative id used for
 * channel model rules and metadata queries; the public id never changes.
 */
export function stripChannelPrefix(
  publicId: string,
  channels: Readonly<Record<string, ChannelConfig>> | undefined,
): { channel?: string; id: string } {
  const slash = publicId.indexOf("/");
  if (slash > 0 && channels && Object.hasOwn(channels, publicId.slice(0, slash))) {
    return { channel: publicId.slice(0, slash), id: publicId.slice(slash + 1) };
  }
  return { id: publicId };
}

// ---------------------------------------------------------------------------
// Chain + mode inheritance across the four scopes.
// ---------------------------------------------------------------------------

export type ResolvedPolicy = {
  sourcePriority: readonly string[];
  fillMissingOnly: boolean;
  lookupIds: Readonly<Record<string, string>>;
  /** Manual overrides, lowest to highest: global model, channel legacy, channel model. */
  overrides: Readonly<Record<string, unknown>>;
  channel?: string;
  channelId: string;
};

function mergeOverrides(
  base: Readonly<Record<string, unknown>>,
  extra: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  if (!extra) return out;
  // Aliases of one canonical field must collide at merge time: a lower-scope
  // `context_window` must not survive a higher-scope `context_length`. Each
  // layer normalizes onto canonical names before overlaying.
  const aliases = new Set(Object.values(FIELD_ALIASES).flat());
  const known: Record<string, unknown> = {};
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(extra)) {
    (aliases.has(key) || key === "capabilities" ? known : rest)[key] = value;
  }
  overlayMetadata(out, rest);
  overlayMetadata(out, normalizeFields(known));
  return out;
}

/**
 * Resolves the effective policy for one public model id.
 *
 * Chain: channel model rule > global model rule explicit source_priority
 * replaces everything; when neither model rule declares a chain the channel
 * chain applies, with the global chain deduped-appended unless
 * global_fallback:false or the channel chain is an explicit []. An absent
 * root chain means the built-in default; root [] disables global sources but
 * never removes explicit channel/model chains.
 *
 * Mode: channel model > global model > channel default > global default >
 * false, by field presence (explicit false overrides parent true).
 */
export function resolveModelPolicy(config: MetadataConfig, publicId: string): ResolvedPolicy {
  const { channel, id: channelId } = stripChannelPrefix(publicId, config.channels);
  const channelConfig = channel ? config.channels?.[channel] : undefined;
  const globalRule = selectModelRule(config.models, publicId);
  const channelRule = channelConfig ? selectModelRule(channelConfig.models, channelId) : undefined;

  // Chain resolution.
  const rootChain = config.sourcePriority ?? DEFAULT_SOURCE_PRIORITY;
  let chain: readonly string[];
  if (channelRule?.sourcePriority !== undefined) {
    chain = channelRule.sourcePriority;
  } else if (globalRule?.sourcePriority !== undefined) {
    chain = globalRule.sourcePriority;
  } else if (channelConfig) {
    const channelChain = channelConfig.sourcePriority;
    if (channelConfig.globalFallback === false) {
      chain = channelChain ?? [];
    } else if (channelChain === undefined) {
      chain = rootChain;
    } else if (channelChain.length === 0) {
      chain = channelChain;
    } else {
      chain = [...channelChain];
      for (const token of rootChain) if (!chain.includes(token)) chain.push(token);
    }
  } else {
    chain = rootChain;
  }

  // Mode resolution by field presence.
  const fillMissingOnly =
    channelRule?.fillMissingOnly ??
    globalRule?.fillMissingOnly ??
    channelConfig?.fillMissingOnly ??
    config.fillMissingOnly ??
    true;

  // lookup_ids: global model rule first, channel model rule overrides same keys.
  const lookupIds: Record<string, string> = { ...(globalRule?.lookupIds ?? {}) };
  for (const [key, value] of Object.entries(channelRule?.lookupIds ?? {})) lookupIds[key] = value;

  // Manual overrides low -> high: global model, channel legacy, channel model.
  let overrides: Record<string, unknown> = {};
  overrides = mergeOverrides(overrides, globalRule?.overrides);
  overrides = mergeOverrides(overrides, channelConfig?.overrides?.[channelId]);
  overrides = mergeOverrides(overrides, channelRule?.overrides);

  return { sourcePriority: chain, fillMissingOnly, lookupIds, overrides, channel, channelId };
}

// ---------------------------------------------------------------------------
// Source selectors.
// ---------------------------------------------------------------------------

export type AccessType = "subscription" | "api_key";

export type Selector = {
  site: MetadataSite | "*";
  /** Provider glob segment (minimatch), or undefined for the exact models.dev form. */
  providerPattern?: string;
  /** Exact provider name (no glob metacharacters). */
  provider?: string;
  access: AccessType | "*";
  token: string;
};

const PROVIDER_PATTERN_CHARS = /^[A-Za-z0-9._*-]+$/;

/**
 * Parses a source selector token. Supported forms:
 *   models.dev/<provider>            exact token, any access
 *   models.dev/<provider-pattern>    glob over providers, any access
 *   modelparams.dev/<provider>/<access>   exact token
 *   <site>/<provider-pattern>/<access>    site = models.dev | modelparams.dev | *
 *   *(star)/subscription | *(star)/api_key   all sites + providers
 */
export function parseSelector(token: string, path = "source_priority"): Selector {
  if (typeof token !== "string" || token.trim() !== token || token === "") {
    throw new MetadataConfigError(path, "selector must be a non-empty string");
  }
  const parts = token.split("/");
  const access = (value: string): AccessType | "*" => {
    if (value === "subscription" || value === "api_key" || value === "*") return value;
    throw new MetadataConfigError(path, `invalid access type ${JSON.stringify(value)} in ${JSON.stringify(token)}`);
  };
  const site = (value: string): MetadataSite | "*" => {
    if (value === "models.dev" || value === "modelparams.dev" || value === "*") return value;
    throw new MetadataConfigError(path, `unknown site ${JSON.stringify(value)} in ${JSON.stringify(token)}`);
  };
  const providerPattern = (value: string): string => {
    if (value === "" || !PROVIDER_PATTERN_CHARS.test(value)) {
      throw new MetadataConfigError(path, `invalid provider pattern ${JSON.stringify(value)} in ${JSON.stringify(token)}`);
    }
    return value;
  };
  if (parts.length === 2) {
    // `*/subscription` and `*/api_key` are the two-segment shorthand.
    if (parts[0] === "*") {
      return { site: "*", providerPattern: "*", access: access(parts[1]), token };
    }
    const s = site(parts[0]);
    const pattern = providerPattern(parts[1]);
    if (s === "modelparams.dev") {
      throw new MetadataConfigError(path, `modelparams.dev selectors need an access segment: ${JSON.stringify(token)}`);
    }
    return pattern.includes("*")
      ? { site: s, providerPattern: pattern, access: "*", token }
      : { site: s, provider: pattern, access: "*", token };
  }
  if (parts.length === 3) {
    return {
      site: site(parts[0]),
      providerPattern: providerPattern(parts[1]),
      access: access(parts[2]),
      token,
    };
  }
  throw new MetadataConfigError(path, `invalid selector ${JSON.stringify(token)}`);
}

/** Access group of a source record under the local classification policy. */
export function classifyAccess(site: MetadataSite, provider: string, authType: unknown): AccessType | undefined {
  if (site === "models.dev") {
    return MODELS_DEV_SUBSCRIPTION_PROVIDERS.has(provider.toLowerCase()) ? "subscription" : "api_key";
  }
  const normalized = typeof authType === "string" ? authType.trim().toLowerCase() : "";
  if (normalized === "api_key" || normalized === "subscription") return normalized;
  return undefined; // unknown authType matches only access:* selectors
}

export function selectorSites(selector: Selector): readonly MetadataSite[] {
  return selector.site === "*" ? METADATA_SITES : [selector.site];
}

// ---------------------------------------------------------------------------
// Source records + per-selector resolution.
// ---------------------------------------------------------------------------

/** One normalized external record as published by a bulk source. */
export type SourceRecord = {
  site: MetadataSite;
  /** Source provider key, lowercased (models.dev key or modelparams provider). */
  provider: string;
  /** Source-side model id (for models.dev: key inside the provider map). */
  modelId: string;
  /** Raw authType from modelparams.dev; undefined for models.dev. */
  authType?: unknown;
  /** models.dev canonical_model_id, e.g. "openai/gpt-5". */
  canonicalModelId?: string;
  fields: MetadataFields;
};

export type ResolutionDiagnostic = { kind: "ambiguous" | "missing"; token: string; modelId: string; detail: string };

/**
 * Whether a source record belongs to a selector: site group, provider glob,
 * and access classification (unknown authType only matches access "*").
 */
export function recordMatchesSelector(selector: Selector, record: SourceRecord): boolean {
  if (!selectorSites(selector).includes(record.site)) return false;
  if (selector.provider !== undefined) {
    if (record.provider !== selector.provider.toLowerCase()) return false;
  } else if (selector.providerPattern !== undefined) {
    if (!minimatch(record.provider, selector.providerPattern)) return false;
  }
  if (selector.access === "*") return true;
  return classifyAccess(record.site, record.provider, record.authType) === selector.access;
}

/**
 * Merges provider_prefix_map: channel entries replace same-name global
 * entries; a name maps only once (no recursive expansion).
 */
export function mergeProviderPrefixMaps(
  global: Readonly<Record<string, readonly string[]>> | undefined,
  local: Readonly<Record<string, readonly string[]>> | undefined,
): Record<string, readonly string[]> {
  const out: Record<string, readonly string[]> = { ...(global ?? {}) };
  for (const [key, value] of Object.entries(local ?? {})) out[key] = value;
  return out;
}

/**
 * Candidate query identities for one selector group.
 *
 * - An explicit lookup_ids entry keyed by the concrete expanded source
 *   (`<site>/<provider>` for models.dev, `<site>/<provider>/<access>` for
 *   modelparams.dev) fixes the query id — also under wildcard selectors.
 * - A qualified query id's first segment may be remapped through
 *   provider_prefix_map (metadata query identity only; public id unchanged).
 * - Bare names ask the selector-matched providers; qualified names keep their
 *   own vendor namespace and only match providers via prefix targets.
 */
export function* candidateIdentities(
  selector: Selector,
  site: MetadataSite,
  queryId: string,
  policy: ResolvedPolicy,
  prefixMap: Readonly<Record<string, readonly string[]>>,
  records: readonly SourceRecord[],
): Generator<{ provider: string; queryId: string }> {
  const slash = queryId.indexOf("/");
  const qualified = slash > 0;
  const providerSegment = qualified ? queryId.slice(0, slash).toLowerCase() : "";
  const bareId = qualified ? queryId.slice(slash + 1) : queryId;
  const targets =
    qualified && prefixMap[providerSegment] ? prefixMap[providerSegment] : qualified ? [providerSegment] : undefined;
  const seen = new Set<string>();
  for (const record of records) {
    if (record.site !== site || !recordMatchesSelector(selector, record)) continue;
    if (targets !== undefined && !targets.some((t) => t === record.provider)) continue;
    const access = classifyAccess(record.site, record.provider, record.authType);
    const concreteKey =
      site === "modelparams.dev" && access ? `${site}/${record.provider}/${access}` : `${site}/${record.provider}`;
    const override = policy.lookupIds[concreteKey];
    const id = override ?? (qualified ? bareId : queryId);
    const key = `${record.provider}${id}`;
    if (!seen.has(key)) {
      seen.add(key);
      yield { provider: record.provider, queryId: id };
    }
  }
}

/** Two records of the same identity are interchangeable only when every field agrees. */
function fieldsIdentical(a: SourceRecord, b: SourceRecord): boolean {
  const keys = new Set([...Object.keys(a.fields), ...Object.keys(b.fields)]);
  for (const key of keys) {
    const va = a.fields[key];
    const vb = b.fields[key];
    if (va === vb) continue;
    if (JSON.stringify(va) !== JSON.stringify(vb)) return false;
  }
  return true;
}

/**
 * Finds the records for one query id inside one provider's table, restricted
 * to the selector's access group. Exact id matches win; then a unique
 * case-folded match; then, for bare query names only, records whose last `/`
 * segment equals the name (provider-side vendor namespaces like `openai/gpt-5`
 * still identify the same product). Returns every matching record — same
 * provider+model duplicates are kept so the caller can judge ambiguity.
 */
function lookupRecords(
  records: readonly SourceRecord[],
  site: MetadataSite,
  provider: string,
  queryId: string,
  selector: Selector,
): { hits: SourceRecord[]; ambiguous: boolean } {
  const exact: SourceRecord[] = [];
  const folded: SourceRecord[] = [];
  const bare: SourceRecord[] = [];
  const isBare = !queryId.includes("/");
  for (const record of records) {
    if (record.site !== site || record.provider !== provider) continue;
    if (!recordMatchesSelector(selector, record)) continue;
    if (record.modelId === queryId) exact.push(record);
    else if (record.modelId.toLowerCase() === queryId.toLowerCase()) folded.push(record);
    else if (isBare && record.modelId.toLowerCase().endsWith(`/${queryId.toLowerCase()}`)) bare.push(record);
  }
  const hits = exact.length > 0 ? exact : folded.length > 0 ? folded : bare;
  // Distinct canonical targets within one matched id (e.g. MODEL and Model
  // declaring different canonical_model_id) are different identities that
  // happen to fold together — ambiguous, never interchangeable. Folded hits
  // collapse only when every hit has the same exact source modelId: folded
  // matches of distinct IDs (MODEL vs Model) are ambiguous even with equal
  // fields/canonicals, otherwise results would depend on record order.
  const ambiguous = hits.length > 1 &&
    (new Set(hits.map((record) => record.modelId)).size > 1 ||
      new Set(hits.map((record) => record.canonicalModelId ?? "")).size > 1 ||
      !hits.every((hit) => fieldsIdentical(hit, hits[0])));
  return { hits, ambiguous };
}

/**
 * Resolves one selector against one site group.
 *
 * Returns the chosen record, or a diagnostic. Within a site group, multiple
 * provider candidates are ambiguous unless models.dev creator arbitration
 * resolves them: every candidate must declare the same canonical_model_id
 * `<creator>/<model>` and the creator provider's own entry (id == `<model>`)
 * must itself be among the candidates.
 */
export function resolveSelectorSite(
  selector: Selector,
  site: MetadataSite,
  queryId: string,
  policy: ResolvedPolicy,
  prefixMap: Readonly<Record<string, readonly string[]>>,
  records: readonly SourceRecord[],
): { record?: SourceRecord; diagnostic?: ResolutionDiagnostic } {
  const candidates: SourceRecord[] = [];
  const seen = new Set<string>();
  let ambiguousDuplicates = false;
  for (const identity of candidateIdentities(selector, site, queryId, policy, prefixMap, records)) {
    const { hits, ambiguous } = lookupRecords(records, site, identity.provider, identity.queryId, selector);
    if (hits.length === 0) continue;
    if (ambiguous) {
      // Same provider+model with disagreeing fields or distinct canonical
      // targets (e.g. modelparams.dev apiSurface variants) cannot be uniquely
      // located: the whole site group is ambiguous, not just this identity.
      ambiguousDuplicates = true;
      continue;
    }
    const first = hits[0];
    if (!seen.has(first.provider + "" + first.modelId)) {
      seen.add(first.provider + "" + first.modelId);
      candidates.push(first);
    }
  }
  if (ambiguousDuplicates) {
    // A conflicting duplicate anywhere in the group invalidates the whole
    // site group — a surviving clean candidate must not silently win.
    return {
      diagnostic: { kind: "ambiguous", token: selector.token, modelId: queryId, detail: `${site} has conflicting duplicate records for ${queryId}` },
    };
  }
  if (candidates.length === 0) {
    return {
      diagnostic: { kind: "missing", token: selector.token, modelId: queryId, detail: `no ${site} candidate` },
    };
  }
  if (candidates.length === 1) return { record: candidates[0] };
  if (site === "models.dev") {
    const canonical = candidates[0].canonicalModelId;
    const consistent =
      canonical !== undefined && candidates.every((candidate) => candidate.canonicalModelId === canonical);
    if (consistent) {
      const slash = canonical.indexOf("/");
      const creator = canonical.slice(0, slash);
      const creatorModel = canonical.slice(slash + 1);
      const own = candidates.find(
        (candidate) => candidate.provider === creator && candidate.modelId === creatorModel,
      );
      if (own) return { record: own };
    }
  }
  const providers = [...new Set(candidates.map((candidate) => candidate.provider))].sort();
  return {
    diagnostic: {
      kind: "ambiguous",
      token: selector.token,
      modelId: queryId,
      detail: `${site} candidates ${providers.join(",")} disagree on ${queryId}`,
    },
  };
}

export type ChainResolution = {
  fields: MetadataFields;
  diagnostics: ResolutionDiagnostic[];
};

/**
 * Resolves the full source chain for one model: each selector expands to site
 * groups in built-in order (models.dev before modelparams.dev inside one
 * selector); per canonical field, the highest-priority declared value wins;
 * fields still missing continue to lower-priority sources. An adopted
 * source+identity pair is never reconsidered; a group skipped for ambiguity
 * does not consume a dedupe slot.
 */
export function resolveMetadataChain(
  policy: ResolvedPolicy,
  queryId: string,
  prefixMap: Readonly<Record<string, readonly string[]>>,
  records: readonly SourceRecord[],
): ChainResolution {
  const fields: MetadataFields = {};
  const diagnostics: ResolutionDiagnostic[] = [];
  const adopted = new Set<string>();
  const declared = new Set<string>();
  for (const token of policy.sourcePriority) {
    const selector = parseSelector(token);
    for (const site of selectorSites(selector)) {
      const { record, diagnostic } = resolveSelectorSite(selector, site, queryId, policy, prefixMap, records);
      if (diagnostic) {
        if (diagnostic.kind === "ambiguous") diagnostics.push(diagnostic);
        continue;
      }
      if (!record) continue;
      const key = `${record.site} ${record.provider} ${record.modelId}`;
      if (adopted.has(key)) continue;
      adopted.add(key);
      for (const [field, value] of Object.entries(normalizeFields(record.fields))) {
        if (value === undefined || value === null || declared.has(field)) continue;
        declared.add(field);
        fields[field] = value;
      }
    }
  }
  return { fields, diagnostics };
}

// ---------------------------------------------------------------------------
// Metadata merge: alias normalization, per-field selection, mode merge,
// manual overrides. Objects merge recursively, arrays replace, null keeps the
// lower layer.
// ---------------------------------------------------------------------------

/** Canonical fields consumed by mapModel; all source aliases land here. */
const FIELD_ALIASES: Readonly<Record<string, readonly string[]>> = {
  context_window: ["context_window", "context_length"],
  max_output_tokens: ["max_output_tokens", "max_completion_tokens", "max_tokens"],
  max_input_tokens: ["max_input_tokens"],
  supported_reasoning_levels: ["supported_reasoning_levels"],
  default_reasoning_level: ["default_reasoning_level"],
  input_modalities: ["input_modalities"],
  output_modalities: ["output_modalities"],
  name: ["name", "display_name"],
};

/** Fields metadata may never set (identity/routing stay upstream-owned). */
const PROTECTED_FIELDS = new Set(["id", "slug", "provider", "baseUrl", "api", "key", "headers"]);

/**
 * Whether one raw field value passes the field validation mapModel applies.
 * Invalid values count as missing for both merge modes: they never overwrite
 * a valid lower-priority value and they never block a fill.
 */
export function fieldIsValid(canonical: string, value: unknown): boolean {
  if (value === undefined || value === null) return false;
  switch (canonical) {
    case "context_window":
    case "max_output_tokens":
    case "max_input_tokens":
      return typeof value === "number" && Number.isFinite(value) && value > 0;
    case "input_modalities":
    case "output_modalities":
    case "supported_reasoning_levels":
      return Array.isArray(value);
    case "default_reasoning_level":
    case "name":
      return typeof value === "string" && value.trim() !== "";
    default:
      return true;
  }
}

/**
 * Copies known metadata fields onto canonical names. The first alias carrying
 * a VALID value wins (an invalid preferred alias never shadows a valid
 * fallback); unknown/protected fields drop. Upstream
 * `capabilities.effort_tiers` normalizes onto supported_reasoning_levels.
 */
export function normalizeFields(input: Readonly<Record<string, unknown>>): MetadataFields {
  const out: MetadataFields = {};
  const capabilities = input.capabilities;
  const effortTiers =
    capabilities && typeof capabilities === "object" && !Array.isArray(capabilities)
      ? (capabilities as Record<string, unknown>).effort_tiers
      : undefined;
  for (const [canonical, aliases] of Object.entries(FIELD_ALIASES)) {
    for (const alias of aliases) {
      const value = input[alias];
      if (fieldIsValid(canonical, value)) {
        out[canonical] = value;
        break;
      }
    }
    if (out[canonical] === undefined && canonical === "supported_reasoning_levels" && Array.isArray(effortTiers)) {
      out[canonical] = effortTiers;
    }
  }
  return out;
}

/** A field counts as "missing" for fill-only when absent, null, or invalid. */
export function fieldIsMissing(canonical: string, value: unknown): boolean {
  if (value === undefined || value === null) return true;
  // An explicit [] of reasoning levels means "no tiers", never missing.
  if (canonical === "supported_reasoning_levels" && Array.isArray(value)) return false;
  return !fieldIsValid(canonical, value);
}

/** Recursive object merge; arrays/scalars replace; null never erases. */
export function overlayMetadata(target: MetadataFields, source: Readonly<Record<string, unknown>> | undefined): MetadataFields {
  if (!source) return target;
  for (const [key, value] of Object.entries(source)) {
    if (value === null || value === undefined) continue;
    if (isRecord(value)) {
      const current = isRecord(target[key]) ? (target[key] as MetadataFields) : {};
      target[key] = overlayMetadata(current, value);
    } else {
      target[key] = value;
    }
  }
  return target;
}

/**
 * Merges upstream metadata U with external E under the policy mode.
 * overwrite: merge(U, E) — external wins per field.
 * fill-only:  merge(E, U) — upstream wins except where a field is missing.
 */
export function mergeMetadata(
  upstream: Readonly<Record<string, unknown>>,
  external: Readonly<Record<string, unknown>>,
  fillMissingOnly: boolean,
): MetadataFields {
  const base = normalizeFields(upstream);
  const ext = normalizeFields(external);
  if (!fillMissingOnly) {
    const out = { ...base };
    for (const [key, value] of Object.entries(ext)) {
      if (value !== undefined && value !== null) out[key] = value;
    }
    return out;
  }
  const out = { ...ext };
  for (const [key, value] of Object.entries(base)) {
    if (!fieldIsMissing(key, value)) {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Applies manual overrides on top of the merged metadata (null never erases).
 * Known-field keys are alias-normalized first so `context_length` lands on
 * the same canonical field the sources use; invalid override values drop.
 */
export function applyOverrides(
  merged: MetadataFields,
  overrides: Readonly<Record<string, unknown>>,
): MetadataFields {
  const out = { ...merged };
  const aliases = new Set(Object.values(FIELD_ALIASES).flat());
  for (const [key, value] of Object.entries(overrides)) {
    if (PROTECTED_FIELDS.has(key) || aliases.has(key) || key === "capabilities") continue;
    if (value === null || value === undefined) continue;
    out[key] = value;
  }
  for (const [key, value] of Object.entries(normalizeFields(overrides))) {
    out[key] = value;
  }
  return out;
}
