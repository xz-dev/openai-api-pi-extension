import assert from "node:assert/strict";
import { test } from "node:test";
import {
  compileCatalog,
  DEFAULT_CHAIN,
  externalFields,
  idCandidates,
  matchModelPattern,
  mergeMetadata,
  mergePatch,
  MetadataConfigError,
  normalizeFields,
  parseChainEntry,
  type SourceTables,
} from "../model-metadata.ts";
import { parseMetadataConfig } from "../metadata-config.ts";

const cfg = (overrides: Record<string, unknown> = {}) => ({ warnings: [], ...overrides });

const tables = (overrides: Partial<SourceTables> = {}): SourceTables => ({
  modelsDev: { providers: {} },
  modelparams: { catalog: [] },
  degraded: [],
  ...overrides,
});

// --- config parsing ---------------------------------------------------------

test("parseMetadataConfig: missing file yields empty config", () => {
  const parsed = parseMetadataConfig(undefined);
  assert.deepEqual(parsed.warnings, []);
  assert.equal(parsed.chain, undefined);
});

test("parseMetadataConfig: valid config with chain, mode, ordered rules", () => {
  const parsed = parseMetadataConfig(`
chain: ["models.dev/@creator/api_key"]
fill_missing_only: true
models:
  - match: "proxy/*"
    fill_missing_only: true
    overrides:
      contextWindow: 200000
  - match: "proxy/claude"
    chain: ["models.dev/anthropic/api_key/claude-sonnet-4-5"]
`);
  assert.equal(parsed.fillMissingOnly, true);
  assert.deepEqual(parsed.chain, ["models.dev/@creator/api_key"]);
  assert.equal(parsed.models?.length, 2);
  assert.equal(parsed.models?.[1].match, "proxy/claude");
  assert.deepEqual(parsed.models?.[0].overrides, { contextWindow: 200000 });
});

test("parseMetadataConfig: invalid YAML, bad chain, non-bool mode are config errors", () => {
  assert.throws(() => parseMetadataConfig("a: ["), MetadataConfigError);
  assert.throws(() => parseMetadataConfig("chain: [\"bogus-site/x/api_key\"]"), MetadataConfigError);
  assert.throws(() => parseMetadataConfig("fill_missing_only: yes_please"), MetadataConfigError);
  assert.throws(() => parseMetadataConfig("models:\n  - match: a\n    chain: \"notalist\""), MetadataConfigError);
});

test("parseMetadataConfig: unknown fields ignored with warning paths", () => {
  const parsed = parseMetadataConfig("static_models: true\nmodels:\n  - match: a\n    odd_field: 2\n");
  assert.deepEqual(parsed.warnings.sort(), ["models[0].odd_field", "static_models"]);
});

// --- legacy fields (task 2.2) ------------------------------------------------

for (const [field, yaml] of [
  ["source_priority", "source_priority: [\"*/api_key\"]"],
  ["provider_prefix_map", "provider_prefix_map:\n  anthropic: [anthropic]"],
  ["lookup_ids", "models:\n  - match: a\n    lookup_ids: {x: y}"], // mapping-form models also legacy
  ["models_dev_subscription", "models_dev_subscription:\n  add: [x]"],
  ["channels", "channels:\n  chan:\n    source_priority: []"],
  ["global_fallback", "global_fallback: true"],
]) {
  test(`parseMetadataConfig: legacy field ${field} errors with migration hint`, () => {
    assert.throws(() => parseMetadataConfig(yaml), (e: unknown) => {
      assert.ok(e instanceof MetadataConfigError);
      assert.match((e as Error).message, /removed field|mapping form/i);
      return true;
    });
  });
}

test("parseMetadataConfig: mapping-form models is a legacy config error", () => {
  assert.throws(
    () => parseMetadataConfig("models:\n  \"*gpt*\":\n    fill_missing_only: true"),
    (e: unknown) => e instanceof MetadataConfigError && /match/.test((e as Error).message),
  );
});

// --- chain entry parsing (task 2.3) -----------------------------------------

test("parseChainEntry: full and implicit-@id forms", () => {
  const full = parseChainEntry("models.dev/anthropic/api_key/claude-sonnet-4-5", "chain[0]");
  assert.deepEqual([full.site, full.provider, full.access, full.model],
    ["models.dev", "anthropic", "api_key", "claude-sonnet-4-5"]);
  const implicit = parseChainEntry("modelparams.dev/z-ai/subscription", "chain[0]");
  assert.equal(implicit.model, "@id");
  assert.equal(implicit.access, "subscription");
});

