import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyOverrides,
  classifyAccess,
  DEFAULT_SOURCE_PRIORITY,
  matchModelPattern,
  mergeMetadata,
  mergeProviderPrefixMaps,
  MetadataConfigError,
  normalizeFields,
  overlayMetadata,
  parseMetadataConfig,
  parseSelector,
  resolveMetadataChain,
  resolveModelPolicy,
  resolveSelectorSite,
  selectModelRule,
  stripChannelPrefix,
  type MetadataConfig,
  type SourceRecord,
} from "../model-metadata.ts";
import { createMetadataResolver, fetchMetadataSources, neededSites, SOURCE_URLS } from "../metadata-sources.ts";
import { mapCatalog } from "../index.ts";

const cfg = (overrides: Partial<MetadataConfig> = {}): MetadataConfig => ({ warnings: [], ...overrides });

// --- 1.3 YAML config -------------------------------------------------------

test("parseMetadataConfig: missing file means empty config with default chain later", () => {
  const parsed = parseMetadataConfig(undefined);
  assert.deepEqual(parsed.warnings, []);
  assert.equal(parsed.sourcePriority, undefined);
});

test("parseMetadataConfig: valid config with chain, mode, model rules, channels", () => {
  const parsed = parseMetadataConfig(`
source_priority: ["*/subscription", "*/api_key"]
fill_missing_only: false
models:
  "*gpt-6-astra":
    source_priority: ["models.dev/openai"]
    fill_missing_only: true
    lookup_ids:
      "models.dev/openai": gpt-6-astra-ga
    overrides:
      context_window: 128000
channels:
  proxy:
    source_priority: ["models.dev/*/subscription"]
    global_fallback: true
    fill_missing_only: true
    models:
      model-a:
        source_priority: ["modelparams.dev/z-ai/subscription"]
`);
  assert.equal(parsed.fillMissingOnly, false);
  assert.deepEqual(parsed.sourcePriority, ["*/subscription", "*/api_key"]);
  assert.equal(parsed.models?.["*gpt-6-astra"].fillMissingOnly, true);
  assert.equal(parsed.channels?.proxy?.globalFallback, true);
  assert.equal(parsed.channels?.proxy?.models?.["model-a"].sourcePriority?.[0], "modelparams.dev/z-ai/subscription");
});

test("parseMetadataConfig: invalid YAML, bad selector, non-bool mode are config errors", () => {
  assert.throws(() => parseMetadataConfig("a: ["), MetadataConfigError);
  assert.throws(() => parseMetadataConfig("source_priority: [\"bogus-site/x/api_key\"]"), MetadataConfigError);
  assert.throws(() => parseMetadataConfig("fill_missing_only: yes_please"), MetadataConfigError);
  assert.throws(() => parseMetadataConfig("models:\n  a:\n    source_priority: \"notalist\""), MetadataConfigError);
});

test("parseMetadataConfig: unknown fields ignored with warning paths, rest applies", () => {
  const parsed = parseMetadataConfig(`
static_models: [{slug: x}]
cpa_base_url: https://x
source_priority: ["*/api_key"]
channels:
  proxy:
    custom_channels: {a: {}}
    models:
      m:
        metadata_from: other/x
`);
  assert.deepEqual(parsed.warnings.sort(), [
    "channels.proxy.custom_channels",
    "channels.proxy.models.m.metadata_from",
    "cpa_base_url",
    "static_models",
  ].sort());
  assert.deepEqual(parsed.sourcePriority, ["*/api_key"]);
  assert.equal(parsed.channels?.proxy !== undefined, true);
});

test("parseMetadataConfig: duplicate keys rejected", () => {
  assert.throws(() => parseMetadataConfig("models:\n  a:\n    x: 1\n  a:\n    y: 2\n"), MetadataConfigError);
});

// --- 1.5 model glob rules --------------------------------------------------

test("matchModelPattern: * crosses '/', matches empty, literal otherwise, case-sensitive", () => {
  assert.equal(matchModelPattern("*gpt-6-astra", "gpt-6-astra"), true);
  assert.equal(matchModelPattern("*gpt-6-astra", "openai/gpt-6-astra"), true);
  assert.equal(matchModelPattern("*gpt-6-astra", "proxy/openai/gpt-6-astra"), true);
  assert.equal(matchModelPattern("*gpt-6-astra", "gpt-6-astra-preview"), false);
  assert.equal(matchModelPattern("*gpt*", "vendor/claude"), false);
  assert.equal(matchModelPattern("*gpt*", "gpt-proxy/claude"), true);
  assert.equal(matchModelPattern("*gpt*", "vendor/GPT-6-astra"), false);
  assert.equal(matchModelPattern("*", ""), true);
  assert.equal(matchModelPattern("gpt-6-astra", "openai/gpt-6-astra"), false);
});

