/**
 * YAML-dependent config parsing — split from model-metadata.ts because the
 * compile Worker must keep an import graph of only relative paths and node:
 * builtins (bare package specifiers do not resolve inside a Worker in the
 * Bun-compiled Pi host). The worker never imports this module.
 */
import { parseDocument } from "yaml";

import { compileModelPattern } from "./metadata-glob.ts";
import {
  DEFAULT_CHAIN,
  DEFAULT_RECORD_SOURCES,
  MetadataConfigError,
  parseChainEntry,
  validateRecordSources,
  type IncludeRule,
  type MetadataConfig,
  type ModelRule,
} from "./model-metadata.ts";

/** Fields that used to configure the pre-compile implementation. */
const LEGACY_ROOT_FIELDS: Readonly<Record<string, string>> = {
  source_priority: "use `chain` with concrete entries like models.dev/@creator/api_key",
  provider_prefix_map: "use literal provider ids or @creator in `chain`",
  lookup_ids: "use a literal 4th chain segment, e.g. models.dev/<provider>/api_key/<query-id>",
  models_dev_subscription: "delete it; models.dev `access` is now a declared label and no naming rule applies",
  channels: "use `- match: \"<prefix>/**\"` rules; append the global chain with @default when needed",
  global_fallback: "write the rule's `chain` explicitly; @default inserts the root chain in place",
  fill_missing_only:
    "delete it and place @self in `chain` instead: external entries before @self replace the old `false`, @self before external entries replaces the old `true`",
};
const KNOWN_ROOT_KEYS = new Set(["chain", "models", "include_models"]);
const KNOWN_RULE_KEYS = new Set(["match", "chain", "overrides"]);
// Every removed field errors at rule level too — same migration hints as root.
const LEGACY_RULE_FIELDS: Readonly<Record<string, string>> = LEGACY_ROOT_FIELDS;
const FORBIDDEN_OVERRIDE_KEYS = new Set(["id", "provider", "api", "baseUrl"]);

export type MetadataConfigOptions = {
  /** Record source keywords the host registers; default `["@self"]`. */
  recordSources?: readonly string[];
  /** Prefix for every error/warning path when the config is a nested block. */
  pathPrefix?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type Ctx = { at: (path: string) => string; recordSources: readonly string[] };

function readChain(value: unknown, path: string, ctx: Ctx): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new MetadataConfigError(ctx.at(path), "expected a list of chain entry strings");
  }
  if (value.length === 0) {
    throw new MetadataConfigError(
      ctx.at(path),
      'an explicit empty chain is not allowed; use ["@self"] for upstream-only metadata or omit `chain` to inherit',
    );
  }
  for (const token of value as string[]) {
    if (token !== "@default") parseChainEntry(token, `${ctx.at(path)} item ${JSON.stringify(token)}`, ctx.recordSources);
  }
  return value as readonly string[];
}

function readOverrides(value: unknown, path: string, ctx: Ctx): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new MetadataConfigError(ctx.at(path), "expected a mapping");
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_OVERRIDE_KEYS.has(key)) {
      throw new MetadataConfigError(ctx.at(`${path}.${key}`), `overrides may not set ${key}`);
    }
  }
  return value;
}

function readModelRule(value: unknown, index: number, warnings: string[], ctx: Ctx): ModelRule {
  const path = `models[${index}]`;
  if (!isRecord(value)) throw new MetadataConfigError(ctx.at(path), "expected a mapping");
  for (const [key, hint] of Object.entries(LEGACY_RULE_FIELDS)) {
    if (Object.hasOwn(value, key)) throw new MetadataConfigError(ctx.at(`${path}.${key}`), `removed field; ${hint}`);
  }
  for (const key of Object.keys(value)) {
    if (!KNOWN_RULE_KEYS.has(key)) warnings.push(ctx.at(`${path}.${key}`));
  }
  const match = value.match;
  if (typeof match !== "string" || match === "") {
    throw new MetadataConfigError(ctx.at(`${path}.match`), "expected a non-empty glob string");
  }
  compileModelPattern(match, ctx.at(`${path}.match`));
  return {
    match,
    chain: readChain(value.chain, `${path}.chain`, ctx),
    overrides: readOverrides(value.overrides, `${path}.overrides`, ctx),
  };
}

