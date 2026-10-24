/**
 * Pure model-metadata resolution: YAML config validation, chain-entry
 * parsing, ordered model-rule layering, internal last-segment query
 * expansion (literal > separator/case regex > date-suffix fallback),
 * full-canonical @creator/alias-group resolution with unified-model
 * fallback, RFC 7396 merge for overrides, and the compile-time view that
 * turns one config + one catalog + external data into a concrete per-model
 * chain. No network or filesystem I/O lives here; metadata-compile.ts owns
 * data-package loading inside the Worker and index.ts owns the provider
 * lifecycle. Query regexes exist only while compiling; the compiled output
 * keeps literal candidates and fixed entries, never executable patterns.
 */

export type MetadataFields = Record<string, unknown>;
export type MetadataSite = "models.dev" | "modelparams.dev";
export const METADATA_SITES: readonly MetadataSite[] = ["models.dev", "modelparams.dev"];

export class MetadataConfigError extends Error {
  readonly path: string;
  /** The bare reason without the path prefix — safe to re-wrap after serialization. */
  readonly reason: string;
  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "MetadataConfigError";
    this.path = path;
    this.reason = message;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Chain entries.
// ---------------------------------------------------------------------------

export type AccessType = "subscription" | "api_key";
const ACCESS_TYPES: ReadonlySet<string> = new Set(["subscription", "api_key"]);

/**
 * One parsed chain entry. `model` is the literal 4th segment when present,
 * otherwise "@id" meaning "use the model's own query candidates". The 4th
 * segment may itself contain "/"; parsing splits on the FIRST three slashes
 * only, so `models.dev/openai/api_key/openai/gpt-5` has model
 * `openai/gpt-5`.
 */
export type ChainEntry = {
  site: MetadataSite;
  provider: string; // literal provider id, or "@creator"
  access: AccessType;
  model: string; // literal query id, or "@id"
  token: string; // original text
};

export const DEFAULT_CHAIN: readonly string[] = [
  "models.dev/@creator/api_key",
  "modelparams.dev/@creator/api_key",
];

/** Parses one chain entry; "@default" is expanded by the caller, not here. */
export function parseChainEntry(token: string, path: string): ChainEntry {
  if (typeof token !== "string" || token.trim() !== token || token === "") {
    throw new MetadataConfigError(path, "chain entries must be non-empty strings");
  }
  if (token === "@default") {
    throw new MetadataConfigError(path, "@default is expanded before entry parsing and must not reach parseChainEntry");
  }
  // Split on the first three "/" only so a literal model id may contain "/".
  const first = token.indexOf("/");
  const second = first < 0 ? -1 : token.indexOf("/", first + 1);
  const third = second < 0 ? -1 : token.indexOf("/", second + 1);
  const site = token.slice(0, first < 0 ? undefined : first);
  const provider = first < 0 ? "" : token.slice(first + 1, second < 0 ? undefined : second);
  const access = second < 0 ? "" : token.slice(second + 1, third < 0 ? undefined : third);
  const model = third < 0 ? "@id" : token.slice(third + 1);
  if (site !== "models.dev" && site !== "modelparams.dev") {
    throw new MetadataConfigError(path, `invalid site ${JSON.stringify(site)} in ${JSON.stringify(token)}`);
  }
  if (provider === "" || provider.includes("*")) {
    throw new MetadataConfigError(path, `invalid provider ${JSON.stringify(provider)} in ${JSON.stringify(token)}`);
  }
  if (!ACCESS_TYPES.has(access)) {
    throw new MetadataConfigError(path, `invalid access ${JSON.stringify(access)} in ${JSON.stringify(token)}`);
  }
  if (model !== "@id" && (model === "" || model.includes("*"))) {
    throw new MetadataConfigError(path, `invalid model id ${JSON.stringify(model)} in ${JSON.stringify(token)}`);
  }
  return { site, provider, access, model, token };
}

/** Config-facing chain read: "@default" expands the root effective chain. */
function expandChain(tokens: readonly string[], rootChain: readonly string[], path: string): ChainEntry[] {
  const out: string[] = [];
  for (const token of tokens) {
    if (token === "@default") out.push(...rootChain);
    else out.push(token);
  }
  const entries: ChainEntry[] = [];
  for (const token of out) entries.push(parseChainEntry(token, `${path} item ${JSON.stringify(token)}`));
  return entries;
}

// ---------------------------------------------------------------------------
// Ordered model rules.
// ---------------------------------------------------------------------------

export type ModelRule = {
  match: string;
  chain?: readonly string[]; // raw tokens; may contain "@default"
  fillMissingOnly?: boolean;
  overrides?: Readonly<Record<string, unknown>>;
};

export type MetadataConfig = {
  /** undefined = absent (use DEFAULT_CHAIN); [] = explicit opt-out. */
  chain?: readonly string[];
  fillMissingOnly?: boolean;
  models?: readonly ModelRule[];
  warnings: readonly string[];
};


// ---------------------------------------------------------------------------
// Glob matching on the public id (plain string; `*` spans "/").
// ---------------------------------------------------------------------------

/**
 * Plain-string glob match: `*` matches zero or more of any character
 * (including `/`), everything else is literal. Anchored, case-sensitive.
 */
export function matchModelPattern(pattern: string, id: string): boolean {
  const chunks = pattern.split("*");
  if (chunks.length === 1) return pattern === id;
  const first = chunks[0];
  if (first !== "" && !id.startsWith(first)) return false;
  const last = chunks[chunks.length - 1];
  if (last !== "" && !id.endsWith(last)) return false;
  if (id.length < first.length + last.length) return false;
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

// ---------------------------------------------------------------------------
// Internal query expansion (last `/` segment only).
// ---------------------------------------------------------------------------

const DATE_SUFFIX = /-(?:\d{8}|\d{4}-\d{2}-\d{2})$/;
const QUERY_SEPARATOR_CHAR = /[\s._-]/;
const REGEX_META = /[.*+?^${}()|[\]\\]/g;

/** The internal query input: text after the last "/" of the public id. */
export function querySegment(publicId: string): string {
  return publicId.slice(publicId.lastIndexOf("/") + 1);
}

/**
 * Anchored, case-insensitive regex from a query segment: every
 * space/underscore/dot/hyphen character becomes one optional separator
 * class (one-to-zero-or-one, never one-to-many), every other character is
 * escaped literally so user input can never be executed as a pattern.
 * Undefined when nothing matchable remains.
 */
function buildQueryRegex(segment: string): RegExp | undefined {
  // Each separator character keeps its own position and count: "a--b"
  // compiles to "^a[\\s._-]?[\\s._-]?b$" and matches "ab"/"a_b"/"a_.b" but
  // never "a---b". Bare queries gain no separator positions.
  if (![...segment].some((char) => !QUERY_SEPARATOR_CHAR.test(char))) return undefined;
  const body = [...segment]
    .map((char) => (QUERY_SEPARATOR_CHAR.test(char) ? "[\\s._-]?" : char.replace(REGEX_META, "\\$&")))
    .join("");
  return new RegExp(`^${body}$`, "i");
}

/** Match tiers: exact literal > separator/case regex > date-stripped fallback. */
export type MatchLevel = 0 | 1 | 2;

/**
 * Ordered query candidates for the last `/` segment of a public id — kept
 * for compatibility with callers/tests that inspect the fixed candidate
 * list. The compiler no longer walks this list; it collects every literal,
 * regex and date-fallback hit across the source indexes instead.
 */
export function idCandidates(publicId: string): readonly string[] {
  const base = querySegment(publicId);
  const out: string[] = [];
  const push = (candidate: string) => {
    if (candidate !== "" && !out.includes(candidate)) out.push(candidate);
  };
  push(base);
  push(base.toLowerCase());
  push(base.replace(/(\d)\.(\d)/g, "$1-$2"));
  push(base.replace(/(\d)-(\d)/g, "$1.$2"));
  push(base.replace(DATE_SUFFIX, ""));
  return out;
}

/** One literal source-record hit produced by the internal query. */
export type QueryHit = {
  site: MetadataSite;
  provider: string;
  /** Access group the record belongs to; "catalog" = site has no per-access tier. */
  access: AccessType | "catalog";
  /** Source record origin: provider/modelparams record vs unified canonical data. */
  kind: "provider" | "canonical" | "params";
  /** Full source key/id spelling that matched; namespaces preserved. */
  sourceId: string;
  /** Physical table key of the underlying record (key/id aliases share it). */
  sourceKey: string;
  level: MatchLevel;
  /** Full canonical id when the record carries one (declared or unified). */
  canonical?: string;
};

/** Internal hit carrying the matched record plus selection bookkeeping. */
type IndexedHit = QueryHit & {
  record?: SourceRecord;
  /** Unified canonical-table hit: stronger identity evidence than provider hints. */
  unified?: boolean;
};

/** Last-segment -> hits index built once per data snapshot. */
type SegmentIndex = Map<string, IndexedHit[]>;

function segmentIndexAdd(index: SegmentIndex, hit: IndexedHit): void {
  const segment = hit.sourceId.slice(hit.sourceId.lastIndexOf("/") + 1);
  const list = index.get(segment);
  if (list) list.push(hit);
  else index.set(segment, [hit]);
}

/**
 * Collects every matching hit across the given indexes for one query
 * segment: literal at level 0, separator/case regex at level 1, and a
 * date-stripped second pass at level 2. Hits are deduped by source identity
 * (site+provider+sourceId), keeping the best level.
 */
function collectHits(indexes: readonly SegmentIndex[], segment: string): IndexedHit[] {
  const hits: IndexedHit[] = [];
  const regex = buildQueryRegex(segment);
  const stripped = DATE_SUFFIX.test(segment) ? segment.replace(DATE_SUFFIX, "") : undefined;
  const strippedRegex = stripped ? buildQueryRegex(stripped) : undefined;
  for (const index of indexes) {
    for (const hit of index.get(segment) ?? []) hits.push({ ...hit, level: 0 });
    if (regex) {
      for (const [key, list] of index) {
        if (key === segment || !regex.test(key)) continue;
        for (const hit of list) hits.push({ ...hit, level: 1 });
      }
    }
    if (stripped !== undefined) {
      for (const hit of index.get(stripped) ?? []) hits.push({ ...hit, level: 2 });
      if (strippedRegex) {
        for (const [key, list] of index) {
          if (key === stripped || key === segment || !strippedRegex.test(key)) continue;
          for (const hit of list) hits.push({ ...hit, level: 2 });
        }
      }
    }
  }
  const best = new Map<string, IndexedHit>();
  for (const hit of hits) {
    // Identity = site + provider + access group + record kind + underlying
    // table key + matched spelling: key/id alias strings stay distinct
    // candidates while the physical record drives field selection.
    const key = `${hit.site}|${hit.provider}|${hit.access}|${hit.kind}|${hit.sourceKey}|${hit.sourceId}`;
    const prev = best.get(key);
    if (!prev || hit.level < prev.level) best.set(key, hit);
  }
  return [...best.values()];
}

/** Same collection, run for several query ids against one provider table. */
function collectTableHits(
  index: SegmentIndex | undefined,
  queryIds: readonly string[],
): IndexedHit[] {
  if (!index) return [];
  const best = new Map<string, IndexedHit>();
  for (const queryId of queryIds) {
    for (const hit of collectHits([index], queryId)) {
      const key = `${hit.site}|${hit.provider}|${hit.access}|${hit.kind}|${hit.sourceKey}|${hit.sourceId}`;
      const prev = best.get(key);
      if (!prev || hit.level < prev.level) best.set(key, hit);
    }
  }
  return [...best.values()];
}

// ---------------------------------------------------------------------------
// @creator: alias groups + canonical_model_id resolution.
// ---------------------------------------------------------------------------

/** Ordered built-in creator alias groups; resellers/hosting are never grouped. */
export const CREATOR_ALIAS_GROUPS: readonly (readonly string[])[] = [
  ["zhipuai", "zai", "z-ai"],
  ["moonshotai", "moonshot"],
  ["thinkingmachines", "thinking-machines"],
];

/** Maps a canonical prefix to its alias group's canonical member (itself if ungrouped). */
function canonicalCreator(prefix: string): string {
  for (const group of CREATOR_ALIAS_GROUPS) {
    if (group.includes(prefix)) return group[0];
  }
  return prefix;
}

/** Ordered expansion of a canonical creator into candidate provider ids. */
function creatorExpansion(creator: string): readonly string[] {
  for (const group of CREATOR_ALIAS_GROUPS) {
    if (group[0] === creator) return group;
  }
  return [creator];
}

/** "creator/model" -> "canonical-creator/model"; undefined for malformed ids. */
function normalizeCanonical(canonical: string): string | undefined {
  const slash = canonical.indexOf("/");
  if (slash <= 0) return undefined;
  return `${canonicalCreator(canonical.slice(0, slash))}${canonical.slice(slash)}`;
}

/** The model portion of a canonical id (`anthropic/x` -> `x`). */
function canonicalBare(canonical: string): string {
  return canonical.slice(canonical.indexOf("/") + 1);
}

/** The literal creator prefix of a canonical id (`anthropic/x` -> `anthropic`). */
function canonicalPrefix(canonical: string): string {
  return canonical.slice(0, canonical.indexOf("/"));
}

/** Result of resolving a model's full canonical identity from its hits. */
export type CanonicalResolution = {
  /** Literal canonical id chosen, e.g. "anthropic/claude-sonnet-4-5". */
  canonical?: string;
  /** Alias-group-normalized canonical key (identity, not a source id). */
  canonicalKey?: string;
  /** Normalized canonical creator used for @creator expansion. */
  creator?: string;
  /** Distinct normalized creators in conflict (config error via @creator). */
  conflictingCreators?: string[];
  /** Same creator but several canonical models that cannot be adjudicated. */
  ambiguousReason?: string;
  /** Normalized canonical keys that are contested under ambiguity. */
  ambiguousCanonicals?: string[];
};

/**
 * Resolves the model's canonical identity from identity-bearing hits at
 * their highest match level: unified canonical-table hits beat declared
 * provider hints inside that level; lower levels never override it.
 * Distinct creators conflict; same-creator distinct models are ambiguous.
 */
function resolveCanonical(hits: readonly IndexedHit[]): CanonicalResolution {
  const identity = hits.filter((hit) => typeof hit.canonical === "string" && hit.canonical !== "");
  if (identity.length === 0) return {};
  const bestLevel = Math.min(...identity.map((hit) => hit.level));
  const atBest = identity.filter((hit) => hit.level === bestLevel);
  const direct = atBest.filter((hit) => hit.unified);
  const pool = direct.length > 0 ? direct : atBest;
  // Normalized canonical key -> chosen literal id (prefer the alias-group
  // head's spelling, deterministic lexical tie-break after that).
  const normalized = new Map<string, string>();
  for (const hit of pool) {
    const key = normalizeCanonical(hit.canonical!);
    if (key === undefined) continue;
    const head = key.slice(0, key.indexOf("/"));
    const literal = hit.canonical!;
    const prev = normalized.get(key);
    if (prev === undefined) {
      normalized.set(key, literal);
      continue;
    }
    const literalIsHead = canonicalPrefix(literal) === head;
    const prevIsHead = canonicalPrefix(prev) === head;
    if ((literalIsHead && !prevIsHead) || (literalIsHead === prevIsHead && literal < prev)) {
      normalized.set(key, literal);
    }
  }
  const creators = new Set([...normalized.keys()].map((key) => key.slice(0, key.indexOf("/"))));
  if (creators.size > 1) return { conflictingCreators: [...creators].sort() };
  const singleCreator = [...creators][0];
  if (normalized.size > 1) {
    const ids = [...normalized.values()].sort().join(", ");
    // The creator stays uniquely known — only the canonical model is
    // contested, so source-local lookups under this creator may still run.
    return {
      creator: singleCreator,
      ambiguousCanonicals: [...normalized.keys()].sort(),
      ambiguousReason: `multiple canonical models ${ids} at match level ${bestLevel}`,
    };
  }
  const entry = [...normalized.entries()][0];
  if (!entry) return {};
  const [canonicalKey, canonical] = entry;
  return { canonical, canonicalKey, creator: canonicalKey.slice(0, canonicalKey.indexOf("/")) };
}

// ---------------------------------------------------------------------------
// Source data (loaded by the Worker, used by the compiler).
// ---------------------------------------------------------------------------

/** One external record after package normalization. */
export type SourceRecord = {
  site: MetadataSite;
  provider: string;
  modelId: string;
  /** Physical table key this record was stored under (alias `id`s share the
   * underlying key; never overwritten by another record's alias). */
  sourceKey?: string;
  authType?: unknown;
  canonicalModelId?: string;
  providerName?: string;
  fields: MetadataFields;
  /** True for records from the unified canonical models table. */
  unified?: boolean;
};

/** One degraded data shape; `scope` narrows it to part of a site. */
export type DegradedSource = {
  site: MetadataSite;
  reason: string;
  /** Undefined = whole site; "providers"/"models" = one models.dev shape. */
  scope?: "providers" | "models";
};

export type SourceTables = {
  modelsDev: { providers?: unknown; models?: unknown } | undefined;
  modelparams: { catalog?: unknown } | undefined;
  /** Human-readable versions for the compile output. */
  modelsDevVersion?: string;
  modelsDevGeneratedAt?: string;
  modelparamsVersion?: string;
  degraded: DegradedSource[];
};

// ---------------------------------------------------------------------------
// Compilation.
// ---------------------------------------------------------------------------

/** Where an adopted field's value actually came from. */
export type FieldSource = "provider" | "canonical";

export type CompiledEntry = {
  /** Concrete "site/provider/access/modelId". */
  entry: string;
  site: MetadataSite;
  provider: string;
  access: AccessType;
  modelId: string;
  /** The fields this record supplies after alias normalization. */
  fields: MetadataFields;
  /** Resolved canonical id backing this entry, when one was established. */
  canonical?: string;
  /** Per-field provenance: provider record vs unified canonical data. */
  fieldSources?: Record<string, FieldSource>;
};

/** One retained literal query candidate and its selection outcome. */
export type QueryCandidate = {
  site: MetadataSite;
  provider: string;
  /**
   * Access group of the source record: modelparams authType ("api_key" /
   * "subscription"), the selecting entry's access for models.dev records,
   * or "catalog" when the record only proved identity (never selected).
   */
  access: AccessType | "catalog";
  /** Record origin: provider table, modelparams catalog, or unified canonical data. */
  kind: "provider" | "canonical" | "params";
  sourceId: string;
  /** Physical table key of the underlying record; key/id aliases share it. */
  sourceKey: string;
  level: MatchLevel;
  canonical?: string;
  selected: boolean;
  reason?: string;
};

export type CompiledModel = {
  publicId: string;
  /** Index (1-based) into config.models of rules that matched, in order. */
  matchedRules: number[];
  fillMissingOnly: boolean;
  /** Concrete entries in order; unresolved entries are absent from `entries`. */
  entries: CompiledEntry[];
  /** Entries whose @creator could not resolve or whose model was missing. */
  unresolved: string[];
  /** All literal query hits kept for inspection, with selection reasons. */
  candidates: QueryCandidate[];
  /** True when the model's effective chain has at least one external entry. */
  externalChain: boolean;
  /** Resolved canonical identity (full creator/model), when established. */
  canonical?: string;
  /** Entries skipped for a diagnosable reason (ambiguity, alias conflict). */
  skippedEntries?: { entry: string; reason: string }[];
  /** Ordered RFC 7396 patches from matching rules; applied in order to the final Pi model. */
  overridePatches: Record<string, unknown>[];
};

export type CompiledCatalog = {
  /** Local source fallback, separate from ignored configuration fields. */
  sourceWarning?: string;
  config: { rootChain: readonly string[]; fillMissingOnly: boolean; rules: readonly ModelRule[] };
  dataVersions: { modelsDevVersion?: string; modelsDevGeneratedAt?: string; modelparamsVersion?: string };
  degraded: DegradedSource[];
  models: CompiledModel[];
  warnings: readonly string[];
};

type IndexedData = {
  /** models.dev provider -> modelId -> record (also alias ids kept distinct). */
  modelsDev: Map<string, Map<string, SourceRecord>>;
  /** Unified canonical models: full canonical id -> record. */
  canonical: Map<string, SourceRecord>;
  /** modelparams provider|access -> modelId -> record. */
  modelparams: Map<string, Map<string, SourceRecord>>;
  seg: {
    /** All models.dev provider keys by last segment. */
    modelsDev: SegmentIndex;
    /** Unified canonical ids by last segment. */
    canonical: SegmentIndex;
    /** All modelparams model ids by last segment. */
    modelparams: SegmentIndex;
    /** Per-table indexes: "models.dev|<provider>" or "modelparams.dev|<provider>|<access>". */
    provider: Map<string, SegmentIndex>;
  };
};

function effortValuesToLevels(values: unknown): unknown[] | undefined {
  if (!Array.isArray(values)) return undefined;
  return values.map((value) => (isRecord(value) ? value : { effort: value }));
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.trim() !== "")?.trim();
}

/** Normalized capability fields of one models.dev-shaped raw record. */
function fieldsFromModelsDevRecord(raw: Record<string, unknown>): MetadataFields {
  const limit = isRecord(raw.limit) ? raw.limit : {};
  const modalities = isRecord(raw.modalities) ? raw.modalities : {};
  const fields: MetadataFields = {
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
  return fields;
}

function indexModelsDev(
  providers: unknown,
  segModelsDev: SegmentIndex,
  segProvider: Map<string, SegmentIndex>,
): Map<string, Map<string, SourceRecord>> {
  const out = new Map<string, Map<string, SourceRecord>>();
  if (!isRecord(providers)) return out;
  for (const [providerRaw, entry] of Object.entries(providers)) {
    if (!isRecord(entry) || !isRecord(entry.models)) continue;
    const provider = providerRaw.toLowerCase();
    const providerName = firstString(entry.name);
    let table = out.get(provider);
    if (!table) {
      table = new Map();
      out.set(provider, table);
    }
    let segTable = segProvider.get(`models.dev|${provider}`);
    if (!segTable) {
      segTable = new Map();
      segProvider.set(`models.dev|${provider}`, segTable);
    }
    const index = (record: SourceRecord, sourceKey: string, sourceId: string) => {
      const hit: IndexedHit = {
        site: "models.dev",
        provider,
        // models.dev records are a single catalog: no per-access tier exists
        // until a concrete chain entry selects the record.
        access: "catalog",
        kind: "provider",
        sourceId,
        sourceKey,
        level: 1,
        canonical: record.canonicalModelId,
        record,
      };
      segmentIndexAdd(segModelsDev, hit);
      segmentIndexAdd(segTable!, hit);
    };
    for (const [key, raw] of Object.entries(entry.models)) {
      if (!isRecord(raw)) continue;
      const record: SourceRecord = {
        site: "models.dev",
        provider,
        modelId: key,
        sourceKey: key,
        canonicalModelId: firstString(raw.canonical_model_id),
        providerName,
        fields: fieldsFromModelsDevRecord(raw),
      };
      table.set(key, record);
      index(record, key, key);
      const alias = firstString(raw.id);
      if (alias && alias !== key) {
        // Alias hits always exist so a colliding physical key cannot hide the
        // underlying record; only the literal lookup slot is guarded.
        const aliasRecord = { ...record, modelId: alias };
        if (!table.has(alias)) table.set(alias, aliasRecord);
        index(aliasRecord, key, alias);
      }
    }
  }
  return out;
}

/** Indexes the unified canonical models table keyed by full canonical id. */
function indexCanonicalModels(
  models: unknown,
  segCanonical: SegmentIndex,
): Map<string, SourceRecord> {
  const out = new Map<string, SourceRecord>();
  if (!isRecord(models)) return out;
  for (const [key, raw] of Object.entries(models)) {
    if (!isRecord(raw)) continue;
    const slash = key.indexOf("/");
    if (slash <= 0) continue;
    const record: SourceRecord = {
      site: "models.dev",
      provider: key.slice(0, slash),
      modelId: key,
      sourceKey: key,
      canonicalModelId: key,
      fields: fieldsFromModelsDevRecord(raw),
      unified: true,
    };
    out.set(key, record);
    segmentIndexAdd(segCanonical, {
      site: "models.dev",
      provider: record.provider,
      access: "catalog",
      kind: "canonical",
      sourceId: key,
      sourceKey: key,
      level: 1,
      canonical: key,
      record,
      unified: true,
    });
  }
  return out;
}

function indexModelparams(
  catalog: unknown,
  segModelparams: SegmentIndex,
  segProvider: Map<string, SegmentIndex>,
): Map<string, Map<string, SourceRecord>> {
  const out = new Map<string, Map<string, SourceRecord>>();
  if (!Array.isArray(catalog)) return out;
  for (const raw of catalog) {
    if (!isRecord(raw)) continue;
    const modelId = firstString(raw.model);
    const provider = firstString(raw.provider);
    if (!modelId || !provider) continue;
    const fields: MetadataFields = {};
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
    const key = `${provider.toLowerCase()}|${typeof raw.authType === "string" ? raw.authType : ""}`;
    let table = out.get(key);
    if (!table) {
      table = new Map();
      out.set(key, table);
    }
    if (!table.has(modelId)) {
      const access: AccessType | "catalog" =
        raw.authType === "api_key" || raw.authType === "subscription" ? raw.authType : "catalog";
      const record: SourceRecord = {
        site: "modelparams.dev",
        provider: provider.toLowerCase(),
        modelId,
        sourceKey: modelId,
        authType: raw.authType,
        fields,
      };
      table.set(modelId, record);
      const hit: IndexedHit = {
        site: "modelparams.dev",
        provider: record.provider,
        access,
        kind: "params",
        sourceId: modelId,
        sourceKey: modelId,
        level: 1,
        record,
      };
      segmentIndexAdd(segModelparams, hit);
      const segKey = `modelparams.dev|${key}`;
      let segTable = segProvider.get(segKey);
      if (!segTable) {
        segTable = new Map();
        segProvider.set(segKey, segTable);
      }
      segmentIndexAdd(segTable, hit);
    }
  }
  return out;
}

function indexData(tables: SourceTables): IndexedData {
  const seg: IndexedData["seg"] = {
    modelsDev: new Map(),
    canonical: new Map(),
    modelparams: new Map(),
    provider: new Map(),
  };
  const modelsDev = indexModelsDev(tables.modelsDev?.providers, seg.modelsDev, seg.provider);
  const canonical = indexCanonicalModels(tables.modelsDev?.models, seg.canonical);
  const modelparams = indexModelparams(tables.modelparams?.catalog, seg.modelparams, seg.provider);
  return { modelsDev, canonical, modelparams, seg };
}

// ---------------------------------------------------------------------------
// RFC 7396 JSON Merge Patch (on the final Pi model object).
// ---------------------------------------------------------------------------

const UNSAFE_PATCH_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function mergePatch(target: Record<string, unknown>, patch: Readonly<Record<string, unknown>>): Record<string, unknown> {
  for (const key of Object.keys(patch)) {
    // Skip keys that would read or write the prototype chain (CVE-safe RFC 7396).
    if (UNSAFE_PATCH_KEYS.has(key)) continue;
    const value = patch[key];
    if (value === null) {
      delete target[key];
    } else if (isRecord(value)) {
      const current = Object.hasOwn(target, key) && isRecord(target[key])
        ? (target[key] as Record<string, unknown>)
        : {};
      target[key] = mergePatch(current, value);
    } else {
      target[key] = value;
    }
  }
  return target;
}

// ---------------------------------------------------------------------------
// Metadata-field layer (unchanged semantics, minus selector machinery).
// ---------------------------------------------------------------------------

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

export function fieldIsMissing(canonical: string, value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (canonical === "supported_reasoning_levels" && Array.isArray(value)) return false;
  return !fieldIsValid(canonical, value);
}

/** merge(U, E) external wins; fill-only keeps upstream where present. */
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
    if (!fieldIsMissing(key, value)) out[key] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Per-model compilation.
// ---------------------------------------------------------------------------

/** Selection marks written onto model-level candidates during compilation. */
type HitMarks = Map<string, { status: "selected" | "skipped"; reason: string; access?: AccessType }>;

function hitKey(site: MetadataSite, provider: string, access: string, kind: string, sourceKey: string, sourceId: string): string {
  return `${site}|${provider}|${access}|${kind}|${sourceKey}|${sourceId}`;
}

/** Identity key of a hit — same shape collectHits dedupes on. */
function markKeyOf(hit: IndexedHit): string {
  return hitKey(hit.site, hit.provider, hit.access, hit.kind, hit.sourceKey, hit.sourceId);
}

/** Capability signature ignoring the display name (aliases may rename). */
function capabilitySignature(record: SourceRecord | undefined): string {
  const fields = { ...(record?.fields ?? {}) };
  delete fields.name;
  return JSON.stringify(fields);
}

type TableSelection = {
  record?: SourceRecord;
  /** The exact hit that supplied the selected record (its spelling/level). */
  selectedHit?: IndexedHit;
  reason?: string;
};

/**
 * Selects the record(s) a provider table may contribute: only the highest
 * match level counts; same-level hits must collapse to one canonical group
 * with consistent capability fields, otherwise the group is diagnosed and
 * skipped rather than picked by enumeration order.
 */
function selectFromHits(hits: readonly IndexedHit[]): TableSelection & { atBest: IndexedHit[]; rest: IndexedHit[] } {
  if (hits.length === 0) return { atBest: [], rest: [] };
  const level = Math.min(...hits.map((hit) => hit.level));
  const atBest = hits.filter((hit) => hit.level === level);
  const rest = hits.filter((hit) => hit.level !== level);
  const groups = new Map<string, IndexedHit[]>();
  for (const hit of atBest) {
    const canonical = hit.record?.canonicalModelId;
    const physicalKey = `${hit.site}|${hit.provider}|${hit.access}|${hit.kind}|${hit.sourceKey}`;
    const key = canonical ? (normalizeCanonical(canonical) ?? `?|${physicalKey}`) : `?|${physicalKey}`;
    const group = groups.get(key);
    if (group) group.push(hit);
    else groups.set(key, [hit]);
  }
  if (groups.size > 1) {
    const ids = atBest.map((hit) => hit.sourceId).sort().join(", ");
    return { atBest, rest, reason: `multiple canonical identities at the same match level (${ids})` };
  }
  const group = [...groups.values()][0].slice().sort((a, b) => (a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0));
  const first = group[0];
  if (group.some((hit) => capabilitySignature(hit.record) !== capabilitySignature(first.record))) {
    const ids = group.map((hit) => hit.sourceId).join(", ");
    return { atBest, rest, reason: `conflicting same-level aliases (${ids})` };
  }
  return { record: first.record, selectedHit: first, atBest, rest };
}

/** Marks the non-selected members of a selection on the model's candidates. */
function markSelection(
  marks: HitMarks,
  selection: { record?: SourceRecord; selectedHit?: IndexedHit; reason?: string; atBest: IndexedHit[]; rest: IndexedHit[] },
  access: AccessType,
): void {
  for (const hit of selection.atBest) {
    const key = markKeyOf(hit);
    if (selection.selectedHit === hit) {
      marks.set(key, { status: "selected", reason: "selected source record", access });
    } else if (selection.reason) {
      marks.set(key, { status: "skipped", reason: selection.reason });
    } else if (selection.record) {
      marks.set(key, { status: "skipped", reason: `deduplicated alias of ${selection.selectedHit?.sourceId ?? "the selected record"}` });
    } else {
      marks.set(key, { status: "skipped", reason: "lower match level than the selected source" });
    }
  }
  for (const hit of selection.rest) {
    marks.set(markKeyOf(hit), { status: "skipped", reason: "lower match level than the selected source" });
  }
}

/** Segments of the highest-level hits — the model's proven source ids. */
function bestLevelSegments(hits: readonly IndexedHit[]): string[] {
  if (hits.length === 0) return [];
  const level = Math.min(...hits.map((hit) => hit.level));
  const out: string[] = [];
  for (const hit of hits) {
    if (hit.level !== level) continue;
    const segment = hit.sourceId.slice(hit.sourceId.lastIndexOf("/") + 1);
    if (!out.includes(segment)) out.push(segment);
  }
  return out;
}

/** Builds one CompiledEntry with provider fields and unified-canonical fill. */
function makeEntry(
  entry: ChainEntry,
  provider: string,
  record: SourceRecord,
  canonical: string | undefined,
  unified: SourceRecord | undefined,
): CompiledEntry {
  const fields = normalizeFields(record.fields);
  const fieldSources: Record<string, FieldSource> = {};
  for (const key of Object.keys(fields)) fieldSources[key] = "provider";
  // Unified canonical data only fills gaps for the automatic api_key path.
  if (entry.access === "api_key" && unified) {
    for (const [key, value] of Object.entries(normalizeFields(unified.fields))) {
      if (value !== undefined && fieldIsMissing(key, fields[key])) {
        fields[key] = value;
        fieldSources[key] = "canonical";
      }
    }
  }
  return {
    entry: `${entry.site}/${provider}/${entry.access}/${record.modelId}`,
    site: entry.site,
    provider,
    access: entry.access,
    modelId: record.modelId,
    fields,
    canonical,
    fieldSources,
  };
}

/** Exact literal lookup for an explicit 4th chain segment (no expansion). */
function literalRecord(entry: ChainEntry, data: IndexedData): SourceRecord | undefined {
  const table = entry.site === "models.dev"
    ? data.modelsDev.get(entry.provider)
    : data.modelparams.get(`${entry.provider}|${entry.access}`);
  return table?.get(entry.model);
}

/**
 * Drops hits whose declared canonical disagrees with the resolved identity —
 * the AUTOMATIC @creator constraint. Explicit provider/literal selections
 * call this only for @creator-derived lookup paths (`automatic === false`
 * bypasses the filter entirely: a user's explicit choice is not overruled).
 */
function filterByCanonical(
  hits: readonly IndexedHit[],
  canonical: CanonicalResolution,
  marks: HitMarks,
  automatic: boolean,
): IndexedHit[] {
  if (!automatic || !canonical.canonicalKey) return [...hits];
  return hits.filter((hit) => {
    const declared = hit.record?.canonicalModelId;
    if (!declared) return true;
    if (normalizeCanonical(declared) === canonical.canonicalKey) return true;
    marks.set(markKeyOf(hit), {
      status: "skipped",
      reason: `declared canonical ${declared} conflicts with resolved ${canonical.canonical}`,
    });
    return false;
  });
}

type CompileEntryResult = {
  compiled: CompiledEntry[];
  unresolved?: string;
  skipReason?: string;
  /** Canonical/literal follow-up hits discovered after identity resolution;
   * they join the model's exported candidates with their own reasons. */
  extraHits?: IndexedHit[];
};

/**
 * Provider-table records the original query proved, restricted to one site
 * provider (and modelparams access group), then canonical-filtered. Levels
 * are the ORIGINAL query tiers — a canonical follow-up lookup may never
 * demote an existing exact hit or promote a regex alias into a new tier.
 */
function originalProviderHits(
  hits: readonly IndexedHit[],
  site: MetadataSite,
  provider: string,
  access: AccessType,
  canonical: CanonicalResolution,
  marks: HitMarks,
  automatic: boolean,
): IndexedHit[] {
  const scoped = hits.filter(
    (hit) =>
      !hit.unified &&
      hit.site === site &&
      hit.provider === provider &&
      (site === "models.dev" || hit.access === access),
  );
  return filterByCanonical(scoped, canonical, marks, automatic);
}

/**
 * Compiles one configured chain entry into concrete entries. Literal
 * providers and literal model segments keep exact lookups; `@id` uses the
 * full collected hits; `@creator` uses the resolved canonical identity for
 * provider expansion and record location. Resellers never supply fields.
 */
function compileEntry(
  entry: ChainEntry,
  publicId: string,
  hits: readonly IndexedHit[],
  canonical: CanonicalResolution,
  data: IndexedData,
  marks: HitMarks,
): CompileEntryResult {
  const unresolvedToken = (provider: string) =>
    `${entry.site}/${provider}/${entry.access}/${entry.model === "@id" ? "@id" : entry.model}`;
  const compiled: CompiledEntry[] = [];
  const extraHits: IndexedHit[] = [];

  // Explicit literal model segment: exact source id, no expansion at all.
  if (entry.model !== "@id") {
    if (entry.provider === "@creator") {
      // @creator + literal model: expand the resolved creator providers, then
      // exact-lookup the literal id. Unified fallback stays off — this path
      // is an explicit source constraint, and the literal id is queried
      // verbatim (no canonical remap, no separator regex).
      if (!canonical.creator) return { compiled: [], unresolved: unresolvedToken("@creator") };
      const compiled: CompiledEntry[] = [];
      const literalHit = (provider: string, record: SourceRecord): IndexedHit => ({
        site: entry.site,
        provider,
        access: entry.site === "models.dev" ? "catalog" : entry.access,
        kind: entry.site === "models.dev" ? "provider" : "params",
        sourceId: entry.model,
        sourceKey: record.sourceKey ?? record.modelId,
        level: 0,
        canonical: record.canonicalModelId,
        record,
      });
      if (entry.site === "models.dev") {
        for (const provider of creatorExpansion(canonical.creator)) {
          const record = data.modelsDev.get(provider)?.get(entry.model);
          if (record) {
            const hit = literalHit(provider, record);
            compiled.push(makeEntry(entry, provider, record, record.canonicalModelId, undefined));
            marks.set(markKeyOf(hit), { status: "selected", reason: "literal chain segment", access: entry.access });
            extraHits.push(hit);
          }
        }
      } else {
        const mpProviders = new Set<string>();
        for (const key of data.modelparams.keys()) mpProviders.add(key.split("|")[0]);
        for (const provider of creatorExpansion(canonical.creator)) {
          if (!mpProviders.has(provider)) continue;
          const record = data.modelparams.get(`${provider}|${entry.access}`)?.get(entry.model);
          if (record) {
            const hit = literalHit(provider, record);
            compiled.push(makeEntry(entry, provider, record, record.canonicalModelId, undefined));
            marks.set(markKeyOf(hit), { status: "selected", reason: "literal chain segment", access: entry.access });
            extraHits.push(hit);
          }
        }
      }
      if (compiled.length === 0) return { compiled: [], unresolved: unresolvedToken("@creator") };
      return { compiled, extraHits };
    }
    const record = literalRecord(entry, data);
    if (!record) return { compiled: [], unresolved: unresolvedToken(entry.provider) };
    // The hit's identity key uses its own access group (models.dev records are
    // "catalog"); the mark carries the declared chain access for the export.
    const hit: IndexedHit = {
      site: entry.site,
      provider: entry.provider,
      access: entry.site === "models.dev" ? "catalog" : entry.access,
      kind: entry.site === "models.dev" ? "provider" : "params",
      sourceId: entry.model,
      sourceKey: record.sourceKey ?? record.modelId,
      level: 0,
      canonical: record.canonicalModelId,
      record,
    };
    marks.set(markKeyOf(hit), { status: "selected", reason: "literal chain segment", access: entry.access });
    return { compiled: [makeEntry(entry, entry.provider, record, record.canonicalModelId, undefined)], extraHits: [hit] };
  }

  if (entry.provider !== "@creator") {
    // Explicit provider: source-local hits only; the automatic canonical
    // filter must not overrule the user's explicit provider choice.
    const scoped = originalProviderHits(hits, entry.site, entry.provider, entry.access, canonical, marks, false);
    const selection = selectFromHits(scoped);
    markSelection(marks, selection, entry.access);
    if (!selection.record) {
      return { compiled: [], unresolved: unresolvedToken(entry.provider), skipReason: selection.reason };
    }
    return { compiled: [makeEntry(entry, entry.provider, selection.record, selection.record.canonicalModelId, undefined)] };
  }

  // @creator: requires at least a uniquely known creator (checked by
  // caller). A contested canonical MODEL only blocks identity-dependent
  // steps (canonical remap, unified fallback); source-local lookup inside
  // the maker's own tables still runs on the original query tiers.
  const creator = canonical.creator!;
  const canonicalId = canonical.canonical;
  const canonicalKey = canonical.canonicalKey;
  const canonicalBareId = canonicalId ? canonicalBare(canonicalId) : undefined;
  // Declared hints may spell an alias-group member; the unified table may
  // key the same identity under the normalized group head instead. No
  // unified record is trusted while the canonical model is contested.
  const unified = canonicalId
    ? data.canonical.get(canonicalId) ?? data.canonical.get(canonicalKey ?? "")
    : undefined;
  let skipReason: string | undefined;

  if (entry.site === "models.dev") {
    const providers = creatorExpansion(creator).filter((provider) => data.modelsDev.has(provider));
    for (const provider of providers) {
      // Original hits keep their tiers; only when the provider produced none
      // does the canonical follow-up lookup run (its own literal/regex
      // tiers). Under a contested canonical model, source-local records in
      // the maker's own table still stand on their own declared canonical;
      // identity-dependent remap/fallback stays off.
      let scoped = originalProviderHits(hits, entry.site, provider, entry.access, canonical, marks, !canonical.ambiguousReason);
      if (scoped.length === 0 && canonicalId && canonicalBareId) {
        const queryIds = [canonicalBareId, ...bestLevelSegments(hits)];
        const followup = filterByCanonical(
          collectTableHits(data.seg.provider.get(`models.dev|${provider}`), queryIds),
          canonical,
          marks,
          true,
        );
        extraHits.push(...followup);
        scoped = followup;
      }
      const selection = selectFromHits(scoped);
      markSelection(marks, selection, entry.access);
      if (selection.record) {
        // Entry records the ACTUAL record's canonical provenance; the
        // resolved identity only constrained which records were eligible.
        compiled.push(makeEntry(entry, provider, selection.record, selection.record.canonicalModelId ?? canonicalId, unified));
      } else if (selection.reason) {
        skipReason = `${provider}: ${selection.reason}`;
      }
    }
    // Unified canonical data can form a logical entry when the canonical
    // provider itself has no concrete record (automatic api_key only).
    const literalProvider = canonicalId ? canonicalPrefix(canonicalId) : undefined;
    if (entry.access === "api_key" && unified && literalProvider && !compiled.some((item) => item.provider === literalProvider)) {
      const fields = normalizeFields(unified.fields);
      const fieldSources: Record<string, FieldSource> = {};
      for (const key of Object.keys(fields)) fieldSources[key] = "canonical";
      compiled.push({
        entry: `${entry.site}/${literalProvider}/${entry.access}/${canonicalBareId}`,
        site: entry.site,
        provider: literalProvider,
        access: entry.access,
        modelId: canonicalBareId!,
        fields,
        canonical: canonicalId,
        fieldSources,
      });
      marks.set(hitKey("models.dev", literalProvider, "catalog", "canonical", unified.sourceKey ?? unified.modelId, unified.modelId), { status: "selected", reason: "unified canonical data (no provider record)", access: entry.access });
    }
  } else {
    const mpProviders = new Set<string>();
    for (const key of data.modelparams.keys()) mpProviders.add(key.split("|")[0]);
    const providers = creatorExpansion(creator).filter((provider) => mpProviders.has(provider));
    for (const provider of providers) {
      // Same source-local principle for modelparams: an independently
      // unambiguous record inside this maker's own auth-scoped table
      // supplies its own fields and declares its own canonical provenance.
      let scoped = originalProviderHits(hits, entry.site, provider, entry.access, canonical, marks, !canonical.ambiguousReason);
      if (scoped.length === 0 && canonicalId && canonicalBareId) {
        const queryIds = [canonicalBareId, ...bestLevelSegments(hits)];
        const followup = filterByCanonical(
          collectTableHits(data.seg.provider.get(`modelparams.dev|${provider}|${entry.access}`), queryIds),
          canonical,
          marks,
          true,
        );
        extraHits.push(...followup);
        scoped = followup;
      }
      const selection = selectFromHits(scoped);
      markSelection(marks, selection, entry.access);
      if (selection.record) {
        compiled.push(makeEntry(entry, provider, selection.record, selection.record.canonicalModelId ?? canonicalId, undefined));
      } else if (selection.reason) {
        skipReason = `${provider}: ${selection.reason}`;
      }
    }
  }
  if (compiled.length === 0) {
    return { compiled: [], unresolved: unresolvedToken("@creator"), skipReason, extraHits };
  }
  return { compiled, extraHits };
}

/** Builds the exported per-model candidate list with selection outcomes. */
function buildCandidates(hits: readonly IndexedHit[], marks: HitMarks, canonical: CanonicalResolution): QueryCandidate[] {
  // Follow-up lookups may re-surface records the original query already saw;
  // collapse by identity key (best mark/level wins).
  const byKey = new Map<string, { hit: IndexedHit; mark?: { status: "selected" | "skipped"; reason: string; access?: AccessType } }>();
  for (const hit of hits) {
    const key = markKeyOf(hit);
    const mark = marks.get(key);
    const prev = byKey.get(key);
    if (!prev || hit.level < prev.hit.level) byKey.set(key, { hit, mark });
  }
  const out: QueryCandidate[] = [...byKey.values()].map(({ hit, mark }) => {
    let selected = mark?.status === "selected";
    let reason = mark?.reason;
    if (!selected && hit.unified && (canonical.canonical === hit.canonical || canonical.canonicalKey === hit.canonical)) {
      selected = true;
      reason = reason ?? "canonical identity evidence";
    }
    if (!selected && !reason) {
      reason = hit.unified
        ? "not the resolved canonical identity"
        : "outside the effective chain or superseded by a higher-priority match";
    }
    return {
      site: hit.site,
      provider: hit.provider,
      // Selected records report the selecting entry's declared access; an
      // unselected catalog record stays "catalog" (identity evidence only).
      access: mark?.access ?? hit.access,
      kind: hit.kind,
      sourceId: hit.sourceId,
      sourceKey: hit.sourceKey,
      level: hit.level,
      canonical: hit.canonical,
      selected,
      reason,
    };
  });
  out.sort(
    (a, b) =>
      a.level - b.level ||
      a.site.localeCompare(b.site) ||
      a.provider.localeCompare(b.provider) ||
      a.access.localeCompare(b.access) ||
      a.sourceKey.localeCompare(b.sourceKey),
  );
  return out;
}

/**
 * Compiles config + catalog + external data into per-model concrete chains.
 * Throws MetadataConfigError only for @creator conflict on models whose
 * effective chain uses @creator.
 */
export function compileCatalog(
  config: MetadataConfig,
  publicIds: readonly string[],
  tables: SourceTables,
): CompiledCatalog {
  const data = indexData(tables);
  const rootChain = config.chain ?? DEFAULT_CHAIN;
  const degraded = tables.degraded ?? [];
  // Whole-site degradation skips its chain entries; a degraded models.dev
  // shape (providers or models) only disables the steps needing that shape.
  const degradedSites = new Set(degraded.filter((item) => item.scope === undefined).map((item) => item.site));
  const models: CompiledModel[] = [];
  const queryCache = new Map<string, IndexedHit[]>();

  for (const publicId of publicIds) {
    // Ordered layering: every matching rule applies, later wins per field.
    const matched: { index: number; rule: ModelRule }[] = [];
    config.models?.forEach((rule, index) => {
      if (matchModelPattern(rule.match, publicId)) matched.push({ index, rule });
    });
    let effectiveChain: readonly string[] = rootChain;
    let fillMissingOnly = config.fillMissingOnly ?? false;
    // Ordered patches: applied one by one to the final Pi model so `null`
    // deletes and full-object resets keep their RFC 7396 meaning — merging
    // them into a single patch here would erase `null` before application.
    const overridePatches: Record<string, unknown>[] = [];
    for (const { rule } of matched) {
      if (rule.chain !== undefined) effectiveChain = rule.chain;
      if (rule.fillMissingOnly !== undefined) fillMissingOnly = rule.fillMissingOnly;
      if (rule.overrides) overridePatches.push({ ...rule.overrides });
    }
    // Expand @default against the root effective chain.
    const parsed = expandChain(effectiveChain, rootChain, `models match ${JSON.stringify(publicId)} chain`);
    const usesCreator = parsed.some((entry) => entry.provider === "@creator");
    // One query per distinct last segment, reused by every chain entry.
    const segment = querySegment(publicId);
    let hits = queryCache.get(segment);
    if (!hits) {
      hits = collectHits([data.seg.modelsDev, data.seg.canonical, data.seg.modelparams], segment);
      queryCache.set(segment, hits);
    }
    const canonical = resolveCanonical(hits);
    // Follow-up evidence is export-only; later entries query the original hits.
    const evidenceHits = hits.slice();
    const marks: HitMarks = new Map();
    const entries: CompiledEntry[] = [];
    const unresolved: string[] = [];
    const skippedEntries: { entry: string; reason: string }[] = [];
    const conflicts: string[] = [];
    for (const entry of parsed) {
      if (degradedSites.has(entry.site)) {
        unresolved.push(`${entry.site}/${entry.provider}/${entry.access}/${entry.model}`);
        continue;
      }
      if (entry.provider === "@creator") {
        if (canonical.conflictingCreators) {
          if (usesCreator) conflicts.push(...canonical.conflictingCreators);
          continue;
        }
        const token = `${entry.site}/@creator/${entry.access}/@id`;
        if (canonical.ambiguousReason) {
          // The canonical MODEL is contested: identity remap and unified
          // fallback stay blocked, but a uniquely known creator may still
          // resolve independently unambiguous records inside its own tables.
          // The diagnosis is recorded whether or not source-local succeeds.
          skippedEntries.push({ entry: token, reason: canonical.ambiguousReason });
          if (!canonical.creator) {
            unresolved.push(token);
            continue;
          }
        }
        if (!canonical.creator) {
          unresolved.push(token);
          continue;
        }
      }
      const { compiled, unresolved: miss, skipReason, extraHits } = compileEntry(entry, publicId, hits, canonical, data, marks);
      entries.push(...compiled);
      if (extraHits) evidenceHits.push(...extraHits);
      if (miss) {
        unresolved.push(miss);
        if (skipReason) skippedEntries.push({ entry: miss, reason: skipReason });
      }
    }
    if (conflicts.length > 0) {
      throw new MetadataConfigError(
        `model ${JSON.stringify(publicId)}`,
        `ambiguous @creator: canonical creators ${[...new Set(conflicts)].join(", ")} disagree; set an explicit provider in this model's chain`,
      );
    }
    // Provider records that only supplied an identity hint keep an explicit
    // reason (resellers never contribute fields, but the hint itself mattered).
    for (const hit of evidenceHits) {
      const key = markKeyOf(hit);
      if (!marks.has(key) && !hit.unified && canonical.canonical && hit.canonical === canonical.canonical) {
        marks.set(key, { status: "skipped", reason: `canonical identity hint (${canonical.canonical})` });
      }
    }
    models.push({
      publicId,
      matchedRules: matched.map(({ index }) => index + 1),
      fillMissingOnly,
      entries,
      unresolved,
      candidates: buildCandidates(evidenceHits, marks, canonical),
      externalChain: parsed.length > 0,
      canonical: canonical.canonical,
      skippedEntries: skippedEntries.length > 0 ? skippedEntries : undefined,
      overridePatches,
    });
  }

  return {
    config: { rootChain, fillMissingOnly: config.fillMissingOnly ?? false, rules: config.models ?? [] },
    dataVersions: {
      modelsDevVersion: tables.modelsDevVersion,
      modelsDevGeneratedAt: tables.modelsDevGeneratedAt,
      modelparamsVersion: tables.modelparamsVersion,
    },
    degraded,
    models,
    warnings: config.warnings,
  };
}

// ---------------------------------------------------------------------------
// Execution: concrete-entry lookup -> merged fields.
// ---------------------------------------------------------------------------

/**
 * Resolves external fields for one compiled model: each field takes the
 * first entry that provides a valid value.
 */
/**
 * Capability keys that count as real external metadata; a `name`-only record
 * is not a capability hit. Shared by the catalog reporter and the export
 * view so both classify the same way without importing each other.
 */
export const CAPABILITY_KEYS: ReadonlySet<string> = new Set([
  "context_window",
  "max_input_tokens",
  "max_output_tokens",
  "supported_reasoning_levels",
  "default_reasoning_level",
  "input_modalities",
  "output_modalities",
]);

/** True when the compiled model gained at least one valid capability field. */
export function hasCapabilityField(model: CompiledModel): boolean {
  const fields = externalFields(model);
  return Object.keys(fields).some(
    (key) => CAPABILITY_KEYS.has(key) && !fieldIsMissing(key, fields[key]),
  );
}

/** Per-model match class: complete / partial / unmatched / disabled. */
export type MatchClass = "complete" | "partial" | "unmatched" | "disabled";

/**
 * Classifies one compiled model: enabled chains split into complete (valid
 * capability fields, nothing unresolved), partial (fields but an entry
 * unresolved) and unmatched (no capability field at all); an explicitly
 * empty effective chain is disabled and never counts as a failure.
 */
export function classifyModelMatch(model: CompiledModel): MatchClass {
  if (!model.externalChain) return "disabled";
  if (!hasCapabilityField(model)) return "unmatched";
  return model.unresolved.length > 0 ? "partial" : "complete";
}

export function externalFields(compiled: CompiledModel): MetadataFields {
  const fields: MetadataFields = {};
  const declared = new Set<string>();
  for (const entry of compiled.entries) {
    for (const [key, value] of Object.entries(entry.fields)) {
      if (value === undefined || value === null || declared.has(key)) continue;
      declared.add(key);
      fields[key] = value;
    }
  }
  return fields;
}

/**
 * The full per-model resolution callback for mapCatalog: external chain ->
 * merge with upstream -> overrides are applied to the Pi model afterwards
 * (mapModel step), not here.
 */
export function makeResolver(compiled: CompiledCatalog) {
  const byId = new Map(compiled.models.map((model) => [model.publicId, model]));
  return {
    resolve(publicId: string, upstream: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
      const model = byId.get(publicId);
      const external = model ? externalFields(model) : {};
      return mergeMetadata(upstream, external, model?.fillMissingOnly ?? false);
    },
    overridePatches(publicId: string): Record<string, unknown>[] {
      return byId.get(publicId)?.overridePatches ?? [];
    },
  };
}
