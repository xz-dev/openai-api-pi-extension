/**
 * Pure model-metadata resolution: YAML config validation, chain-entry
 * parsing, ordered model-rule layering, @id normalization candidates,
 * @creator/alias-group resolution, RFC 7396 merge for overrides, and the
 * compile-time view that turns one config + one catalog + external data into
 * a concrete per-model chain. No network or filesystem I/O lives here;
 * metadata-compile.ts owns data-package loading inside the Worker and
 * index.ts owns the provider lifecycle.
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
// @id normalization candidates (fixed order; first hit wins per table).
// ---------------------------------------------------------------------------

const DATE_SUFFIX = /-(?:\d{8}|\d{4}-\d{2}-\d{2})$/;

/**
 * Ordered query candidates for the last `/` segment of a public id:
 * as-is, lowercase, `.`-between-digits to `-`, `-`-between-digits to `.`,
 * then without a trailing date suffix. Deduped, order preserved.
 */
export function idCandidates(publicId: string): readonly string[] {
  const slash = publicId.lastIndexOf("/");
  const base = publicId.slice(slash + 1);
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

// ---------------------------------------------------------------------------
// Source data (loaded by the Worker, used by the compiler).
// ---------------------------------------------------------------------------

/** One external record after package normalization. */
export type SourceRecord = {
  site: MetadataSite;
  provider: string;
  modelId: string;
  authType?: unknown;
  canonicalModelId?: string;
  providerName?: string;
  fields: MetadataFields;
};

export type SourceTables = {
  modelsDev: { providers?: unknown } | undefined;
  modelparams: { catalog?: unknown } | undefined;
  /** Human-readable versions for the compile output. */
  modelsDevVersion?: string;
  modelsDevGeneratedAt?: string;
  modelparamsVersion?: string;
  degraded: { site: MetadataSite; reason: string }[];
};

// ---------------------------------------------------------------------------
// Compilation.
// ---------------------------------------------------------------------------

export type CompiledEntry = {
  /** Concrete "site/provider/access/modelId". */
  entry: string;
  site: MetadataSite;
  provider: string;
  access: AccessType;
  modelId: string;
  /** The fields this record supplies after alias normalization. */
  fields: MetadataFields;
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
  /** Ordered RFC 7396 patches from matching rules; applied in order to the final Pi model. */
  overridePatches: Record<string, unknown>[];
};

export type CompiledCatalog = {
  config: { rootChain: readonly string[]; fillMissingOnly: boolean; rules: readonly ModelRule[] };
  dataVersions: { modelsDevVersion?: string; modelsDevGeneratedAt?: string; modelparamsVersion?: string };
  degraded: { site: MetadataSite; reason: string }[];
  models: CompiledModel[];
  warnings: readonly string[];
};

type IndexedData = {
  /** models.dev provider -> modelId -> record (also alias ids kept distinct). */
  modelsDev: Map<string, Map<string, SourceRecord>>;
  /** modelparams provider|access -> modelId -> record. */
  modelparams: Map<string, Map<string, SourceRecord>>;
  /** canonical lookup: bare model id -> set of canonical creator groups. */
  creatorById: Map<string, Set<string>>;
};

function effortValuesToLevels(values: unknown): unknown[] | undefined {
  if (!Array.isArray(values)) return undefined;
  return values.map((value) => (isRecord(value) ? value : { effort: value }));
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.trim() !== "")?.trim();
}

function indexModelsDev(providers: unknown): Map<string, Map<string, SourceRecord>> {
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
    for (const [key, raw] of Object.entries(entry.models)) {
      if (!isRecord(raw)) continue;
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
      const record: SourceRecord = {
        site: "models.dev",
        provider,
        modelId: key,
        canonicalModelId: firstString(raw.canonical_model_id),
        providerName,
        fields,
      };
      table.set(key, record);
      const alias = firstString(raw.id);
      if (alias && alias !== key && !table.has(alias)) table.set(alias, { ...record, modelId: alias });
    }
  }
  return out;
}

function indexModelparams(catalog: unknown): Map<string, Map<string, SourceRecord>> {
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
      table.set(modelId, {
        site: "modelparams.dev",
        provider: provider.toLowerCase(),
        modelId,
        authType: raw.authType,
        fields,
      });
    }
  }
  return out;
}

/** Builds the creator index: bare source model id -> canonical creator groups. */
function indexCreators(modelsDev: Map<string, Map<string, SourceRecord>>): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const table of modelsDev.values()) {
    for (const record of table.values()) {
      const canonical = record.canonicalModelId;
      if (!canonical) continue;
      const slash = canonical.indexOf("/");
      if (slash <= 0) continue;
      const bareSlash = record.modelId.lastIndexOf("/");
      const bare = bareSlash < 0 ? record.modelId : record.modelId.slice(bareSlash + 1);
      const creator = canonicalCreator(canonical.slice(0, slash));
      for (const id of [record.modelId, bare]) {
        let set = out.get(id);
        if (!set) {
          set = new Set();
          out.set(id, set);
        }
        set.add(creator);
      }
    }
  }
  return out;
}

