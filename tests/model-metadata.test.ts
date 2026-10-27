import assert from "node:assert/strict";
import { test } from "node:test";
import {
  compileCatalog as compileCatalogWithMatches,
  DEFAULT_CHAIN,
  externalFields,
  idCandidates,
  mergePatch,
  MetadataConfigError,
  normalizeFields,
  parseChainEntry,
  resolveChainFields,
  type CompiledModel,
  type SourceTables,
} from "../model-metadata.ts";
import { parseMetadataConfig } from "../metadata-config.ts";
import { matchRules, modelGlobMatches } from "../metadata-glob.ts";

const cfg = (overrides: Record<string, unknown> = {}) => ({ warnings: [], ...overrides });
// Rule matching is host-side; tests compute it the way the host does.
const compileCatalog = (config: Parameters<typeof compileCatalogWithMatches>[0], ids: readonly string[], t: SourceTables) =>
  compileCatalogWithMatches(config, ids, t, matchRules(config, ids));
const globMatches = modelGlobMatches;
// `@self` provider over one fixed upstream row.
const selfRow = (row: Record<string, unknown>) => ({ "@self": () => row });

const tables = (overrides: Partial<SourceTables> = {}): SourceTables => ({
  modelsDev: { providers: {} },
  modelparams: { catalog: [] },
  degraded: [],
  ...overrides,
});

// --- compiler selection/evidence isolation ---------------------------------

test("probe: aliases without canonical metadata share one physical record", () => {
  const config = parseMetadataConfig('chain: ["models.dev/a/api_key"]');
  const source = tables({ modelsDev: { providers: { a: { models: {
    "foo-bar": { id: "foo_bar", limit: { context: 100 } },
  } } } } });
  const model = compileCatalog(config, ["Foo Bar"], source).models[0];
  assert.equal(model.entries.length, 1);
  assert.equal(externalFields(model).context_window, 100);
  assert.deepEqual(model.unresolved, []);
  assert.deepEqual(model.candidates.map((hit) => hit.sourceId).sort(), ["foo-bar", "foo_bar"]);
  assert.equal(model.candidates.filter((hit) => hit.selected).length, 1, "one physical record supplies fields once");

  const distinct = compileCatalog(config, ["Foo Bar"], tables({ modelsDev: { providers: { a: { models: {
    "foo-bar": { limit: { context: 100 } },
    foo_bar: { limit: { context: 900 } },
  } } } } })).models[0];
  assert.equal(distinct.entries.length, 0, "distinct records must not be mistaken for key/id aliases");
});

test("probe: literal export evidence cannot contaminate subsequent model queries", () => {
  const config = parseMetadataConfig('chain: ["models.dev/a/api_key/other", "models.dev/a/api_key"]');
  const source = tables({ modelsDev: { providers: { a: { models: {
    other: { canonical_model_id: "a/other", limit: { context: 100 } },
    m: { canonical_model_id: "a/m", limit: { output: 200 } },
  } } } } });
  for (const model of compileCatalog(config, ["m", "channel/m"], source).models) {
    assert.equal(model.entries.length, 2);
    assert.equal(externalFields(model).context_window, 100);
    assert.equal(externalFields(model).max_output_tokens, 200);
    assert.deepEqual(model.unresolved, []);
    assert.ok(model.candidates.some((hit) => hit.sourceId === "other" && hit.selected));
    assert.ok(model.candidates.some((hit) => hit.sourceId === "m" && hit.selected));
  }
});

// --- config parsing ---------------------------------------------------------

test("parseMetadataConfig: missing file yields empty config", () => {
  const parsed = parseMetadataConfig(undefined);
  assert.deepEqual(parsed.warnings, []);
  assert.equal(parsed.chain, undefined);
});

test("parseMetadataConfig: valid config with chain, @self and ordered rules", () => {
  const parsed = parseMetadataConfig(`
chain: ["models.dev/@creator/api_key", "@self"]
models:
  - match: "proxy/*"
    chain: ["@self", "@default"]
    overrides:
      contextWindow: 200000
  - match: "proxy/claude"
    chain: ["models.dev/anthropic/api_key/claude-sonnet-4-5"]
`);
  assert.deepEqual(parsed.chain, ["models.dev/@creator/api_key", "@self"]);
  assert.equal(parsed.models?.length, 2);
  assert.equal(parsed.models?.[1].match, "proxy/claude");
  assert.deepEqual(parsed.models?.[0].chain, ["@self", "@default"]);
  assert.deepEqual(parsed.models?.[0].overrides, { contextWindow: 200000 });
});

test("parseMetadataConfig: explicit empty chain is a config error at root and rule level", () => {
  for (const yaml of ["chain: []", "models:\n  - match: m\n    chain: []"]) {
    assert.throws(() => parseMetadataConfig(yaml), (e: unknown) => {
      assert.ok(e instanceof MetadataConfigError);
      assert.match((e as MetadataConfigError).path, /chain/);
      assert.match((e as Error).message, /@self/);
      return true;
    }, yaml);
  }
});

test("parseMetadataConfig: @default is rejected in the root chain", () => {
  assert.throws(
    () => parseMetadataConfig('chain: ["@default"]'),
    (e: unknown) => e instanceof MetadataConfigError && /@default/.test((e as Error).message),
  );
});