test("parseChainEntry: literal model segment may contain slashes", () => {
  const entry = parseChainEntry("models.dev/llmgateway-providers/api_key/anthropic/claude-fable-5-1", "c");
  assert.equal(entry.model, "anthropic/claude-fable-5-1");
});

test("parseChainEntry: rejects wildcards and bad site/access", () => {
  for (const bad of [
    "*/api_key",
    "models.dev/*/api_key",
    "models.dev/anthropic/api_key/*",
    "models.dev/anthropic/*",
    "models.dev/anthropic/oauth",
    "ftp.dev/anthropic/api_key",
    "models.dev//api_key",
  ]) {
    assert.throws(() => parseChainEntry(bad, "chain"), MetadataConfigError, bad);
  }
});

test("parseMetadataConfig: overrides forbidden fields rejected", () => {
  for (const key of ["id", "provider", "api", "baseUrl"]) {
    assert.throws(
      () => parseMetadataConfig(`models:\n  - match: m\n    overrides:\n      ${key}: x`),
      MetadataConfigError,
      key,
    );
  }
});

test("matchModelPattern: * crosses '/', anchored, case-sensitive", () => {
  assert.ok(matchModelPattern("*gpt-6-astra", "proxy/openai/gpt-6-astra"));
  assert.ok(matchModelPattern("*gpt-6-astra", "gpt-6-astra"));
  assert.ok(!matchModelPattern("*gpt-6-astra", "gpt-6-astra-preview"));
  assert.ok(!matchModelPattern("*GPT", "openai/gpt"));
});

// --- @id candidates (task 3.2) ----------------------------------------------

test("idCandidates: fixed order, deduped", () => {
  assert.deepEqual(idCandidates("proxy/claude-sonnet-4.5"), [
    "claude-sonnet-4.5",
    "claude-sonnet-4-5",
  ]);
  assert.deepEqual(idCandidates("Model-X"), ["Model-X", "model-x"]);
  assert.deepEqual(idCandidates("claude-3-5-haiku-20241022"), [
    "claude-3-5-haiku-20241022",
    "claude-3.5-haiku-20241022",
    "claude-3-5-haiku",
  ]);
});

// --- compiler (task 3.x) ----------------------------------------------------

const FIXTURE_TABLES_MIN = tables();

const FABLE_TABLES = tables({
  modelsDev: {
    providers: {
      anthropic: {
        models: {
          "claude-fable-5-1": {
            canonical_model_id: "anthropic/claude-fable-5-1",
            limit: { context: 1000000, output: 128000 },
          },
        },
      },
      "llmgateway-providers": {
        models: {
          "anthropic/claude-fable-5-1": { canonical_model_id: "anthropic/claude-fable-5-1", limit: { context: 1, output: 1 } },
          "aws-bedrock/claude-fable-5-1": { canonical_model_id: "anthropic/claude-fable-5-1", limit: { context: 2, output: 2 } },
          "azure-anthropic/claude-fable-5-1": { canonical_model_id: "anthropic/claude-fable-5-1", limit: { context: 3, output: 3 } },
        },
      },
    },
  },
});

test("compileCatalog: claude-fable-5-1 aggregator variants resolve to anthropic", () => {
  const compiled = compileCatalog(cfg(), ["gw/claude-fable-5-1"], FABLE_TABLES);
  const model = compiled.models[0];
  assert.deepEqual(
    model.entries.map((e) => e.entry),
    ["models.dev/anthropic/api_key/claude-fable-5-1"],
  );
  assert.equal(model.entries[0].fields.context_window, 1000000);
  assert.equal(model.entries[0].fields.max_output_tokens, 128000);
  // modelparams has no anthropic record for this id -> entry unresolved, not an error
  assert.deepEqual(model.unresolved, ["modelparams.dev/@creator/api_key/@id"]);
});

test("compileCatalog: default chain order and structure", () => {
  assert.deepEqual([...DEFAULT_CHAIN], ["models.dev/@creator/api_key", "modelparams.dev/@creator/api_key"]);
});