function indexData(tables: SourceTables): IndexedData {
  const modelsDev = indexModelsDev(tables.modelsDev?.providers);
  const modelparams = indexModelparams(tables.modelparams?.catalog);
  return { modelsDev, modelparams, creatorById: indexCreators(modelsDev) };
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

/** Finds the first candidate present in one provider table (exact match). */
function firstHit(table: Map<string, SourceRecord> | undefined, candidates: readonly string[]): SourceRecord | undefined {
  if (!table) return undefined;
  for (const candidate of candidates) {
    const hit = table.get(candidate);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * Resolves `@creator` for one model against the canonical index. Returns the
 * ordered alias-expansion when unique, undefined when unresolved, or throws
 * MetadataConfigError when different creator groups conflict and the model's
 * effective chain uses @creator.
 */
function resolveCreator(
  candidates: readonly string[],
  data: IndexedData,
): { creators: readonly string[]; conflicting?: string[] } {
  for (const candidate of candidates) {
    const found = data.creatorById.get(candidate);
    if (found && found.size > 0) return { creators: [...found], conflicting: found.size > 1 ? [...found] : undefined };
  }
  return { creators: [] };
}

/** Expands one parsed chain entry into concrete provider targets for its site. */
function expandEntryProviders(entry: ChainEntry, publicId: string, data: IndexedData): { providers: string[]; unresolved?: boolean } {
  if (entry.provider !== "@creator") return { providers: [entry.provider] };
  const creators = resolveCreator(idCandidates(publicId), data).creators;
  if (creators.length === 0) return { providers: [], unresolved: true };
  const ordered = creators.flatMap((creator) => [...creatorExpansion(creator)]);
  const table = entry.site === "models.dev" ? data.modelsDev : undefined;
  if (entry.site === "models.dev") {
    const keys = table ? [...table.keys()] : [];
    return { providers: ordered.filter((p) => keys.includes(p)) };
  }
  // modelparams providers carry an authType segment in the map key.
  const mpProviders = new Set<string>();
  for (const key of data.modelparams.keys()) mpProviders.add(key.split("|")[0]);
  return { providers: ordered.filter((p) => mpProviders.has(p)) };
}

/**
 * Compiles one configured chain entry into concrete entries — one per
 * expanded provider that contains the model — or marks it unresolved.
 */
function compileEntry(
  entry: ChainEntry,
  publicId: string,
  data: IndexedData,
): { compiled: CompiledEntry[]; unresolved?: string } {
  const queryId = entry.model === "@id" ? undefined : entry.model;
  const { providers, unresolved } = expandEntryProviders(entry, publicId, data);
  if (unresolved) {
    return { compiled: [], unresolved: `${entry.site}/@creator/${entry.access}` };
  }
  const candidates = queryId !== undefined ? [queryId] : idCandidates(publicId);
  const compiled: CompiledEntry[] = [];
  for (const provider of providers) {
    let record: SourceRecord | undefined;
    if (entry.site === "models.dev") {
      record = firstHit(data.modelsDev.get(provider), candidates);
    } else {
      record = firstHit(data.modelparams.get(`${provider}|${entry.access}`), candidates);
    }
    if (record) {
      compiled.push({
        entry: `${entry.site}/${provider}/${entry.access}/${record.modelId}`,
        site: entry.site,
        provider,
        access: entry.access,
        modelId: record.modelId,
        fields: normalizeFields(record.fields),
      });
    }
  }
  if (compiled.length === 0) {
    return { compiled, unresolved: `${entry.site}/${providers[0] ?? entry.provider}/${entry.access}/${queryId ?? "@id"}` };
  }
  return { compiled };
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
  const degradedSites = new Set(degraded.map((item) => item.site));
  const models: CompiledModel[] = [];

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
    const entries: CompiledEntry[] = [];
    const unresolved: string[] = [];
    const conflicts: string[] = [];
    for (const entry of parsed) {
      if (degradedSites.has(entry.site)) {
        unresolved.push(`${entry.site}/${entry.provider}/${entry.access}/${entry.model}`);
        continue;
      }
      if (entry.provider === "@creator") {
        const creators = resolveCreator(idCandidates(publicId), data);
        if (creators.conflicting && usesCreator) {
          conflicts.push(...creators.conflicting);
          continue;
        }
      }
      const { compiled, unresolved: miss } = compileEntry(entry, publicId, data);
      entries.push(...compiled);
      if (miss) unresolved.push(miss);
    }
    if (conflicts.length > 0) {
      throw new MetadataConfigError(
        `model ${JSON.stringify(publicId)}`,
        `ambiguous @creator: canonical creators ${[...new Set(conflicts)].join(", ")} disagree; set an explicit provider in this model's chain`,
      );
    }
    models.push({
      publicId,
      matchedRules: matched.map(({ index }) => index + 1),
      fillMissingOnly,
      entries,
      unresolved,
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
