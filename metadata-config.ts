/**
 * YAML-dependent config parsing — split from model-metadata.ts because the
 * compile Worker must keep an import graph of only relative paths and node:
 * builtins (bare package specifiers do not resolve inside a Worker in the
 * Bun-compiled Pi host). The worker never imports this module.
 */
import { parseDocument } from "yaml";

import {
  MetadataConfigError,
  parseChainEntry,
  type MetadataConfig,
  type ModelRule,
} from "./model-metadata.ts";

/** Fields that used to configure the pre-compile implementation. */
const LEGACY_ROOT_FIELDS: Readonly<Record<string, string>> = {
  source_priority: "use `chain` with concrete entries like models.dev/@creator/api_key",
  provider_prefix_map: "use literal provider ids or @creator in `chain`",
  lookup_ids: "use a literal 4th chain segment, e.g. models.dev/<provider>/api_key/<query-id>",
  models_dev_subscription: "delete it; models.dev `access` is now a declared label and no naming rule applies",
  channels: "use `- match: \"<prefix>/*\"` rules; append the global chain with @default when needed",
  global_fallback: "write the rule's `chain` explicitly; @default inserts the root chain in place",
};
const KNOWN_ROOT_KEYS = new Set(["chain", "fill_missing_only", "models"]);
const KNOWN_RULE_KEYS = new Set(["match", "chain", "fill_missing_only", "overrides"]);
// Every removed field errors at rule level too — same migration hints as root.
const LEGACY_RULE_FIELDS: Readonly<Record<string, string>> = LEGACY_ROOT_FIELDS;
const FORBIDDEN_OVERRIDE_KEYS = new Set(["id", "provider", "api", "baseUrl"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readBool(value: unknown, path: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new MetadataConfigError(path, "expected a boolean");
  return value;
}

function readChain(value: unknown, path: string): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new MetadataConfigError(path, "expected a list of chain entry strings");
  }
  for (const token of value as string[]) {
    if (token !== "@default") parseChainEntry(token, `${path} item ${JSON.stringify(token)}`);
  }
  return value as readonly string[];
}

function readOverrides(value: unknown, path: string): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new MetadataConfigError(path, "expected a mapping");
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_OVERRIDE_KEYS.has(key)) {
      throw new MetadataConfigError(`${path}.${key}`, `overrides may not set ${key}`);
    }
  }
  return value;
}

function readModelRule(value: unknown, index: number, warnings: string[]): ModelRule {
  const path = `models[${index}]`;
  if (!isRecord(value)) throw new MetadataConfigError(path, "expected a mapping");
  for (const [key, hint] of Object.entries(LEGACY_RULE_FIELDS)) {
    if (Object.hasOwn(value, key)) throw new MetadataConfigError(`${path}.${key}`, `removed field; ${hint}`);
  }
  for (const key of Object.keys(value)) {
    if (!KNOWN_RULE_KEYS.has(key)) warnings.push(`${path}.${key}`);
  }
  const match = value.match;
  if (typeof match !== "string" || match === "") {
    throw new MetadataConfigError(`${path}.match`, "expected a non-empty glob string");
  }
  return {
    match,
    chain: readChain(value.chain, `${path}.chain`),
    fillMissingOnly: readBool(value.fill_missing_only, `${path}.fill_missing_only`),
    overrides: readOverrides(value.overrides, `${path}.overrides`),
  };
}

/**
 * Parses openai-api-extension.yaml. Missing/empty content yields an empty
 * config; invalid YAML, duplicate keys, invalid known values and every legacy
 * field raise MetadataConfigError. Unknown non-legacy fields are ignored and
 * reported once in `warnings`.
 */
export function parseMetadataConfig(yamlText: string | undefined): MetadataConfig {
  const warnings: string[] = [];
  if (yamlText === undefined || yamlText.trim() === "") return { warnings };
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

  // Legacy fields fail before unknown-field warnings so the migration hint is
  // the first thing the user sees.
  for (const [key, hint] of Object.entries(LEGACY_ROOT_FIELDS)) {
    if (Object.hasOwn(root, key)) throw new MetadataConfigError(key, `removed field; ${hint}`);
  }
  for (const key of Object.keys(root)) {
    if (!KNOWN_ROOT_KEYS.has(key)) warnings.push(key);
  }

  let models: ModelRule[] | undefined;
  if (root.models !== undefined) {
    if (!Array.isArray(root.models)) {
      throw new MetadataConfigError("models", "expected a list of `- match: <glob>` rules (the mapping form was removed)");
    }
    models = root.models.map((rule, index) => readModelRule(rule, index, warnings));
  }
  return {
    chain: readChain(root.chain, "chain"),
    fillMissingOnly: readBool(root.fill_missing_only, "fill_missing_only"),
    models,
    warnings,
  };
}