test("selectModelRule: exact key wins, then first matching glob in declaration order", () => {
  const rules = {
    "*gpt*": { fillMissingOnly: true },
    "*gpt-6-astra": { fillMissingOnly: false },
    "openai/gpt-6-astra": { fillMissingOnly: false },
  };
  assert.equal(selectModelRule(rules, "openai/gpt-6-astra")?.fillMissingOnly, false);
  assert.equal(selectModelRule(rules, "gpt-6-astra")?.fillMissingOnly, true); // first glob wins
  assert.equal(selectModelRule(rules, "other/model"), undefined);
});

test("stripChannelPrefix: only configured channel keys strip once", () => {
  const channels = { proxy: {} };
  assert.deepEqual(stripChannelPrefix("proxy/vendor/model-a", channels), { channel: "proxy", id: "vendor/model-a" });
  assert.deepEqual(stripChannelPrefix("another/model", channels), { id: "another/model" });
  assert.deepEqual(stripChannelPrefix("bare", channels), { id: "bare" });
});

// --- 1.4 chain + mode inheritance ------------------------------------------

test("resolveModelPolicy: default chain when unconfigured", () => {
  const policy = resolveModelPolicy(cfg(), "model-a");
  assert.deepEqual([...policy.sourcePriority], [...DEFAULT_SOURCE_PRIORITY]);
  assert.equal(policy.fillMissingOnly, false);
});

test("resolveModelPolicy: channel chain + deduped global fallback", () => {
  const policy = resolveModelPolicy(
    cfg({
      sourcePriority: ["A", "B"],
      channels: { proxy: { sourcePriority: ["B", "C"] } },
    }),
    "proxy/model-a",
  );
  // channel chain first, then global appended without duplicating B
  assert.deepEqual([...policy.sourcePriority], ["B", "C", "A"]);
});

test("resolveModelPolicy: global_fallback=false keeps channel-only", () => {
  const policy = resolveModelPolicy(
    cfg({ sourcePriority: ["A"], channels: { proxy: { sourcePriority: ["B"], globalFallback: false } } }),
    "proxy/m",
  );
  assert.deepEqual([...policy.sourcePriority], ["B"]);
});

test("resolveModelPolicy: model chain replaces channel+global; explicit [] honored", () => {
  const policy = resolveModelPolicy(
    cfg({
      sourcePriority: ["A"],
      channels: { proxy: { sourcePriority: ["B"], models: { m: { sourcePriority: ["C"] } } } },
    }),
    "proxy/m",
  );
  assert.deepEqual([...policy.sourcePriority], ["C"]);

  const empty = resolveModelPolicy(
    cfg({
      sourcePriority: ["A"],
      channels: { proxy: { sourcePriority: ["B"], models: { m: { sourcePriority: [] } } } },
    }),
    "proxy/m",
  );
  assert.deepEqual([...empty.sourcePriority], []);
});

test("resolveModelPolicy: global model rule beats channel default, channel model beats it", () => {
  // Global models rules match the full public id ("proxy/m"); channel rules
  // match the channel-relative id ("m").
  const config = cfg({
    sourcePriority: ["A"],
    models: { "proxy/m": { sourcePriority: ["G"] } },
    channels: { proxy: { sourcePriority: ["B"], models: { m: { sourcePriority: ["C"] } } } },
  });
  assert.deepEqual([...resolveModelPolicy(config, "proxy/m").sourcePriority], ["C"]);
  const noChannelRule = cfg({
    sourcePriority: ["A"],
    models: { "proxy/m": { sourcePriority: ["G"] } },
    channels: { proxy: { sourcePriority: ["B"] } },
  });
  assert.deepEqual([...resolveModelPolicy(noChannelRule, "proxy/m").sourcePriority], ["G"]);
});