test("compileCatalog: alias group expands per-site to existing members", () => {
  const t = tables({
    modelsDev: {
      providers: {
        zhipuai: { models: { "glm-5.1": { canonical_model_id: "zhipuai/glm-5.1", limit: { context: 100 } } } },
        zai: { models: { "glm-5.1": { canonical_model_id: "zhipuai/glm-5.1", limit: { context: 200 } } } },
        "zai-coding-plan": { models: { "glm-5.1": { limit: { context: 999 } } } },
      },
    },
    modelparams: {
      catalog: [
        { provider: "z-ai", authType: "api_key", model: "glm-5.1", params: [{ path: "context_window", range: { max: 128000 } }] },
      ],
    },
  });
  const compiled = compileCatalog(cfg(), ["glm-5.1"], t);
  const model = compiled.models[0];
  assert.deepEqual(model.entries.map((e) => e.entry), [
    "models.dev/zhipuai/api_key/glm-5.1",
    "models.dev/zai/api_key/glm-5.1",
    "modelparams.dev/z-ai/api_key/glm-5.1",
  ]);
  // zai-coding-plan is a reseller/subscription product, not an alias — excluded.
  assert.ok(!model.entries.some((e) => e.provider === "zai-coding-plan"));
});

test("compileCatalog: same alias-group creators do not conflict", () => {
  const t = tables({
    modelsDev: {
      providers: {
        zhipuai: { models: { "glm-5.1": { canonical_model_id: "zhipuai/glm-5.1" } } },
        zai: { models: { "glm-5.1": { canonical_model_id: "zai/glm-5.1" } } },
      },
    },
  });
  const compiled = compileCatalog(cfg(), ["glm-5.1"], t);
  assert.equal(compiled.models[0].entries.length > 0, true);
});

test("compileCatalog: unknown creator marks entry unresolved, still publishes", () => {
  const compiled = compileCatalog(cfg(), ["mystery-model"], FIXTURE_TABLES_MIN); // no canonical records

  assert.deepEqual(compiled.models[0].entries, []);
  assert.equal(compiled.models[0].unresolved.length, 2); // both default-chain entries unresolved
});

test("compileCatalog: conflicting creators on @creator chain is a config error", () => {
  const t = tables({
    modelsDev: {
      providers: {
        a: { models: { "shared-m": { canonical_model_id: "vendor-a/shared-m" } } },
        b: { models: { "shared-m": { canonical_model_id: "vendor-b/shared-m" } } },
      },
    },
  });
  assert.throws(() => compileCatalog(cfg(), ["shared-m"], t), MetadataConfigError);
});

test("compileCatalog: explicit provider avoids @creator conflict", () => {
  const t = tables({
    modelsDev: {
      providers: {
        a: { models: { "shared-m": { canonical_model_id: "vendor-a/shared-m", limit: { context: 1 } } } },
        b: { models: { "shared-m": { canonical_model_id: "vendor-b/shared-m" } } },
      },
    },
  });
  const config = cfg({ models: [{ match: "shared-m", chain: ["models.dev/a/api_key"] }] });
  const compiled = compileCatalog(config, ["shared-m"], t);
  assert.deepEqual(compiled.models[0].entries.map((e) => e.entry), ["models.dev/a/api_key/shared-m"]);
});

test("compileCatalog: @default expands root chain in place", () => {
  const config = cfg({
    chain: ["models.dev/openai/api_key"],
    models: [{ match: "m", chain: ["models.dev/zai-coding-plan/subscription", "@default"] }],
  });
  const t = tables({
    modelsDev: {
      providers: {
        "zai-coding-plan": { models: { m: { limit: { context: 5 } } } },
        openai: { models: { m: { limit: { context: 6 } } } },
      },
    },
  });
  const compiled = compileCatalog(config, ["m"], t);
  assert.deepEqual(compiled.models[0].entries.map((e) => e.entry), [
    "models.dev/zai-coding-plan/subscription/m",
    "models.dev/openai/api_key/m",
  ]);
});

test("compileCatalog: rule layering — later rules override per field, overrides merge", () => {
  const config = cfg({
    models: [
      { match: "*", fillMissingOnly: false, overrides: { contextWindow: 200000, compat: { a: 1 } } },
      { match: "proxy/*", fillMissingOnly: true, overrides: { compat: { b: 2 } } },
      { match: "proxy/claude", chain: [] },
    ],
  });
  const compiled = compileCatalog(config, ["proxy/claude", "other/claude"], tables());
  const proxy = compiled.models[0];
  const other = compiled.models[1];
  assert.equal(proxy.fillMissingOnly, true); // proxy/* rule wins over * rule
  assert.equal(other.fillMissingOnly, false);
  assert.deepEqual(proxy.overridePatches, [{ contextWindow: 200000, compat: { a: 1 } }, { compat: { b: 2 } }]);
  assert.deepEqual(proxy.matchedRules, [1, 2, 3]);
  assert.deepEqual(proxy.entries, []); // later exact rule set chain: []
});

test("compileCatalog: exact match pattern gets no extra priority (declaration order wins)", () => {
  const config = cfg({
    models: [
      { match: "proxy/claude", fillMissingOnly: true },
      { match: "*", fillMissingOnly: false },
    ],
  });
  const compiled = compileCatalog(config, ["proxy/claude"], tables());
  assert.equal(compiled.models[0].fillMissingOnly, false);
});