test("parseMetadataConfig: invalid YAML, bad chain, non-list chain are config errors", () => {
  assert.throws(() => parseMetadataConfig("a: ["), MetadataConfigError);
  assert.throws(() => parseMetadataConfig("chain: [\"bogus-site/x/api_key\"]"), MetadataConfigError);
  assert.throws(() => parseMetadataConfig('chain: ["@selfish"]'), MetadataConfigError);
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
  // fill_missing_only is legacy even when combined with @self in the chain.
  ["fill_missing_only", "fill_missing_only: false"],
  ["fill_missing_only", 'chain: ["@self", "models.dev/@creator/api_key"]\nfill_missing_only: true'],
  ["fill_missing_only", "models:\n  - match: m\n    fill_missing_only: true"],
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

test("model glob: single star stays inside one segment", () => {
  assert.ok(globMatches("*gpt-6-astra", "gpt-6-astra"));
  assert.ok(!globMatches("*gpt-6-astra", "openai/gpt-6-astra"));
  assert.ok(!globMatches("*gpt-6-astra", "proxy/openai/gpt-6-astra"));
  assert.ok(!globMatches("*gpt-6-astra", "gpt-6-astra-preview"));
});

test("model glob: suffix glob with ** covers bare and multi-level prefixes", () => {
  for (const id of ["gpt-6-astra", "openai/gpt-6-astra", "proxy/openai/gpt-6-astra"]) {
    assert.ok(globMatches("**/gpt-6-astra", id), id);
  }
  assert.ok(!globMatches("**/gpt-6-astra", "gpt-6-astra-preview"));
});

test("model glob: one-segment prefix vs ** prefix", () => {
  assert.ok(!globMatches("proxy/*", "proxy/a/b"));
  assert.ok(globMatches("proxy/**", "proxy/a/b"));
  assert.ok(globMatches("proxy/*", "proxy/a"));
});

test("model glob: case-sensitive; leading ! and # are literal; dot, ?, classes, braces", () => {
  assert.ok(!globMatches("p*", "Proxy"));
  assert.ok(!globMatches("*GPT", "gpt"));
  assert.ok(globMatches("!x", "!x"));
  assert.ok(!globMatches("!x", "y"));
  assert.ok(globMatches("#x", "#x"));
  assert.ok(globMatches("**/.hidden", "x/.hidden"));
  assert.ok(globMatches("*", ".dot"));
  assert.ok(globMatches("gpt-?", "gpt-5"));
  assert.ok(!globMatches("gpt-?", "gpt-55"));
  assert.ok(globMatches("gpt-[45]", "gpt-4"));
  assert.ok(globMatches("{a,b}/*", "b/m"));
  assert.ok(!globMatches("{a,b}/*", "c/m"));
});

test("model glob: one-segment wildcard does not match bare ids", () => {
  assert.ok(!globMatches("*/**", "bare"));
  assert.ok(globMatches("*/**", "a/b"));
  assert.ok(globMatches("*/**", "a/b/c"));
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

/**
 * Fixed dual-site fixture (no gateway URLs, no credentials) covering the
 * query-expansion matrix: separator/case aliases, namespaced source ids,
 * canonical renames, unified-only models, same-creator multi-model
 * ambiguity, same-level field conflicts and provider-vs-unified limits.
 * Expected public ids, display names and candidate lists are explicit —
 * nothing depends on the live packages.
 */
const EXPANSION_TABLES = tables({
  modelsDev: {
    providers: {
      anthropic: {
        models: {
          "claude-fable-5-1": {
            id: "claude-fable-5-1",
            canonical_model_id: "anthropic/claude-fable-5-1",
            limit: { context: 1000000, output: 128000 },
          },
          "claude_fable_5.1": {
            id: "claude_fable_5.1",
            canonical_model_id: "anthropic/claude-fable-5-1",
            limit: { context: 1000000, output: 128000 },
          },
        },
      },
      "llmgateway-providers": {
        models: {
          "anthropic/claude-fable-5-1": { canonical_model_id: "anthropic/claude-fable-5-1", limit: { context: 1, output: 1 } },
          "aws-bedrock/claude-fable-5-1": { canonical_model_id: "anthropic/claude-fable-5-1", limit: { context: 2, output: 2 } },
        },
      },
      deepseek: {
        models: {
          "deepseek-v4-flash": {
            canonical_model_id: "deepseek/deepseek-v4-flash",
            limit: { context: 131072, output: 32768 },
          },
        },
      },
      agg: {
        models: {
          // Renamed listing: source id differs from the canonical model.
          "deepseek-v4-flash-fast": {
            canonical_model_id: "deepseek/deepseek-v4-flash",
            limit: { context: 5, output: 5 },
          },
        },
      },
      openai: {
        models: {
          // Provider table lacks gpt-5-codex entirely (unified table only).
          "gpt-5": { canonical_model_id: "openai/gpt-5", limit: { context: 400000, output: 128000 } },
        },
      },
      strictai: {
        models: {
          "cap-m": {
            canonical_model_id: "strictai/cap-m",
            limit: { context: 200000 },
          },
        },
      },
      google: {
        models: {
          "gemini-3-1-pro": { canonical_model_id: "google/gemini-3-1-pro-preview", limit: { context: 10, output: 10 } },
        },
      },
      vertex: {
        models: {
          "gemini-3-1-pro": { canonical_model_id: "google/gemini-3-1-pro-customtools", limit: { context: 20, output: 20 } },
        },
      },
      acme: {
        models: {
          "conflict-x": { canonical_model_id: "acme/conflict-x", limit: { context: 100, output: 10 } },
          "conflict_x": { canonical_model_id: "acme/conflict-x", limit: { context: 200, output: 20 } },
        },
      },
      caselab: {
        models: {
          "Model-X": { limit: { context: 1 } },
          "model-x": { limit: { context: 2 } },
        },
      },
      metachar: {
        models: {
          "a+b(c)": { limit: { context: 7 } },
          "axbxc": { limit: { context: 8 } },
        },
      },
      "vendor-a": { models: { "shared-m": { canonical_model_id: "vendor-a/shared-m", limit: { context: 11 } } } },
      "vendor-b": { models: { "shared-m": { canonical_model_id: "vendor-b/shared-m", limit: { context: 12 } } } },
      subp: {
        models: {
          "lim-m": { canonical_model_id: "subp/lim-m", limit: { context: 50 } },
        },
      },
    },
    models: {
      "anthropic/claude-fable-5-1": { name: "Claude Fable 5.1", limit: { context: 1000000, output: 128000 } },
      "deepseek/deepseek-v4-flash": { name: "DeepSeek V4 Flash", limit: { context: 131072, output: 32768 } },
      "openai/gpt-5-codex": { name: "GPT-5 Codex", limit: { context: 400000, input: 272000, output: 128000 } },
      "strictai/cap-m": { name: "Cap M", limit: { context: 1000000, output: 64000 } },
      "subp/lim-m": { name: "Lim M", limit: { context: 999 } },
    },
  },
  modelparams: {
    catalog: [
      { provider: "deepseek", authType: "api_key", model: "deepseek-v4-flash", params: [{ path: "context_window", range: { max: 64000 } }] },
      { provider: "acme", authType: "api_key", model: "conflict-x", params: [{ path: "context_window", range: { max: 500 } }] },
    ],
  },
});

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
  assert.deepEqual([...DEFAULT_CHAIN], ["models.dev/@creator/api_key", "modelparams.dev/@creator/api_key", "@self"]);
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
      { match: "**", chain: ["models.dev/a/api_key"], overrides: { contextWindow: 200000, compat: { a: 1 } } },
      { match: "proxy/*", chain: ["models.dev/b/api_key"], overrides: { compat: { b: 2 } } },
      { match: "proxy/claude", chain: ["@self"] },
    ],
  });
  const compiled = compileCatalog(config, ["proxy/claude", "other/claude"], tables());
  const proxy = compiled.models[0];
  const other = compiled.models[1];
  // proxy/* chain (models.dev/b) wins over ** (models.dev/a); the exact rule
  // then replaces the whole chain with the upstream-only @self chain.
  assert.deepEqual(proxy.plan, [{ kind: "record", keyword: "@self", modelId: "proxy/claude" }]);
  assert.equal(proxy.externalChain, false, "upstream-only chain is not an external chain");
  assert.deepEqual(other.plan.map((n) => (n.kind === "external" ? n.entry.entry : n.kind)), []);
  assert.equal(other.externalChain, true, "models.dev/a is declared for other/claude");
  assert.deepEqual(other.unresolved, ["models.dev/a/api_key/@id"]);
  assert.deepEqual(proxy.overridePatches, [{ contextWindow: 200000, compat: { a: 1 } }, { compat: { b: 2 } }]);
  assert.deepEqual(proxy.matchedRules, [1, 2, 3]);
});