test("resolveModelPolicy: fill_missing_only precedence channel model > global model > channel > global > false", () => {
  const base = cfg({ fillMissingOnly: true, channels: { proxy: { fillMissingOnly: false } } });
  assert.equal(resolveModelPolicy(base, "proxy/m").fillMissingOnly, false); // channel wins over global
  const withGlobalRule = cfg({
    channels: { proxy: { fillMissingOnly: false } },
    models: { "*m*": { fillMissingOnly: true } },
  });
  assert.equal(resolveModelPolicy(withGlobalRule, "proxy/m").fillMissingOnly, true); // global model beats channel default
  const explicitFalse = cfg({
    models: { "*m*": { fillMissingOnly: true } },
    channels: { proxy: { models: { m: { fillMissingOnly: false } } } },
  });
  assert.equal(resolveModelPolicy(explicitFalse, "proxy/m").fillMissingOnly, false);
});

// --- 2.1 selectors ---------------------------------------------------------

test("parseSelector: all supported forms, invalid rejected", () => {
  assert.deepEqual(parseSelector("models.dev/openai"), { site: "models.dev", provider: "openai", access: "*", token: "models.dev/openai" });
  assert.deepEqual(parseSelector("models.dev/*").providerPattern, "*");
  assert.deepEqual(parseSelector("modelparams.dev/zai/subscription"), { site: "modelparams.dev", providerPattern: "zai", access: "subscription", token: "modelparams.dev/zai/subscription" });
  assert.deepEqual(parseSelector("*/subscription"), { site: "*", providerPattern: "*", access: "subscription", token: "*/subscription" });
  assert.deepEqual(parseSelector("*/api_key"), { site: "*", providerPattern: "*", access: "api_key", token: "*/api_key" });
  assert.deepEqual(parseSelector("models.dev/open*/api_key").site, "models.dev");
  assert.throws(() => parseSelector("bogus/openai"), MetadataConfigError);
  assert.throws(() => parseSelector("modelparams.dev/zai"), MetadataConfigError);
  assert.throws(() => parseSelector("*/gold"), MetadataConfigError);
  assert.throws(() => parseSelector("a/b/c/d"), MetadataConfigError);
  assert.throws(() => parseSelector("models.dev/"), MetadataConfigError);
});

test("classifyAccess: models.dev subscription set vs modelparams authType", () => {
  assert.equal(classifyAccess("models.dev", "zai-coding-plan", undefined), "subscription");
  assert.equal(classifyAccess("models.dev", "zai", undefined), "api_key");
  assert.equal(classifyAccess("models.dev", "new-provider", undefined), "api_key");
  assert.equal(classifyAccess("modelparams.dev", "zai", "subscription"), "subscription");
  assert.equal(classifyAccess("modelparams.dev", "zai", "api_key"), "api_key");
  assert.equal(classifyAccess("modelparams.dev", "zai", "oauth"), undefined);
});

// --- 2.3-2.4 identity + ambiguity ------------------------------------------

const dev = (provider: string, modelId: string, canonical?: string, fields = {}): SourceRecord => ({
  site: "models.dev",
  provider,
  modelId,
  canonicalModelId: canonical,
  fields: { context_window: 64000, ...fields },
});

test("resolveSelectorSite: single provider candidate wins", () => {
  const selector = parseSelector("*/api_key");
  const policy = resolveModelPolicy(cfg(), "gpt-5");
  const result = resolveSelectorSite(selector, "models.dev", "gpt-5", policy, {}, [dev("openai", "gpt-5", "openai/gpt-5")]);
  assert.equal(result.record?.provider, "openai");
});

test("resolveSelectorSite: creator arbitration picks developer-hosted entry", () => {
  const selector = parseSelector("*/api_key");
  const policy = resolveModelPolicy(cfg(), "gpt-5");
  const records = [
    dev("openrouter", "openai/gpt-5", "openai/gpt-5", { context_window: 100000 }),
    dev("helicone", "gpt-5", "openai/gpt-5", { context_window: 200000 }),
    dev("openai", "gpt-5", "openai/gpt-5", { context_window: 300000 }),
  ];
  const first = resolveSelectorSite(selector, "models.dev", "gpt-5", policy, {}, records);
  const shuffled = resolveSelectorSite(selector, "models.dev", "gpt-5", policy, {}, [...records].reverse());
  assert.equal(first.record?.provider, "openai");
  assert.equal(first.record?.fields.context_window, 300000);
  assert.equal(shuffled.record?.provider, "openai", "arbitration must not depend on record order");
});