test("compileCatalog: modelparams entries filtered by authType access", () => {
  const t = tables({
    modelparams: {
      catalog: [
        { provider: "z-ai", authType: "api_key", model: "m", params: [{ path: "context_window", range: { max: 1 } }] },
        { provider: "z-ai", authType: "subscription", model: "m", params: [{ path: "context_window", range: { max: 2 } }] },
      ],
    },
  });
  const config = cfg({ chain: ["modelparams.dev/z-ai/subscription"] });
  const compiled = compileCatalog(config, ["m"], t);
  assert.equal(compiled.models[0].entries.length, 1);
  assert.equal(compiled.models[0].entries[0].access, "subscription");
  assert.equal(compiled.models[0].entries[0].fields.context_window, 2);
});

test("compileCatalog: dot-notation public id hits dash-notation record", () => {
  const t = tables({
    modelsDev: {
      providers: {
        anthropic: { models: { "claude-sonnet-4-5": { canonical_model_id: "anthropic/claude-sonnet-4-5", limit: { context: 9 } } } },
      },
    },
  });
  const compiled = compileCatalog(cfg(), ["proxy/claude-sonnet-4.5"], t);
  assert.equal(compiled.models[0].entries[0]?.modelId, "claude-sonnet-4-5");
});

test("compileCatalog: as-is candidate wins over case-folded", () => {
  const t = tables({
    modelsDev: {
      providers: {
        p: { models: { "Model-X": { limit: { context: 1 } }, "model-x": { limit: { context: 2 } } } },
      },
    },
  });
  const config = cfg({ chain: ["models.dev/p/api_key"] });
  const compiled = compileCatalog(config, ["Model-X"], t);
  assert.equal(compiled.models[0].entries[0]?.fields.context_window, 1);
});

test("compileCatalog: literal 4th segment sets query id, public id unchanged", () => {
  const config = cfg({ models: [{ match: "claude", chain: ["models.dev/anthropic/api_key/claude-sonnet-4-5"] }] });
  const t = tables({
    modelsDev: { providers: { anthropic: { models: { "claude-sonnet-4-5": { limit: { context: 7 } } } } } },
  });
  const compiled = compileCatalog(config, ["claude"], t);
  assert.deepEqual(compiled.models[0].entries.map((e) => e.entry), ["models.dev/anthropic/api_key/claude-sonnet-4-5"]);
  assert.equal(compiled.models[0].publicId, "claude");
});

test("compileCatalog: deterministic — same inputs give deep-equal results", () => {
  const a = compileCatalog(cfg(), ["gw/claude-fable-5-1"], FABLE_TABLES);
  const b = compileCatalog(cfg(), ["gw/claude-fable-5-1"], FABLE_TABLES);
  assert.deepEqual(a, b);
});

test("compileCatalog: records data versions and generatedAt", () => {
  const t = tables({ modelsDevVersion: "0.0.113", modelsDevGeneratedAt: "2026-10-23", modelparamsVersion: "0.0.72" });
  const compiled = compileCatalog(cfg(), ["m"], t);
  assert.equal(compiled.dataVersions.modelsDevVersion, "0.0.113");
  assert.equal(compiled.dataVersions.modelsDevGeneratedAt, "2026-10-23");
  assert.equal(compiled.dataVersions.modelparamsVersion, "0.0.72");
});

// --- execution: merge + fields ----------------------------------------------

test("mergeMetadata: external overwrites upstream by default", () => {
  const merged = mergeMetadata({ context_window: 500000 }, { context_window: 1000000 }, false);
  assert.equal(merged.context_window, 1000000);
});

test("mergeMetadata: fill_missing_only keeps upstream, fills gaps", () => {
  const merged = mergeMetadata(
    { context_window: 128000 },
    { context_window: 1000000, max_output_tokens: 128000 },
    true,
  );
  assert.equal(merged.context_window, 128000);
  assert.equal(merged.max_output_tokens, 128000);
});

test("mergeMetadata: alias does not bypass fill-only protection", () => {
  const merged = mergeMetadata(
    { context_length: 128000 },
    { context_window: 1000000 },
    true,
  );
  assert.equal(merged.context_window, 128000);
});

test("mergeMetadata: explicit empty effort array is not missing", () => {
  const merged = mergeMetadata(
    { supported_reasoning_levels: [] },
    { supported_reasoning_levels: ["low", "high"] },
    true,
  );
  assert.deepEqual(merged.supported_reasoning_levels, []);
});