function readIncludeModels(value: unknown, ctx: Ctx): IncludeRule[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new MetadataConfigError(ctx.at("include_models"), "expected a list of glob strings");
  if (value.length === 0) {
    throw new MetadataConfigError(
      ctx.at("include_models"),
      "an explicit empty list hides every model; omit `include_models` to keep all models",
    );
  }
  return value.map((item, index) => {
    const path = ctx.at(`include_models[${index}]`);
    if (typeof item !== "string" || item === "") throw new MetadataConfigError(path, "expected a non-empty glob string");
    const exclude = item.startsWith("!");
    const glob = exclude ? item.slice(1) : item;
    if (glob === "") throw new MetadataConfigError(path, "`!` must be followed by a glob");
    compileModelPattern(glob, path);
    return { raw: item, exclude, glob };
  });
}

/**
 * Validates an already-parsed config value (e.g. a host's nested `metadata:`
 * block). `undefined`/`null` yield an empty config. Invalid known values and
 * every legacy field raise MetadataConfigError with `pathPrefix` applied;
 * unknown non-legacy fields are ignored and reported in `warnings`.
 * An invalid record-source registration is a host error (TypeError).
 */
export function parseMetadataConfigValue(value: unknown, options: MetadataConfigOptions = {}): MetadataConfig {
  const recordSources = validateRecordSources(options.recordSources ?? DEFAULT_RECORD_SOURCES);
  const prefix = options.pathPrefix;
  const ctx: Ctx = { at: (path) => (prefix ? `${prefix}.${path}` : path), recordSources };
  const warnings: string[] = [];
  const root = value ?? {};
  if (!isRecord(root)) throw new MetadataConfigError(prefix ?? "openai-api-extension.yaml", "expected a top-level mapping");

  // Legacy fields fail before unknown-field warnings so the migration hint is
  // the first thing the user sees.
  for (const [key, hint] of Object.entries(LEGACY_ROOT_FIELDS)) {
    if (Object.hasOwn(root, key)) throw new MetadataConfigError(ctx.at(key), `removed field; ${hint}`);
  }
  for (const key of Object.keys(root)) {
    if (!KNOWN_ROOT_KEYS.has(key)) warnings.push(ctx.at(key));
  }

  let models: ModelRule[] | undefined;
  if (root.models !== undefined) {
    if (!Array.isArray(root.models)) {
      throw new MetadataConfigError(ctx.at("models"), "expected a list of `- match: <glob>` rules (the mapping form was removed)");
    }
    models = root.models.map((rule, index) => readModelRule(rule, index, warnings, ctx));
  }
  const chain = readChain(root.chain, "chain", ctx);
  if (chain?.includes("@default")) {
    throw new MetadataConfigError(
      `${ctx.at("chain")} item "@default"`,
      "@default expands the root chain and is only allowed inside model rules",
    );
  }
  // The built-in default chain must be usable with this host's registry.
  if (chain === undefined) {
    for (const token of DEFAULT_CHAIN) {
      parseChainEntry(token, `${ctx.at("chain")} (built-in default) item ${JSON.stringify(token)}`, recordSources);
    }
  }
  const includeModels = readIncludeModels(root.include_models, ctx);
  return { chain, models, includeModels, recordSources, warnings };
}

/**
 * Parses openai-api-extension.yaml. Missing/empty content yields an empty
 * config; invalid YAML, duplicate keys, invalid known values and every legacy
 * field raise MetadataConfigError. Unknown non-legacy fields are ignored and
 * reported once in `warnings`.
 */
export function parseMetadataConfig(yamlText: string | undefined, options: MetadataConfigOptions = {}): MetadataConfig {
  if (yamlText === undefined || yamlText.trim() === "") return parseMetadataConfigValue(undefined, options);
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
  return parseMetadataConfigValue(root, options);
}