test("resolveSelectorSite: inconsistent canonicals or missing creator entry is ambiguous skip", () => {
  const selector = parseSelector("*/api_key");
  const policy = resolveModelPolicy(cfg(), "m");
  const mixed = resolveSelectorSite(selector, "models.dev", "m", policy, {}, [
    dev("a", "m", "a/m"),
    dev("b", "m", "b/m"), // disagree
  ]);
  assert.equal(mixed.record, undefined);
  assert.equal(mixed.diagnostic?.kind, "ambiguous");
  const missingCreator = resolveSelectorSite(selector, "models.dev", "m", policy, {}, [
    dev("a", "m", "zai/m"),
    dev("b", "m", "zai/m"), // same canonical but the creator's own entry is absent
  ]);
  assert.equal(missingCreator.diagnostic?.kind, "ambiguous");
});

test("resolveSelectorSite: arbitration does not cross access type", () => {
  // Two subscription candidates disagree; the api_key creator entry is out of scope.
  const selector = parseSelector("*/subscription");
  const policy = resolveModelPolicy(cfg(), "m");
  const result = resolveSelectorSite(selector, "models.dev", "m", policy, {}, [
    dev("zai-coding-plan", "m", "zai/m"),
    dev("alibaba-coding-plan", "m", "zai/m"),
    dev("openai", "m", "zai/m"), // api_key group, never considered
  ]);
  assert.equal(result.diagnostic?.kind, "ambiguous");
});

test("resolveSelectorSite: modelparams.dev never arbitrates (canonical ignored)", () => {
  const selector = parseSelector("modelparams.dev/*/api_key");
  const policy = resolveModelPolicy(cfg(), "m");
  const mp = (provider: string): SourceRecord => ({
    site: "modelparams.dev",
    provider,
    modelId: "m",
    authType: "api_key",
    fields: { context_window: 1 },
  });
  const result = resolveSelectorSite(selector, "modelparams.dev", "m", policy, {}, [mp("a"), mp("b")]);
  assert.equal(result.diagnostic?.kind, "ambiguous");
});

test("resolveSelectorSite: provider_prefix_map retargets qualified query id", () => {
  const selector = parseSelector("*/api_key");
  const policy = resolveModelPolicy(cfg(), "vendor/m");
  const result = resolveSelectorSite(
    selector,
    "models.dev",
    "vendor/m",
    policy,
    { vendor: ["openai"] },
    [dev("openai", "m", "openai/m")],
  );
  assert.equal(result.record?.provider, "openai");
});

test("resolveSelectorSite: lookup_ids supplies exact query id", () => {
  const selector = parseSelector("models.dev/openai");
  const policy = resolveModelPolicy(
    cfg({ models: { m: { lookupIds: { "models.dev/openai": "m-ga" } } } }),
    "m",
  );
  const result = resolveSelectorSite(selector, "models.dev", "m", policy, {}, [dev("openai", "m-ga")]);
  assert.equal(result.record?.modelId, "m-ga");
});

test("resolveSelectorSite: qualified query keeps vendor namespace without prefix map", () => {
  const selector = parseSelector("*/api_key");
  const policy = resolveModelPolicy(cfg(), "vendor/m");
  const result = resolveSelectorSite(selector, "models.dev", "vendor/m", policy, {}, [
    dev("other", "m"), // bare "m" under another provider is not "vendor/m"
  ]);
  assert.equal(result.diagnostic?.kind, "missing");
});

test("mergeProviderPrefixMaps: channel overrides same-name global", () => {
  const merged = mergeProviderPrefixMaps({ vendor: ["a"] }, { vendor: ["b"], other: ["c"] });
  assert.deepEqual(merged, { vendor: ["b"], other: ["c"] });
});

test("resolveMetadataChain: user order wins; same-selector site order; fields fill down the chain", () => {
  // models.dev offers context_window only; modelparams.dev offers a different
  // context_window plus max_output_tokens. The higher-priority models.dev
  // value must win while modelparams.dev still fills the missing field.
  const records: SourceRecord[] = [
    dev("openai", "m", "openai/m", { context_window: 100 }),
    {
      site: "modelparams.dev",
      provider: "openai",
      modelId: "m",
      authType: "api_key",
      fields: { context_window: 200, max_output_tokens: 8 },
    },
  ];
  const policy = resolveModelPolicy(cfg({ sourcePriority: ["*/api_key"] }), "m");
  const result = resolveMetadataChain(policy, "m", "m", {}, records);
  assert.equal(result.fields.context_window, 100); // models.dev wins inside one selector
  assert.equal(result.fields.max_output_tokens, 8); // modelparams.dev fills the gap
});