test("mergeMetadata: defaults do not mask real missing values", () => {
  const merged = mergeMetadata({}, { context_window: 64000 }, true);
  assert.equal(merged.context_window, 64000);
});

test("externalFields: first valid value wins across the chain", () => {
  const model = {
    publicId: "m", matchedRules: [], fillMissingOnly: false, overridePatches: [], unresolved: [],
    entries: [
      { entry: "e1", site: "models.dev" as const, provider: "a", access: "api_key" as const, modelId: "m", fields: { context_window: 1 } },
      { entry: "e2", site: "modelparams.dev" as const, provider: "b", access: "api_key" as const, modelId: "m", fields: { context_window: 2, supported_reasoning_levels: ["low"] } },
    ],
  };
  const fields = externalFields(model);
  assert.equal(fields.context_window, 1);
  assert.deepEqual(fields.supported_reasoning_levels, ["low"]);
});

// --- RFC 7396 merge patch (task 2.4 / 3.1 / 4.2) -----------------------------

test("mergePatch: nested objects recurse, null deletes, scalars/arrays replace", () => {
  const model = { contextWindow: 1, thinkingLevelMap: { high: "high", xhigh: "xhigh" }, input: ["text"] } as Record<string, unknown>;
  mergePatch(model, { thinkingLevelMap: { xhigh: null, max: "xhigh" }, input: ["text", "image"] });
  assert.deepEqual(model.thinkingLevelMap, { high: "high", max: "xhigh" });
  assert.deepEqual(model.input, ["text", "image"]);
});

test("mergePatch: layered overrides from multiple rules merge in order", () => {
  const target: Record<string, unknown> = {};
  mergePatch(target, { contextWindow: 200000, compat: { a: 1 } });
  mergePatch(target, { compat: { b: 2 } });
  assert.deepEqual(target, { contextWindow: 200000, compat: { a: 1, b: 2 } });
});

// --- review fixes -----------------------------------------------------------

test("mergePatch: __proto__/constructor/prototype cannot pollute Object.prototype", () => {
  const before = ({} as Record<string, unknown>).REVIEW_PROTOTYPE_MARKER;
  const target: Record<string, unknown> = {};
  mergePatch(target, { "__proto__": { REVIEW_PROTOTYPE_MARKER: true } } as Record<string, unknown>);
  mergePatch(target, { constructor: { polluted: true }, prototype: { polluted: true } });
  assert.equal(({} as Record<string, unknown>).REVIEW_PROTOTYPE_MARKER, before);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.equal(Object.hasOwn(target, "__proto__"), false);
});

test("parseMetadataConfig: every legacy field errors inside model rules too", () => {
  for (const field of [
    "source_priority",
    "provider_prefix_map",
    "lookup_ids",
    "models_dev_subscription",
    "channels",
    "global_fallback",
  ]) {
    assert.throws(
      () => parseMetadataConfig(`models:\n  - match: m\n    ${field}: x`),
      (error: unknown) =>
        error instanceof MetadataConfigError &&
        (error as MetadataConfigError).path.includes(field) &&
        /use `chain`|literal|delete it|@default/.test((error as Error).message),
      `${field} inside a rule must be a config error, not a warning`,
    );
  }
});

test("compileCatalog → mapCompiledCatalog: ordered patches keep null deletes and resets on the Pi model", async () => {
  const { mapCompiledCatalog } = await import("../index.ts");
  const config = parseMetadataConfig(`models:
  - match: m
    overrides:
      thinkingLevelMap:
        xhigh: null
        max: xhigh
      compat: null
  - match: m
    overrides:
      compat: { b: 2 }
`);
  const compiled = compileCatalog(config, ["m"], tables());
  // supported_reasoning_levels gives mapModel a thinkingLevelMap containing
  // an xhigh key the first patch must delete (ordered null keeps meaning).
  const out = mapCompiledCatalog(
    [{ id: "m", context_window: 64000, max_tokens: 8192, type: "chat", supported_reasoning_levels: ["high", "xhigh"] }],
    "http://127.0.0.1:1/v1",
    compiled,
  );
  const model = out.models[0] as unknown as Record<string, unknown>;
  const tlm = model.thinkingLevelMap as Record<string, unknown>;
  assert.equal(Object.hasOwn(tlm, "xhigh"), false, "xhigh must be deleted, not merely null");
  assert.equal(tlm.max, "xhigh");
  assert.equal(tlm.high, "high");
  assert.deepEqual(model.compat, { b: 2 }, "second patch recreates compat after first patch's null");
});