test("compileCatalog: exact match pattern gets no extra priority (declaration order wins)", () => {
  const config = cfg({
    models: [
      { match: "proxy/claude", chain: ["@self"] },
      { match: "**", chain: ["models.dev/a/api_key"] },
    ],
  });
  const compiled = compileCatalog(config, ["proxy/claude"], tables());
  // The later, broader rule replaces the chain — @self is gone; the declared
  // external entry is unresolved against empty tables.
  assert.deepEqual(compiled.models[0].plan, []);
  assert.deepEqual(compiled.models[0].unresolved, ["models.dev/a/api_key/@id"]);
  assert.equal(compiled.models[0].externalChain, true);
});

test("compileCatalog: @self compiles to a concrete upstream node per model, never shared", () => {
  const t = tables({
    modelsDev: {
      providers: {
        a: { models: { m1: { limit: { context: 11 } }, m2: { limit: { context: 22 } } } },
      },
    },
  });
  const config = cfg({ chain: ["@self", "models.dev/a/api_key"] });
  const compiled = compileCatalog(config, ["m1", "ns/m2"], t);
  for (const model of compiled.models) {
    // First node is THIS model's own upstream source; no keyword remains.
    assert.deepEqual(model.plan[0], { kind: "record", keyword: "@self", modelId: model.publicId }, JSON.stringify(model.plan));
    assert.equal(model.plan[1]?.kind, "external");
  }
  const m1 = compiled.models[0];
  const m2 = compiled.models[1];
  assert.equal((m1.plan[1] as { entry: { entry: string } }).entry.entry, "models.dev/a/api_key/m1");
  assert.equal((m2.plan[1] as { entry: { entry: string } }).entry.entry, "models.dev/a/api_key/m2");
  assert.equal(m1.externalChain, true);
  const onlyUpstream = compileCatalog(cfg({ chain: ["@self"] }), ["m"], tables()).models[0];
  assert.deepEqual(onlyUpstream.plan, [{ kind: "record", keyword: "@self", modelId: "m" }]);
  assert.equal(onlyUpstream.externalChain, false);
  assert.deepEqual(onlyUpstream.entries, []);
  assert.deepEqual(onlyUpstream.unresolved, []);
  assert.deepEqual(onlyUpstream.candidates, []);
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

// Plan-based first-valid resolution replaces the old mergeMetadata boolean.
// Helper: one compiled model whose plan is the given ordered nodes.
const planModel = (plan: CompiledModel["plan"]): CompiledModel => ({
  publicId: "m",
  matchedRules: [],
  plan,
  entries: plan.flatMap((node) => (node.kind === "external" ? [node.entry] : [])),
  unresolved: [],
  candidates: [],
  externalChain: plan.some((node) => node.kind === "external"),
  overridePatches: [],
});
const extNode = (fields: Record<string, unknown>): CompiledModel["plan"][number] => ({
  kind: "external",
  entry: {
    entry: "models.dev/a/api_key/m",
    site: "models.dev" as const,
    provider: "a",
    access: "api_key" as const,
    modelId: "m",
    fields,
  },
});
const selfNode = { kind: "record" as const, keyword: "@self", modelId: "m" };

test("resolveChainFields: external before @self overrides upstream, fills gaps", () => {
  const model = planModel([extNode({ context_window: 1000000 }), selfNode]);
  const fields = resolveChainFields(model, selfRow({ context_window: 500000, max_output_tokens: 64000 }));
  assert.equal(fields.context_window, 1000000);
  assert.equal(fields.max_output_tokens, 64000);
});

test("resolveChainFields: @self first keeps upstream, external fills gaps", () => {
  const model = planModel([selfNode, extNode({ context_window: 1000000, max_output_tokens: 128000 })]);
  const fields = resolveChainFields(model, selfRow({ context_window: 128000 }));
  assert.equal(fields.context_window, 128000);
  assert.equal(fields.max_output_tokens, 128000);
});

test("resolveChainFields: upstream alias cannot bypass an earlier @self", () => {
  const model = planModel([selfNode, extNode({ context_window: 1000000 })]);
  const fields = resolveChainFields(model, selfRow({ context_length: 128000 }));
  assert.equal(fields.context_window, 128000);
});

test("resolveChainFields: explicit empty upstream effort array is not missing", () => {
  const model = planModel([selfNode, extNode({ supported_reasoning_levels: ["low", "high"] })]);
  const fields = resolveChainFields(model, selfRow({ supported_reasoning_levels: [] }));
  assert.deepEqual(fields.supported_reasoning_levels, []);
});

test("resolveChainFields: missing upstream fields fall through to later sources", () => {
  const model = planModel([selfNode, extNode({ context_window: 64000 })]);
  const fields = resolveChainFields(model, selfRow({}));
  assert.equal(fields.context_window, 64000);
});

test("resolveChainFields: no @self means upstream fields are never read", () => {
  const model = planModel([extNode({ context_window: 1000000 })]);
  const fields = resolveChainFields(model, selfRow({
    context_window: 500000,
    max_output_tokens: 64000,
    capabilities: { effort_tiers: ["low", "high"] },
  }));
  assert.equal(fields.context_window, 1000000);
  assert.equal(fields.max_output_tokens, undefined);
  assert.equal(fields.supported_reasoning_levels, undefined);
});

test("resolveChainFields: repeated @self nodes are idempotent (first valid wins)", () => {
  const model = planModel([selfNode, selfNode, extNode({ max_output_tokens: 10 })]);
  const fields = resolveChainFields(model, selfRow({ context_window: 32000 }));
  assert.equal(fields.context_window, 32000);
  assert.equal(fields.max_output_tokens, 10);
});

test("externalFields: first valid value wins across external entries only", () => {
  const e1 = { entry: "e1", site: "models.dev" as const, provider: "a", access: "api_key" as const, modelId: "m", fields: { context_window: 1 } };
  const e2 = { entry: "e2", site: "modelparams.dev" as const, provider: "b", access: "api_key" as const, modelId: "m", fields: { context_window: 2, supported_reasoning_levels: ["low"] } };
  const model = planModel([{ kind: "external", entry: e1 }, selfNode, { kind: "external", entry: e2 }]);
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

// --- query expansion + canonical identity (fix-metadata-query-expansion) -----

test("query expansion: regex collects every alias, literal first", () => {
  const compiled = compileCatalog(cfg(), ["proxy/Claude Fable 5.1"], EXPANSION_TABLES);
  const model = compiled.models[0];
  assert.equal(model.publicId, "proxy/Claude Fable 5.1");
  // Both anthropic aliases and the namespaced aggregator records are kept.
  const ids = model.candidates.map((c) => `${c.provider}:${c.sourceId}`);
  assert.ok(ids.includes("anthropic:claude-fable-5-1"), JSON.stringify(model.candidates));
  assert.ok(ids.includes("anthropic:claude_fable_5.1"), JSON.stringify(model.candidates));
  assert.ok(ids.includes("llmgateway-providers:anthropic/claude-fable-5-1"));
  assert.ok(ids.includes("llmgateway-providers:aws-bedrock/claude-fable-5-1"));
  // The entry chain uses the creator's own record; reseller limits never merge.
  assert.deepEqual(model.entries.map((e) => e.entry), ["models.dev/anthropic/api_key/claude-fable-5-1"]);
  assert.equal(model.entries[0].fields.context_window, 1000000);
  assert.equal(model.canonical, "anthropic/claude-fable-5-1");
});

// --- display name follows the chain (select-display-name-by-chain) -----------

const FABLE_ROW = { id: "proxy/Claude Fable 5.1", name: "My Fable", type: "chat", context_window: 64000 };

async function fableName(yaml: string, row: Record<string, unknown> = FABLE_ROW): Promise<{ id: string; name: string }> {
  const { mapCompiledCatalog } = await import("../index.ts");
  const compiled = compileCatalog(parseMetadataConfig(yaml), [row.id as string], EXPANSION_TABLES);
  const model = mapCompiledCatalog([row], "http://127.0.0.1:1/v1", compiled).models[0];
  return { id: model.id, name: model.name };
}

test("display name: regex query renames by the chain but never the public id", async () => {
  // Default chain: models.dev ahead of @self, so the source's record name wins.
  assert.deepEqual(await fableName(""), { id: "proxy/Claude Fable 5.1", name: "Claude Fable 5.1" });
});

test("display name: @self first keeps the gateway name", async () => {
  assert.equal((await fableName(`chain: ["@self", "models.dev/@creator/api_key"]\n`)).name, "My Fable");
  assert.equal((await fableName(`chain: ["@self"]\n`)).name, "My Fable");
});

test("display name: strict chain without @self and without a source name falls back to the id", async () => {
  const row = { id: "caselab-m", display_name: "Gateway Name", type: "chat", context_window: 64000 };
  const { name } = await fableName(`chain: ["models.dev/caselab/api_key"]\n`, row);
  assert.equal(name, "caselab-m");
});

test("display name: explicit overrides still win over the chain", async () => {
  const yaml = `models:\n  - match: "proxy/**"\n    overrides: {name: Work Model}\n`;
  assert.equal((await fableName(yaml)).name, "Work Model");
});

test("query expansion: channel prefix does not change candidates", () => {
  const bare = compileCatalog(cfg(), ["claude-fable-5-1"], EXPANSION_TABLES).models[0];
  const deep = compileCatalog(cfg(), ["proxy/vendor/claude-fable-5-1"], EXPANSION_TABLES).models[0];
  const idSet = (m: typeof bare) => m.candidates.map((c) => `${c.site}|${c.provider}|${c.sourceId}|${c.level}`).sort();
  assert.deepEqual(idSet(bare), idSet(deep));
  assert.equal(bare.publicId, "claude-fable-5-1");
  assert.equal(deep.publicId, "proxy/vendor/claude-fable-5-1");
});

test("query expansion: input metacharacters match literally, never execute", () => {
  const compiled = compileCatalog(cfg(), ["gw/a+b(c)"], tables({
    modelsDev: { providers: EXPANSION_TABLES.modelsDev!.providers },
  }));
  const model = compiled.models[0];
  // "a+b(c)" is a literal id; it must not widen into "axbxc".
  const ids = model.candidates.map((c) => c.sourceId);
  assert.deepEqual(ids, ["a+b(c)"]);
  // metachar is not the resolved creator, so @creator stays unresolved.
  assert.ok(model.unresolved.includes("models.dev/@creator/api_key/@id"));
  const explicit = compileCatalog(
    cfg({ chain: ["models.dev/metachar/api_key"] }),
    ["gw/a+b(c)"],
    tables({ modelsDev: { providers: EXPANSION_TABLES.modelsDev!.providers } }),
  );
  assert.deepEqual(explicit.models[0].entries.map((e) => e.entry), ["models.dev/metachar/api_key/a+b(c)"]);
});

test("query expansion: literal 4th segment never expands", () => {
  const config = cfg({ chain: ["models.dev/acme/api_key/conflict-x"] });
  const compiled = compileCatalog(config, ["whatever"], EXPANSION_TABLES);
  assert.deepEqual(compiled.models[0].entries.map((e) => e.entry), ["models.dev/acme/api_key/conflict-x"]);
  assert.equal(compiled.models[0].entries[0].fields.context_window, 100);
});

test("query expansion: deterministic under provider enumeration reorder", () => {
  const reversed = tables({
    modelsDev: {
      providers: Object.fromEntries(Object.entries(EXPANSION_TABLES.modelsDev!.providers as Record<string, unknown>).reverse()),
      models: EXPANSION_TABLES.modelsDev!.models,
    },
    modelparams: EXPANSION_TABLES.modelparams,
  });
  const a = compileCatalog(cfg(), ["gw/claude-fable-5-1"], EXPANSION_TABLES);
  const b = compileCatalog(cfg(), ["gw/claude-fable-5-1"], reversed);
  assert.deepEqual(a, b);
});

test("canonical: renamed source id resolves to the real creator model", () => {
  const compiled = compileCatalog(cfg(), ["gw/deepseek-v4-flash-fast"], EXPANSION_TABLES);
  const model = compiled.models[0];
  assert.equal(model.canonical, "deepseek/deepseek-v4-flash");
  const entries = model.entries.map((e) => e.entry);
  assert.ok(entries.includes("models.dev/deepseek/api_key/deepseek-v4-flash"), JSON.stringify(entries));
  assert.ok(entries.includes("modelparams.dev/deepseek/api_key/deepseek-v4-flash"), JSON.stringify(entries));
  // The aggregator record stays a candidate but supplies no fields.
  const agg = model.candidates.find((c) => c.provider === "agg");
  assert.ok(agg && !agg.selected);
  assert.equal(model.entries.find((e) => e.provider === "deepseek")?.fields.context_window, 131072);
});

test("canonical: different creators on @creator chain is a config error", () => {
  assert.throws(() => compileCatalog(cfg(), ["gw/shared-m"], EXPANSION_TABLES), MetadataConfigError);
  // An explicit provider resolves the same model without ambiguity.
  const config = cfg({ chain: ["models.dev/vendor-a/api_key"] });
  const compiled = compileCatalog(config, ["gw/shared-m"], EXPANSION_TABLES);
  assert.deepEqual(compiled.models[0].entries.map((e) => e.entry), ["models.dev/vendor-a/api_key/shared-m"]);
});

test("canonical: same creator multi-model stays ambiguous for remap, own-table record still works", () => {
  const compiled = compileCatalog(cfg(), ["gw/gemini-3-1-pro"], EXPANSION_TABLES);
  const model = compiled.models[0];
  assert.equal(model.canonical, undefined);
  // The canonical remap/unified path stays closed (ambiguity on record), but
  // the maker's own table holds ONE exact record — source-local truth wins
  // without ever picking a reseller variant.
  assert.ok(model.skippedEntries?.some((s) => /multiple canonical models/.test(s.reason)), JSON.stringify(model.skippedEntries));
  const entry = model.entries.find((e) => e.provider === "google");
  assert.ok(entry, JSON.stringify(model));
  assert.equal(entry.canonical, "google/gemini-3-1-pro-preview");
  assert.equal(entry.fields.context_window, 10);
  // The customtools variant record is NOT merged or guessed.
  assert.equal(model.entries.some((e) => e.fields.context_window === 20), false);
  // Both candidates remain visible with their distinct canonicals.
  const canonicals = model.candidates.map((c) => c.canonical).sort();
  assert.deepEqual(canonicals, ["google/gemini-3-1-pro-customtools", "google/gemini-3-1-pro-preview"]);
});

test("canonical: same-level alias field conflict skips the group, next source wins", () => {
  const compiled = compileCatalog(cfg(), ["gw/conflict x"], EXPANSION_TABLES);
  const model = compiled.models[0];
  // acme's two same-level aliases disagree on fields -> skipped, but the
  // modelparams source still contributes its record.
  assert.equal(model.entries.some((e) => e.provider === "acme" && e.site === "models.dev"), false);
  assert.ok(model.entries.some((e) => e.entry === "modelparams.dev/acme/api_key/conflict-x"));
  assert.equal(model.entries[0].fields.context_window, 500);
  const conflicted = model.candidates.filter((c) => c.provider === "acme" && c.site === "models.dev");
  assert.equal(conflicted.length, 2);
  assert.ok(conflicted.every((c) => !c.selected && /conflicting same-level aliases/.test(c.reason ?? "")));
});

test("unified canonical data fills gaps only for automatic @creator/api_key", () => {
  // Provider record wins where valid; unified data fills missing fields.
  const compiled = compileCatalog(cfg(), ["gw/cap-m"], EXPANSION_TABLES);
  const entry = compiled.models[0].entries.find((e) => e.provider === "strictai");
  assert.ok(entry);
  assert.equal(entry.fields.context_window, 200000); // provider beats unified 1000000
  assert.equal(entry.fields.max_output_tokens, 64000); // filled from unified
  assert.equal(entry.fieldSources?.context_window, "provider");
  assert.equal(entry.fieldSources?.max_output_tokens, "canonical");
  assert.equal(entry.canonical, "strictai/cap-m");
});

test("unified canonical data forms a logical entry with no provider record", () => {
  const compiled = compileCatalog(cfg(), ["gw/gpt-5-codex"], EXPANSION_TABLES);
  const model = compiled.models[0];
  const entry = model.entries.find((e) => e.site === "models.dev");
  assert.ok(entry, JSON.stringify(model));
  assert.equal(entry.entry, "models.dev/openai/api_key/gpt-5-codex");
  assert.equal(entry.fields.context_window, 400000);
  assert.equal(entry.fields.max_input_tokens, 272000);
  assert.equal(entry.fields.max_output_tokens, 128000);
  assert.equal(entry.fieldSources?.context_window, "canonical");
  assert.equal(entry.canonical, "openai/gpt-5-codex");
});

test("unified fallback never applies to subscription or explicit sources", () => {
  const sub = compileCatalog(cfg({ chain: ["models.dev/subp/subscription"] }), ["gw/lim-m"], EXPANSION_TABLES);
  const subEntry = sub.models[0].entries.find((e) => e.provider === "subp");
  assert.ok(subEntry);
  assert.equal(subEntry.fields.context_window, 50); // unified 999 must not fill
  assert.equal(subEntry.fieldSources?.context_window, "provider");
  const explicit = compileCatalog(cfg({ chain: ["models.dev/subp/api_key"] }), ["gw/lim-m"], EXPANSION_TABLES);
  assert.equal(explicit.models[0].entries[0].fields.context_window, 50);
  assert.equal(explicit.models[0].entries[0].fields.max_output_tokens, undefined);
});

test("canonical: providers shape missing still enriches via unified data", () => {
  const noProviders = tables({
    modelsDev: { models: EXPANSION_TABLES.modelsDev!.models },
    degraded: [{ site: "models.dev", reason: "providers shape invalid", scope: "providers" }],
  });
  const compiled = compileCatalog(cfg(), ["gw/gpt-5-codex"], noProviders);
  const entry = compiled.models[0].entries.find((e) => e.site === "models.dev");
  assert.ok(entry);
  assert.equal(entry.fields.context_window, 400000);
  assert.equal(entry.fieldSources?.context_window, "canonical");
});

test("canonical: models shape missing keeps provider record path working", () => {
  const noModels = tables({
    modelsDev: { providers: EXPANSION_TABLES.modelsDev!.providers },
    degraded: [{ site: "models.dev", reason: "models shape invalid", scope: "models" }],
  });
  const compiled = compileCatalog(cfg(), ["gw/claude-fable-5-1"], noModels);
  const entry = compiled.models[0].entries.find((e) => e.site === "models.dev");
  assert.ok(entry);
  assert.equal(entry.fields.context_window, 1000000);
  assert.equal(entry.fieldSources?.context_window, "provider");
  assert.equal(entry.fields.max_output_tokens, 128000);
});

test("candidates: same provider/model in both auth groups stays distinct", () => {
  // A modelparams provider listing the same model under api_key AND
  // subscription must keep both records as candidates with distinct access;
  // an api_key chain must never select the subscription metadata.
  const t = tables({
    modelparams: {
      catalog: [
        { provider: "z-ai", authType: "api_key", model: "dual-m", params: [{ path: "context_window", range: { max: 111 } }] },
        { provider: "z-ai", authType: "subscription", model: "dual-m", params: [{ path: "context_window", range: { max: 222 } }] },
      ],
    },
  });
  const compiled = compileCatalog(cfg({ chain: ["modelparams.dev/z-ai/api_key"] }), ["gw/dual-m"], t);
  const model = compiled.models[0];
  const candidates = model.candidates.filter((c) => c.provider === "z-ai" && c.sourceId === "dual-m");
  assert.equal(candidates.length, 2, JSON.stringify(candidates));
  assert.deepEqual(candidates.map((c) => c.access).sort(), ["api_key", "subscription"]);
  const apiKeyCandidate = candidates.find((c) => c.access === "api_key");
  const subCandidate = candidates.find((c) => c.access === "subscription");
  assert.equal(apiKeyCandidate?.selected, true);
  assert.equal(subCandidate?.selected, false);
  assert.equal(model.entries[0]?.access, "api_key");
  assert.equal(model.entries[0]?.fields.context_window, 111, "subscription tier must not be selected");
});

test("date-suffix fallback stays a lower-priority query", () => {
  const t = tables({
    modelsDev: {
      providers: {
        anthropic: { models: { "claude-3-5-haiku": { canonical_model_id: "anthropic/claude-3-5-haiku", limit: { context: 42 } } } },
      },
      models: { "anthropic/claude-3-5-haiku": { limit: { context: 42 } } },
    },
  });
  const compiled = compileCatalog(cfg(), ["gw/claude-3-5-haiku-20241022"], t);
  const model = compiled.models[0];
  assert.ok(model.entries.some((e) => e.entry === "models.dev/anthropic/api_key/claude-3-5-haiku"));
  const fallback = model.candidates.find((c) => c.sourceId === "claude-3-5-haiku" && c.provider === "anthropic");
  assert.equal(fallback?.level, 2);
});

// --- reviewer contract probes (permanent regression) -------------------------

const probeRec = (canonical: string | undefined, n: number, id?: string) => ({
  canonical_model_id: canonical,
  limit: { context: n },
  ...(id ? { id } : {}),
});
const probeCompile = (id: string, modelsDev: SourceTables["modelsDev"], chain = ["models.dev/@creator/api_key"]) =>
  compileCatalog(cfg({ chain }), [id], tables({ modelsDev }));
const probeModel = (...args: Parameters<typeof probeCompile>) => probeCompile(...args).models[0];

test("probe: resolved canonical constrains provider fields", () => {
  const m = probeModel("x", {
    providers: { a: { models: { x: probeRec("a/y", 100) } } },
    models: { "a/x": { limit: { context: 900 } } },
  });
  assert.equal(m.canonical, "a/x");
  assert.equal(externalFields(m).context_window, 900);
});

test("probe: exact tier beats regex alias and unified fallback", () => {
  const m = probeModel("Model-X", {
    providers: { a: { models: { "Model-X": probeRec("a/model-x", 100), "model-x": probeRec("a/model-x", 900) } } },
    models: { "a/model-x": { limit: { context: 1000 } } },
  });
  assert.equal(externalFields(m).context_window, 100);
});

test("probe: provider and unified source identities stay distinct", () => {
  const m = probeModel("x", {
    providers: { a: { models: { "a/x": probeRec("a/y", 100) } } },
    models: { "a/x": { limit: { context: 900 } } },
  });
  assert.equal(m.canonical, "a/x");
  const unified = m.candidates.find((c) => c.sourceId === "a/x" && c.selected);
  assert.ok(unified, JSON.stringify(m.candidates));
});

test("probe: key/id collisions never depend on enumeration order", () => {
  const rows = [["first", probeRec("a/x", 100, "x")], ["x", probeRec("a/x", 900)]] as const;
  const fields = (r: readonly (readonly [string, unknown])[]) =>
    externalFields(probeModel("x", { providers: { a: { models: Object.fromEntries(r) } } }, ["models.dev/a/api_key"]));
  assert.deepEqual(fields(rows), fields([...rows].reverse()));
});

test("probe: @creator with literal fourth segment keeps lookup", () => {
  const m = probeModel("m", {
    providers: { a: { models: { m: probeRec("a/m", 100), other: probeRec("a/other", 200) } } },
  }, ["models.dev/@creator/api_key/other"]);
  assert.equal(externalFields(m).context_window, 200);
});

// One separator-class position per query separator character: each may swap
// to any of space/underscore/dot/hyphen or delete, never multiply.
const sepTable = (ids: readonly string[], context = 1) =>
  tables({
    modelsDev: {
      providers: {
        a: { models: Object.fromEntries(ids.map((id) => [id, { limit: { context } }])) },
      },
    },
  });
const sepCompile = (query: string, ids: readonly string[], context?: number) =>
  compileCatalog(cfg({ chain: ["models.dev/a/api_key"] }), [query], sepTable(ids, context)).models[0];
const sepCandidates = (query: string, ids: readonly string[]) =>
  sepCompile(query, ids).candidates.map((c) => c.sourceId).sort();

const SEP_VARIANTS = ["a b", "a_b", "a.b", "a-b", "ab"];

test("probe: each query separator swaps across the class or deletes", () => {
  for (const q of ["a b", "a_b", "a.b", "a-b"]) {
    const model = sepCompile(q, SEP_VARIANTS, 100);
    assert.deepEqual(model.candidates.map((c) => c.sourceId).sort(), ["a b", "a-b", "a.b", "a_b", "ab"], q);
    // The literal spelling keeps level 0; every swapped/deleted hit stays level 1.
    for (const c of model.candidates) assert.equal(c.level, c.sourceId === q ? 0 : 1, `${q} -> ${c.sourceId}`);
    // Same fields across all aliases: one record still supplies them.
    assert.equal(externalFields(model).context_window, 100, q);
  }
  // "\s" keeps its full whitespace range: a tab separates exactly like space.
  assert.deepEqual(sepCandidates("a\tb", SEP_VARIANTS), ["a b", "a-b", "a.b", "a_b", "ab"]);
});

test("probe: separator counts are per-position — no one-to-many, no insertion", () => {
  // One query separator never swallows a run of two source separators.
  for (const id of ["a--b", "a_.b", "a  b"]) {
    assert.deepEqual(sepCandidates("a-b", [id]), [], id);
  }
  // Two query separators match 0..2 source separators, never three.
  assert.deepEqual(sepCandidates("a--b", ["ab", "a_b", "a_.b", "a---b"]), ["a_.b", "a_b", "ab"]);
  // A separator-free query never gains positions.
  assert.deepEqual(sepCandidates("ab", ["a-b"]), []);
  // Boundary runs obey the same per-position cap.
  assert.deepEqual(sepCandidates("--x", ["x", "-x", ". x", "---x"]), ["-x", ". x", "x"]);
  assert.deepEqual(sepCandidates("x--", ["x", "x_", "x.-", "x---"]), ["x", "x.-", "x_"]);
});

test("probe: metacharacters and pure-separator queries stay safe", () => {
  // Non-separator regex metacharacters stay literal; adjacent separators may
  // still delete, so "model+(x)1" matches while "modelX1" never does.
  const m = sepCompile("Model+(X)-1", ["model+(x)1", "modelX1"]);
  assert.deepEqual(m.candidates.map((c) => c.sourceId), ["model+(x)1"]);
  // Pure-separator queries produce no regex candidates at all.
  assert.deepEqual(sepCandidates("_-.", ["x", "___"]), []);
  const onlyDash = sepCompile("-", ["-", "x"]);
  assert.deepEqual(onlyDash.candidates.map((c) => c.sourceId), ["-"]);
});

test("compileCatalog: separator deletion keeps original spelling across all sources", () => {
  const t = tables({
    modelsDev: {
      providers: {
        maker: { models: { "ClaudeFable51": { canonical_model_id: "maker/ClaudeFable51", limit: { context: 100 } } } },
        vendor: { models: { "ns/Claude Fable 5.1": { canonical_model_id: "maker/ClaudeFable51", limit: { context: 1 } } } },
      },
      models: { "maker/ClaudeFable51": { limit: { context: 100, output: 10 } } },
    },
    modelparams: {
      catalog: [
        { provider: "maker", authType: "api_key", model: "claude-fable-5-1", params: [{ path: "max_tokens", range: { max: 8192 } }] },
      ],
    },
  });
  // Mixed-case spaced query deletes every separator position to hit
  // ClaudeFable51; sources keep their exact spelling everywhere.
  const model = compileCatalog(cfg(), ["Proxy/Claude Fable 5.1"], t).models[0];
  assert.equal(model.publicId, "Proxy/Claude Fable 5.1");
  const makerEntry = model.entries.find((e) => e.provider === "maker" && e.site === "models.dev");
  assert.equal(makerEntry?.entry, "models.dev/maker/api_key/ClaudeFable51");
  assert.equal(makerEntry?.fields.context_window, 100);
  const paramsEntry = model.entries.find((e) => e.site === "modelparams.dev");
  assert.equal(paramsEntry?.entry, "modelparams.dev/maker/api_key/claude-fable-5-1");
  assert.equal(paramsEntry?.fields.max_output_tokens, 8192);
  const namespaced = model.candidates.find((c) => c.provider === "vendor");
  assert.equal(namespaced?.sourceId, "ns/Claude Fable 5.1");
  assert.equal(namespaced?.sourceKey, "ns/Claude Fable 5.1");
  assert.equal(namespaced?.selected, false);
  // Levels: the exact-spelling namespaced record hits literal level 0 while
  // the separator-deleted maker/params records stay level 1.
  const makerCand = model.candidates.find((c) => c.provider === "maker" && c.site === "models.dev");
  assert.equal(makerCand?.level, 1);
  assert.equal(makerCand?.sourceId, "ClaudeFable51");
  const paramsCand = model.candidates.find((c) => c.site === "modelparams.dev");
  assert.equal(paramsCand?.level, 1);
  assert.equal(paramsCand?.sourceId, "claude-fable-5-1");
  // Enumeration order of the source tables cannot change the outcome.
  const reversed = tables({
    modelsDev: {
      providers: Object.fromEntries(Object.entries(t.modelsDev!.providers as Record<string, unknown>).reverse()),
      models: t.modelsDev!.models,
    },
    modelparams: t.modelparams,
  });
  assert.deepEqual(compileCatalog(cfg(), ["Proxy/Claude Fable 5.1"], reversed).models[0], model);
});

test("compileCatalog: separator-deletion hits keep level ordering and literal 4th segment strict", () => {
  const t = tables({
    modelsDev: {
      providers: {
        a: {
          models: {
            "modelx20260101": { limit: { context: 10 } },
            "ModelX": { limit: { context: 20 } },
          },
        },
      },
    },
  });
  const model = compileCatalog(cfg({ chain: ["models.dev/a/api_key"] }), ["gw/Model-X-20260101"], t).models[0];
  const byLevel = (id: string) => model.candidates.find((c) => c.sourceId === id)?.level;
  // Regex hit (separator swaps + delete) stays above the date-fallback hit.
  assert.equal(byLevel("modelx20260101"), 1);
  assert.equal(byLevel("ModelX"), 2);
  assert.equal(model.entries[0].fields.context_window, 10);
  // The literal 4th segment is still case- and separator-exact.
  for (const lit of ["model-x", "ModelX"]) {
    const strict = compileCatalog(
      cfg({ chain: [`models.dev/a/api_key/${lit}`] }),
      ["gw/anything"],
      tables({ modelsDev: { providers: { a: { models: { "Model-X": { limit: { context: 7 } } } } } } }),
    ).models[0];
    assert.equal(strict.entries.length, 0, lit);
  }
  const exact = compileCatalog(
    cfg({ chain: ["models.dev/a/api_key/Model-X"] }),
    ["gw/anything"],
    tables({ modelsDev: { providers: { a: { models: { "Model-X": { limit: { context: 7 } } } } } } }),
  ).models[0];
  assert.equal(exact.entries[0].fields.context_window, 7);
});

test("compileCatalog: separator-deletion candidates keep existing canonical ambiguity handling", () => {
  // Both source ids reach the query at regex level 1 via separator swap;
  // the two distinct creators still conflict on @creator instead of
  // silently merging or first-wins.
  const t = tables({
    modelsDev: {
      providers: {
        "vendor-a": { models: { shared_m: { canonical_model_id: "vendor-a/shared-m", limit: { context: 1 } } } },
        "vendor-b": { models: { "shared m": { canonical_model_id: "vendor-b/shared-m", limit: { context: 2 } } } },
      },
    },
  });
  assert.throws(() => compileCatalog(cfg(), ["gw/shared-m"], t), MetadataConfigError);
  const explicit = compileCatalog(cfg({ chain: ["models.dev/vendor-a/api_key"] }), ["gw/shared-m"], t).models[0];
  assert.deepEqual(explicit.entries.map((e) => e.entry), ["models.dev/vendor-a/api_key/shared_m"]);
  assert.equal(explicit.entries[0].fields.context_window, 1);
});

test("probe: canonical-remap selected records remain export candidates", () => {
  const m = probeModel("alias", {
    providers: {
      agg: { models: { alias: probeRec("a/m", 1) } },
      a: { models: { m: probeRec("a/m", 100) } },
    },
  });
  const selected = m.candidates.find((c) => c.provider === "a" && c.sourceId === "m" && c.selected);
  assert.ok(selected, JSON.stringify(m.candidates));
  // The aggregator record that supplied the identity hint keeps a skip reason.
  const agg = m.candidates.find((c) => c.provider === "agg" && c.sourceId === "alias");
  assert.ok(agg && !agg.selected && typeof agg.reason === "string" && agg.reason.length > 0);
});

// --- re-review probes (permanent regression, round 2) ------------------------

test("probe: explicit provider is not rejected by automatic canonical identity", () => {
  const m = compileCatalog(
    cfg({ chain: ["models.dev/a/api_key"] }),
    ["x"],
    tables({
      modelsDev: {
        providers: { a: { models: { x: probeRec("a/y", 100) } } },
        models: { "a/x": { limit: { context: 900 } } },
      },
    }),
  ).models[0];
  // Explicit source wins with its own fields and its own declared canonical;
  // the automatic a/x identity neither vetoes it nor injects unified data.
  assert.equal(externalFields(m).context_window, 100);
  const entry = m.entries[0];
  assert.equal(entry.fields.context_window, 100);
  assert.equal(entry.fields.max_output_tokens, undefined);
  assert.equal(entry.canonical, "a/y");
  assert.equal(m.canonical, "a/x");
});

test("probe: same-owner ambiguity still allows an exact modelparams record", () => {
  const tables_ = tables({
    modelsDev: {
      providers: {
        reseller1: { models: { "deepseek-flash": probeRec("deepseek/variant-a", 1) } },
        reseller2: { models: { "deepseek-flash": probeRec("deepseek/variant-b", 2) } },
      },
    },
    modelparams: {
      catalog: [
        { provider: "deepseek", authType: "api_key", model: "deepseek-flash", params: [{ path: "context_window", range: { max: 64000 } }, { path: "max_tokens", range: { max: 8192 } }] },
      ],
    },
  });
  const auto = compileCatalog(cfg(), ["sensenova/deepseek-flash"], tables_).models[0];
  assert.equal(auto.entries.some((e) => e.site === "models.dev"), false);
  assert.equal(externalFields(auto).context_window, 64000);
  assert.equal(externalFields(auto).max_output_tokens, 8192);
  // models.dev stays unresolved with its ambiguity reason on record.
  assert.ok(auto.unresolved.includes("models.dev/@creator/api_key/@id"));
  // Cross-maker identity still blocks modelparams the same way.
  const cross = tables({
    modelsDev: {
      providers: {
        r1: { models: { "deepseek-flash": probeRec("deepseek/variant-a", 1) } },
        r2: { models: { "deepseek-flash": probeRec("openai/variant-b", 2) } },
      },
    },
    modelparams: tables_.modelparams,
  });
  assert.throws(() => compileCatalog(cfg(), ["sensenova/deepseek-flash"], cross), MetadataConfigError);
});

test("probe: boundary separators swap or delete within their count", () => {
  // "-x" matches "x" and ".x" but never "--x"; trailing positions alike.
  assert.deepEqual(sepCandidates("-x", ["x", ".x", "x-", "--x", "x__"]), [".x", "x"]);
  assert.deepEqual(sepCandidates("x_", ["x", "x-", ".x", "x__", "--x"]), ["x", "x-"]);
  // Each boundary separator still swaps across the whole class.
  for (const q of [".x", "-x", " x", "_x"]) {
    const m = sepCompile(q, ["-x"], 50);
    assert.equal(externalFields(m).context_window, 50, q);
  }
  for (const q of ["x.", "x-", "x_", "x "]) {
    const m = sepCompile(q, ["x-"], 60);
    assert.equal(externalFields(m).context_window, 60, q);
  }
});

test("probe: every matched key/id spelling stays in exported candidates", () => {
  const m = compileCatalog(
    cfg({ chain: ["models.dev/a/api_key"] }),
    ["Foo Bar"],
    tables({ modelsDev: { providers: { a: { models: { "foo-bar": probeRec("a/foo-bar", 100, "foo_bar") } } } } }),
  ).models[0];
  assert.equal(m.entries.length, 1);
  assert.equal(externalFields(m).context_window, 100);
  assert.deepEqual(m.candidates.map((c) => c.sourceId).sort(), ["foo-bar", "foo_bar"]);
  assert.ok(m.candidates.some((c) => c.sourceId === "foo-bar" && c.selected));
  assert.ok(m.candidates.some((c) => c.sourceId === "foo_bar" && !c.selected));
});

test("probe: literal follow-up exports the selected record's own canonical", () => {
  const m = compileCatalog(
    cfg({ chain: ["models.dev/@creator/api_key/other"] }),
    ["m"],
    tables({
      modelsDev: {
        providers: { a: { models: { m: probeRec("a/m", 100), other: probeRec("a/other", 200) } } },
      },
    }),
  ).models[0];
  assert.equal(externalFields(m).context_window, 200);
  const entry = m.entries[0];
  assert.equal(entry.canonical, "a/other");
  assert.ok(m.candidates.some((c) => c.sourceId === "other" && c.selected));
  // The discovery hit that proved a/m stays a candidate too.
  assert.ok(m.candidates.some((c) => c.sourceId === "m" && !c.selected));
});

test("probe: manufacturer-exact models.dev record supplies fields under ambiguity", () => {
  // Real lost sensenova/deepseek-flash shape: resellers alias the same
  // maker's model under two different canonical variants; the maker's own
  // provider table holds the exact record with its own canonical+limits.
  const m = compileCatalog(cfg(), ["sensenova/deepseek-flash"], tables({
    modelsDev: {
      providers: {
        reseller1: { models: { "deepseek-flash": probeRec("deepseek/variant-a", 1) } },
        reseller2: { models: { "deepseek-flash": probeRec("deepseek/variant-b", 2) } },
        deepseek: {
          models: {
            "deepseek-flash": {
              canonical_model_id: "deepseek/deepseek-v4.1-flash-1017",
              limit: { context: 1048576, output: 393216 },
            },
          },
        },
      },
      models: {
        "deepseek/deepseek-v4.1-flash-1017": {
          limit: { context: 1048576, output: 393216 },
          reasoning_options: [{ type: "effort", values: [{ effort: "low" }, { effort: "high" }, { effort: "max" }] }],
        },
      },
    },
  })).models[0];
  // Ambiguity must not veto the maker's own unambiguous exact record; the
  // entry carries the record's REAL canonical and unified fills gaps only.
  const entry = m.entries.find((e) => e.provider === "deepseek" && e.site === "models.dev");
  assert.ok(entry, JSON.stringify(m));
  assert.equal(entry.fields.context_window, 1048576);
  assert.equal(entry.fields.max_output_tokens, 393216);
  assert.equal(entry.canonical, "deepseek/deepseek-v4.1-flash-1017");
  assert.equal(entry.fieldSources?.context_window, "provider");
  // Reseller variants stay candidates, never fields.
  assert.ok(m.candidates.some((c) => c.provider === "reseller1" && !c.selected));
  assert.ok(m.candidates.some((c) => c.provider === "reseller2" && !c.selected));
  // The ambiguity diagnosis is still on record — the remap path was closed.
  assert.ok(m.skippedEntries?.some((s) => /multiple canonical models/.test(s.reason)));
});