test("resolveMetadataChain: reversed user order actually inverts access-type priority", () => {
  const records: SourceRecord[] = [
    dev("openai", "m", "openai/m", { context_window: 64000 }),
    dev("zai-coding-plan", "m", "zai/m", { context_window: 128000 }),
  ];
  const apiFirst = resolveModelPolicy(cfg({ sourcePriority: ["*/api_key", "*/subscription"] }), "m");
  const subFirst = resolveModelPolicy(cfg({ sourcePriority: ["*/subscription", "*/api_key"] }), "m");
  assert.equal(resolveMetadataChain(apiFirst, "m", "m", {}, records).fields.context_window, 64000);
  assert.equal(resolveMetadataChain(subFirst, "m", "m", {}, records).fields.context_window, 128000);
});

test("resolveMetadataChain: exact token before covering wildcard keeps one adoption", () => {
  const records = [dev("openai", "m", "openai/m", { context_window: 1, max_output_tokens: 5 })];
  const policy = resolveModelPolicy(cfg({ sourcePriority: ["models.dev/openai", "models.dev/*/api_key"] }), "m");
  const result = resolveMetadataChain(policy, "m", "m", {}, records);
  assert.equal(result.fields.context_window, 1);
  assert.equal(result.diagnostics.length, 0);
});

test("resolveMetadataChain: ambiguity-skip frees the dedupe slot for a later exact selector", () => {
  const records = [
    dev("a", "m", "x/m", { context_window: 1 }),
    dev("b", "m", "y/m", { context_window: 2 }),
    dev("openai", "m", "openai/m", { context_window: 3 }),
  ];
  const policy = resolveModelPolicy(
    cfg({ sourcePriority: ["models.dev/*/api_key", "models.dev/openai"] }),
    "m",
  );
  const result = resolveMetadataChain(policy, "m", "m", {}, records);
  // The wildcard group is ambiguous (a vs b; openai shares 'm' too so 3-way
  // would also be ambiguous). The later exact selector still resolves.
  assert.equal(result.fields.context_window, 3);
  assert.equal(result.diagnostics.some((d) => d.kind === "ambiguous"), true);
});

// --- 3.3 merge modes -------------------------------------------------------

test("mergeMetadata overwrite: external wins per field", () => {
  const merged = mergeMetadata({ context_window: 128000 }, { context_window: 1000000 }, false);
  assert.equal(merged.context_window, 1000000);
});

test("mergeMetadata fill-only: upstream wins where present, external fills gaps", () => {
  const merged = mergeMetadata(
    { context_window: 128000 },
    { context_window: 1000000, max_output_tokens: 8192 },
    true,
  );
  assert.equal(merged.context_window, 128000);
  assert.equal(merged.max_output_tokens, 8192);
});

test("mergeMetadata fill-only: aliases unified so context_length blocks context_window", () => {
  const merged = mergeMetadata({ context_length: 128000 }, { context_window: 1000000 }, true);
  assert.equal(merged.context_window, 128000);
});

test("mergeMetadata fill-only: invalid values count as missing; explicit empty effort list kept", () => {
  const merged = mergeMetadata(
    { context_window: 0, supported_reasoning_levels: [] },
    { context_window: 64000, supported_reasoning_levels: [{ effort: "low" }] },
    true,
  );
  assert.equal(merged.context_window, 64000);
  assert.deepEqual(merged.supported_reasoning_levels, []);
});

test("mergeMetadata fill-only: null upstream treated as missing", () => {
  const merged = mergeMetadata({ context_window: null }, { context_window: 64000 }, true);
  assert.equal(merged.context_window, 64000);
});

test("overlayMetadata: objects merge recursively, arrays replace, null preserves", () => {
  const out = overlayMetadata(
    { a: { x: 1, y: 2 }, list: [1], keep: "v" },
    { a: { y: 9, z: 3 }, list: [2, 3], keep: null },
  );
  assert.deepEqual(out, { a: { x: 1, y: 9, z: 3 }, list: [2, 3], keep: "v" });
});

test("normalizeFields: aliases collapse to canonical names", () => {
  const out = normalizeFields({ context_length: 5, context_window: 10, max_tokens: 100, display_name: "X" });
  assert.equal(out.context_window, 10);
  assert.equal(out.max_output_tokens, 100);
  assert.equal(out.name, "X");
});

test("resolveModelPolicy overrides order: global model < channel legacy < channel model", () => {
  const config = cfg({
    models: { "proxy/m": { overrides: { context_window: 1, a: "g" } } },
    channels: {
      proxy: {
        overrides: { m: { context_window: 2, b: "l" } },
        models: { m: { overrides: { context_window: 3 } } },
      },
    },
  });
  const resolver = createMetadataResolver(config, []);
  const fields = resolver("proxy/m", {});
  assert.equal(fields.context_window, 3);
  assert.equal(fields.a, "g");
  assert.equal(fields.b, "l");
});

test("createMetadataResolver + mapCatalog: fill-only sees real missing values before defaults", () => {
  // Upstream row carries no limits; external supplies 64000. Without the
  // defaults-last ordering the result would be the 128000 default, proving
  // the seam observes the true missing state.
  const config = cfg({
    fillMissingOnly: true,
    sourcePriority: ["models.dev/openai"],
  });
  const records = [dev("openai", "m", "openai/m", { context_window: 64000 })];
  const resolver = createMetadataResolver(config, records);
  const [model] = mapCatalog([{ id: "m" }], "https://gw.example", resolver);
  assert.equal(model?.contextWindow, 64000);
  // And with an upstream value present, fill-only keeps it.
  const [kept] = mapCatalog(
    [{ id: "m", context_window: 96000 }],
    "https://gw.example",
    resolver,
  );
  assert.equal(kept?.contextWindow, 96000);
});

test("createMetadataResolver: default overwrite mode lets external win; source_priority: [] disables lookups", () => {
  const records = [dev("openai", "m", "openai/m", { context_window: 1000000 })];
  const full = createMetadataResolver(cfg({ sourcePriority: ["models.dev/openai"] }), records);
  const [over] = mapCatalog([{ id: "m", context_window: 128000 }], "https://gw", full);
  assert.equal(over?.contextWindow, 1000000);
  const off = createMetadataResolver(cfg({ sourcePriority: [] }), records);
  const [untouched] = mapCatalog([{ id: "m", context_window: 128000 }], "https://gw", off);
  assert.equal(untouched?.contextWindow, 128000);
  assert.equal(neededSites(cfg({ sourcePriority: [] }), ["m"]).size, 0);
});

test("applyOverrides: protected identity fields cannot be overwritten", () => {
  const out = applyOverrides({ context_window: 1 }, { context_window: 2, id: "evil", slug: "evil" });
  assert.equal(out.context_window, 2);
  assert.equal(out.id, undefined);
  assert.equal(out.slug, undefined);
});

// --- 3.1-3.2 source fetch --------------------------------------------------

test("fetchMetadataSources: reads only needed endpoints, once each", async () => {
  const requests: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    requests.push(url);
    if (url.includes("modelparams")) {
      return Response.json({ models: [{ provider: "zai", model: "m", authType: "api_key" }] });
    }
    return Response.json({ p: { models: { m: { limit: { context: 1 } } } } });
  };
  try {
    const result = await fetchMetadataSources(new Set(["modelparams.dev"]));
    assert.equal(requests.length, 1);
    assert.equal(result.records[0]?.provider, "zai");
  } finally {
    globalThis.fetch = original;
  }
});

test("fetchMetadataSources: no Authorization or custom headers sent to sources", async () => {
  const original = globalThis.fetch;
  let seenHeaders: unknown;
  globalThis.fetch = async (_input, init) => {
    seenHeaders = init?.headers;
    return Response.json({ p: { models: {} } });
  };
  try {
    await fetchMetadataSources(new Set(["models.dev"]), undefined, { ...SOURCE_URLS, modelsDevFlat: "https://x/404" });
    assert.equal(seenHeaders, undefined);
  } finally {
    globalThis.fetch = original;
  }
});

test("fetchMetadataSources: failed site marked, other site still resolves", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (input) => {
    if (String(input).includes("modelparams")) {
      return Response.json({ models: [{ provider: "zai", model: "m", authType: "api_key" }] });
    }
    throw new Error("down");
  };
  try {
    const result = await fetchMetadataSources(new Set(["models.dev", "modelparams.dev"]));
    assert.equal(result.failed.has("models.dev"), true);
    assert.equal(result.failed.has("modelparams.dev"), false);
    assert.equal(result.records.length, 1);
  } finally {
    globalThis.fetch = original;
  }
});
