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
import { enrichCatalog, mapCatalog } from "../index.ts";

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

test("parseMetadataConfig: lookup_ids keys must be exact concrete sources", () => {
  // F4: wildcard or shorthand keys silently apply across many sources — they
  // are a config error, never a working mapping.
  const bad = (key) =>
    `models:\n  m:\n    lookup_ids:\n      "${key}": x`;
  for (const yaml of [
    bad("*/api_key"),
    bad("models.dev/o*"),
    bad("modelparams.dev/zai/*"),
    bad("modelparams.dev/zai"),
    bad("*/subscription"),
    bad("models.dev/openai/api_key"), // 3-segment models.dev key is not a source
  ]) {
    assert.throws(() => parseMetadataConfig(yaml), MetadataConfigError, yaml);
  }
  parseMetadataConfig(
    'models:\n  m:\n    lookup_ids:\n      "models.dev/openai": x\n      "modelparams.dev/zai/api_key": y\n',
  );
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

test("matchModelPattern: many stars cannot stall the matcher", () => {
  // Quality P1: generated regexes with greedy [\\s\\S]* backtrack
  // combinatorially. Literal-chunk matching must stay bounded.
  const longA = "a".repeat(45);
  const start = Date.now();
  assert.equal(matchModelPattern("*".repeat(12) + "b", longA), false);
  assert.equal(matchModelPattern("*a".repeat(12) + "b", longA), false);
  assert.equal(matchModelPattern("*".repeat(12), longA), true);
  assert.equal(matchModelPattern("*a*b*c", "axbyc"), true);
  assert.equal(matchModelPattern("ab*cd", "abcd"), true);
  assert.equal(matchModelPattern("ab*cd", "abc"), false); // prefix+suffix must not overlap
  assert.equal(matchModelPattern("ab*bc", "abc"), false);
  assert.equal(matchModelPattern("a*b", "a"), false);
  assert.equal(matchModelPattern("*a", "a"), true);
  assert.equal(matchModelPattern("a*", "a"), true);
  assert.ok(Date.now() - start < 500, "glob matching must stay bounded");
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
  // Literal assertion: the documented default is subscription first.
  assert.deepEqual([...policy.sourcePriority], ["*/subscription", "*/api_key"]);
  assert.deepEqual([...DEFAULT_SOURCE_PRIORITY], ["*/subscription", "*/api_key"]);
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

test("resolveSelectorSite: modelparams records are filtered by the selector's access type", () => {
  // P1-2: an exact modelparams.dev/<provider>/subscription token must never
  // adopt an api_key record that happens to appear first.
  const selector = parseSelector("modelparams.dev/openai/subscription");
  const policy = resolveModelPolicy(cfg(), "m");
  const mp = (authType: string, context: number): SourceRecord => ({
    site: "modelparams.dev",
    provider: "openai",
    modelId: "m",
    authType,
    fields: { context_window: context },
  });
  for (const order of [
    [mp("api_key", 64000), mp("subscription", 128000)],
    [mp("subscription", 128000), mp("api_key", 64000)],
  ]) {
    const result = resolveSelectorSite(selector, "modelparams.dev", "m", policy, {}, order);
    assert.equal(result.record?.fields.context_window, 128000, "api_key record must not satisfy a subscription selector");
  }
});

test("resolveSelectorSite: same provider+model duplicates are ambiguous unless field-identical", () => {
  // P1-5: modelparams.dev may repeat a provider/model across apiSurfaces;
  // without a unique identity the group must be skipped, not order-picked.
  const selector = parseSelector("modelparams.dev/openai/api_key");
  const policy = resolveModelPolicy(cfg(), "m");
  const mp = (context: number): SourceRecord => ({
    site: "modelparams.dev",
    provider: "openai",
    modelId: "m",
    authType: "api_key",
    fields: { context_window: context },
  });
  for (const order of [[mp(1), mp(2)], [mp(2), mp(1)]]) {
    const result = resolveSelectorSite(selector, "modelparams.dev", "m", policy, {}, order);
    assert.equal(result.record, undefined);
    assert.equal(result.diagnostic?.kind, "ambiguous");
  }
  const identical = resolveSelectorSite(selector, "modelparams.dev", "m", policy, {}, [mp(7), mp(7)]);
  assert.equal(identical.record?.fields.context_window, 7, "field-identical duplicates are one product");
});

test("resolveSelectorSite: a conflicting duplicate invalidates the whole site group", () => {
  // F1: provider a's apiSurface duplicates disagree — the selector must skip
  // the group entirely, not silently adopt provider b.
  const selector = parseSelector("*/api_key");
  const policy = resolveModelPolicy(cfg(), "m");
  const mp = (provider: string, context: number): SourceRecord => ({
    site: "modelparams.dev",
    provider,
    modelId: "m",
    authType: "api_key",
    fields: { context_window: context },
  });
  for (const order of [
    [mp("a", 100), mp("a", 200), mp("b", 300)],
    [mp("b", 300), mp("a", 100), mp("a", 200)],
  ]) {
    const result = resolveSelectorSite(selector, "modelparams.dev", "m", policy, {}, order);
    assert.equal(result.record, undefined, `order-dependent adoption of ${JSON.stringify(result.record?.fields)}`);
    assert.equal(result.diagnostic?.kind, "ambiguous");
  }
  // A later selector still resolves after the ambiguous group is skipped.
  const chain = resolveModelPolicy(
    cfg({ sourcePriority: ["*/api_key", "models.dev/openai"] }),
    "m",
  );
  const resolved = resolveMetadataChain(chain, "m", {}, [
    mp("a", 100),
    mp("a", 200),
    mp("b", 300),
    dev("openai", "m", "openai/m", { context_window: 64000 }),
  ]);
  assert.equal(resolved.fields.context_window, 64000);
  assert.ok(resolved.diagnostics.some((d) => d.kind === "ambiguous"));
});

test("resolveSelectorSite: case-folded duplicates collapse only within one canonical identity", () => {
  // F3: MODEL and Model under one provider are one case-folded identity.
  // Same canonical + identical fields → interchangeable duplicates. Same
  // canonical + conflicting fields → ambiguous. Differing canonicals →
  // distinct identities that must stay ambiguous, never collapse by fields.
  const selector = parseSelector("models.dev/openai");
  const policy = resolveModelPolicy(cfg(), "model");
  const rec = (id: string, context: number, canonical?: string) =>
    dev("openai", id, canonical, { context_window: context });
  const identical = resolveSelectorSite(selector, "models.dev", "model", policy, {}, [
    rec("MODEL", 100, "openai/model"),
    rec("Model", 100, "openai/model"),
  ]);
  assert.equal(identical.record?.fields.context_window, 100);
  const conflictingFields = resolveSelectorSite(selector, "models.dev", "model", policy, {}, [
    rec("MODEL", 100, "openai/model"),
    rec("Model", 200, "openai/model"),
  ]);
  assert.equal(conflictingFields.record, undefined);
  assert.equal(conflictingFields.diagnostic?.kind, "ambiguous");
  for (const order of [
    [rec("MODEL", 100, "openai/MODEL"), rec("Model", 100, "openai/Model")],
    [rec("Model", 100, "openai/Model"), rec("MODEL", 100, "openai/MODEL")],
  ]) {
    const distinct = resolveSelectorSite(selector, "models.dev", "model", policy, {}, order);
    assert.equal(distinct.record, undefined, "distinct canonicals must not collapse by identical fields");
    assert.equal(distinct.diagnostic?.kind, "ambiguous");
  }
});

test("resolveSelectorSite: creator arbitration stays deterministic under folded identities", () => {
  // F3 (order stability): relay + creator entries sharing one canonical must
  // resolve to the creator record regardless of record order.
  const selector = parseSelector("*/api_key");
  const policy = resolveModelPolicy(cfg(), "m");
  const relay = dev("relay", "m", "openai/m", { context_window: 200 });
  const creator = dev("openai", "m", "openai/m", { context_window: 200 });
  for (const order of [
    [relay, creator],
    [creator, relay],
  ]) {
    const result = resolveSelectorSite(selector, "models.dev", "m", policy, {}, order);
    assert.equal(result.record?.provider, "openai", "creator wins independent of order");
    assert.equal(result.record?.modelId, "m");
  }
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

test("resolveMetadataChain: lookup_ids keys match concrete expanded sources, including wildcards", () => {
  // P2-11: lookup_ids["models.dev/openai"] applies to any selector whose
  // expansion reaches that concrete source — wildcard and default chains too.
  const records = [dev("openai", "m-ga", "openai/m-ga", { context_window: 64000 })];
  const policy = resolveModelPolicy(
    cfg({ models: { m: { lookupIds: { "models.dev/openai": "m-ga" } } } }),
    "m",
  );
  const result = resolveMetadataChain(policy, "m", {}, records);
  assert.equal(result.fields.context_window, 64000, "default-chain wildcard must honor the concrete-source lookup id");

  // Same for modelparams.dev: the key includes the access segment.
  const mpRecords: SourceRecord[] = [{
    site: "modelparams.dev",
    provider: "zai",
    modelId: "m-ga",
    authType: "api_key",
    fields: { context_window: 32000 },
  }];
  const mpPolicy = resolveModelPolicy(
    cfg({ models: { m: { lookupIds: { "modelparams.dev/zai/api_key": "m-ga" } } } }),
    "m",
  );
  const mpResult = resolveMetadataChain(mpPolicy, "m", {}, mpRecords);
  assert.equal(mpResult.fields.context_window, 32000);

  // A non-matching concrete key must not leak across sources.
  const wrongKey = resolveModelPolicy(
    cfg({ models: { m: { lookupIds: { "models.dev/anthropic": "m-ga" } } } }),
    "m",
  );
  assert.equal(resolveMetadataChain(wrongKey, "m", {}, records).fields.context_window, undefined);
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
  const result = resolveMetadataChain(policy, "m", {}, records);
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
  assert.equal(resolveMetadataChain(apiFirst, "m", {}, records).fields.context_window, 64000);
  assert.equal(resolveMetadataChain(subFirst, "m", {}, records).fields.context_window, 128000);
});

test("resolveMetadataChain: exact token before covering wildcard keeps one adoption", () => {
  const records = [dev("openai", "m", "openai/m", { context_window: 1, max_output_tokens: 5 })];
  const policy = resolveModelPolicy(cfg({ sourcePriority: ["models.dev/openai", "models.dev/*/api_key"] }), "m");
  const result = resolveMetadataChain(policy, "m", {}, records);
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
  const result = resolveMetadataChain(policy, "m", {}, records);
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

test("normalizeFields: invalid values drop and the first valid alias wins", () => {
  // P2-10/P1-4: an invalid preferred alias must not shadow a valid fallback,
  // and invalid values must never enter merged metadata at all.
  const out = normalizeFields({ context_window: "oops", context_length: 96000, max_tokens: 0 });
  assert.equal(out.context_window, 96000);
  assert.equal(out.max_output_tokens, undefined);
});

test("mergeMetadata overwrite: invalid external values never overwrite valid upstream", () => {
  // P1-4: an out-of-range external limit must behave as absent, not win.
  const merged = mergeMetadata({ context_window: 96000 }, { context_window: 0 }, false);
  assert.equal(merged.context_window, 96000);
  const viaCatalog = mapCatalog(
    [{ id: "m", context_window: 96000 }],
    "https://gw",
    createMetadataResolver(cfg({ sourcePriority: ["models.dev/openai"] }), [
      dev("openai", "m", "openai/m", { context_window: 0 }),
    ]).resolve,
  );
  assert.equal(viaCatalog[0]?.contextWindow, 96000);
});

test("mergeMetadata fill-only: upstream capabilities.effort_tiers counts as declared reasoning levels", () => {
  // P2-8: upstream effort_tiers: [] means "no tiers"; fill must not conjure any.
  const merged = mergeMetadata(
    { capabilities: { effort_tiers: [] } },
    { supported_reasoning_levels: [{ effort: "high" }] },
    true,
  );
  assert.deepEqual(merged.supported_reasoning_levels, []);
  const viaCatalog = mapCatalog(
    [{ id: "m", capabilities: { effort_tiers: [] } }],
    "https://gw",
    createMetadataResolver(cfg({ sourcePriority: ["models.dev/openai"], fillMissingOnly: true }), [
      dev("openai", "m", "openai/m", { supported_reasoning_levels: [{ effort: "high" }] }),
    ]).resolve,
  );
  assert.equal(viaCatalog[0]?.reasoning, false);
});

test("mergeMetadata fill-only: invalid upstream values count as missing", () => {
  // P2-9: a field-validation-failing upstream value is missing for fill mode.
  const merged = mergeMetadata(
    { input_modalities: 42 },
    { input_modalities: ["text", "image"] },
    true,
  );
  assert.deepEqual(merged.input_modalities, ["text", "image"]);
  const viaCatalog = mapCatalog(
    [{ id: "m", input_modalities: 42 }],
    "https://gw",
    createMetadataResolver(cfg({ sourcePriority: ["models.dev/openai"], fillMissingOnly: true }), [
      dev("openai", "m", "openai/m", { input_modalities: ["text", "image"] }),
    ]).resolve,
  );
  assert.deepEqual(viaCatalog[0]?.input, ["text", "image"]);
});

test("applyOverrides: override keys are alias-normalized before applying", () => {
  // P2-7: context_length must hit the canonical context_window field.
  const out = applyOverrides({ context_window: 128000 }, { context_length: 64000 });
  assert.equal(out.context_window, 64000);
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
  const fields = resolver.resolve("proxy/m", {});
  assert.equal(fields.context_window, 3);
  assert.equal(fields.a, "g");
  assert.equal(fields.b, "l");
});

test("resolveModelPolicy overrides: lower-scope canonical never beats higher-scope alias", () => {
  // F2: global model context_window must lose to channel-model context_length.
  const config = cfg({
    models: { "proxy/m": { overrides: { context_window: 96000 } } },
    channels: {
      proxy: {
        overrides: { m: { context_length: 64000 } },
        models: { m: { overrides: { context_length: 32000 } } },
      },
    },
  });
  const resolver = createMetadataResolver(config, []);
  assert.equal(resolver.resolve("proxy/m", {}).context_window, 32000);

  const legacyOnly = cfg({
    models: { "proxy/m": { overrides: { context_window: 96000 } } },
    channels: { proxy: { overrides: { m: { context_length: 64000 } } } },
  });
  assert.equal(createMetadataResolver(legacyOnly, []).resolve("proxy/m", {}).context_window, 64000);
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
  const [model] = mapCatalog([{ id: "m" }], "https://gw.example", resolver.resolve);
  assert.equal(model?.contextWindow, 64000);
  // And with an upstream value present, fill-only keeps it.
  const [kept] = mapCatalog(
    [{ id: "m", context_window: 96000 }],
    "https://gw.example",
    resolver.resolve,
  );
  assert.equal(kept?.contextWindow, 96000);
});

test("createMetadataResolver: default overwrite mode lets external win; source_priority: [] disables lookups", () => {
  const records = [dev("openai", "m", "openai/m", { context_window: 1000000 })];
  const full = createMetadataResolver(cfg({ sourcePriority: ["models.dev/openai"] }), records);
  const [over] = mapCatalog([{ id: "m", context_window: 128000 }], "https://gw", full.resolve);
  assert.equal(over?.contextWindow, 1000000);
  const off = createMetadataResolver(cfg({ sourcePriority: [] }), records);
  const [untouched] = mapCatalog([{ id: "m", context_window: 128000 }], "https://gw", off.resolve);
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

test("fetchMetadataSources: 16 MiB cap counts bytes and cancels oversized streams early", async () => {
  // P1-3: the cap is on bytes, not characters, and the reader stops as soon
  // as the cap is exceeded instead of draining the stream.
  const original = globalThis.fetch;
  try {
    const big = "é".repeat(9_500_000); // ~19 MiB of UTF-8 in ~9.5M chars
    globalThis.fetch = async (input) =>
      String(input) === SOURCE_URLS.modelsDevApi
        ? new Response(JSON.stringify({ p: { models: { x: { name: big } } } }))
        : Response.json({});
    let result = await fetchMetadataSources(new Set(["models.dev"]));
    assert.equal(result.failed.has("models.dev"), true, "multi-byte payload over 16 MiB must fail");
    assert.equal(result.records.length, 0);

    let consumed = 0;
    const chunk = new Uint8Array(1024 * 1024).fill(32);
    globalThis.fetch = async (input) =>
      String(input) === SOURCE_URLS.modelsDevApi
        ? new Response(
            new ReadableStream({
              pull(controller) {
                if (consumed === 20) {
                  controller.close();
                  return;
                }
                consumed++;
                controller.enqueue(chunk);
              },
            }),
          )
        : Response.json({});
    result = await fetchMetadataSources(new Set(["models.dev"]));
    assert.equal(result.failed.has("models.dev"), true);
    assert.ok(consumed <= 18, `stream must stop at the cap, consumed ${consumed} MiB`);
  } finally {
    globalThis.fetch = original;
  }
});

test("fetchMetadataSources: caller abort propagates instead of degrading to a source failure", async () => {
  // P1-1: an aborted caller signal must not be reported as a failed source.
  const original = globalThis.fetch;
  const controller = new AbortController();
  globalThis.fetch = async (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal as AbortSignal;
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  try {
    const pending = fetchMetadataSources(new Set(["models.dev", "modelparams.dev"]), controller.signal);
    controller.abort();
    await assert.rejects(pending);
  } finally {
    globalThis.fetch = original;
  }
});

test("enrichCatalog: malformed source payloads and ambiguity skips are reported in notes", async () => {
  // P2-6: degradation must be visible, not silent.
  const original = globalThis.fetch;
  const savedDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = "/definitely-not-present";
  try {
    globalThis.fetch = async () => Response.json({ unexpected: "not a source schema" });
    let result = await enrichCatalog([{ id: "m" }], "https://gw", undefined);
    assert.ok(
      result.notes.some((note) => /models\.dev/.test(note) && /unavailable|no usable|invalid/i.test(note)),
      `expected a degradation note, got ${JSON.stringify(result.notes)}`,
    );

    globalThis.fetch = async (input) =>
      String(input) === SOURCE_URLS.modelsDevApi
        ? Response.json({ a: { models: { m: { limit: { context: 1 } } } }, b: { models: { m: { limit: { context: 2 } } } } })
        : Response.json({});
    result = await enrichCatalog([{ id: "m" }], "https://gw", undefined);
    assert.ok(
      result.notes.some((note) => /ambig/i.test(note)),
      `expected an ambiguity note, got ${JSON.stringify(result.notes)}`,
    );
  } finally {
    globalThis.fetch = original;
    if (savedDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = savedDir;
  }
});

test("fetchMetadataSources: invalid api.json values do not block valid flat fields", async () => {
  // F5: api.json wins on a valid value; an invalid api.json field is missing
  // so the flat record fills it — the published limit must not fall back to
  // the final default.
  const original = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url === SOURCE_URLS.modelsDevApi) {
      return Response.json({ openai: { models: { m: { limit: { context: 0 } } } } });
    }
    if (url === SOURCE_URLS.modelsDevFlat) {
      return Response.json({ "openai/m": { limit: { context: 64000 } } });
    }
    return Response.json({ models: [] });
  };
  try {
    const result = await fetchMetadataSources(new Set(["models.dev"]));
    const record = result.records.find((item) => item.provider === "openai" && item.modelId === "m");
    assert.equal(record?.fields.context_window, 64000, "flat fills an invalid api value");
  } finally {
    globalThis.fetch = original;
  }
});

test("enrichCatalog: caller deadline inside the source phase degrades to upstream, never drops the catalog", async () => {
  // Startup prefetch shares one CONNECTION_TIMEOUT budget between the gateway
  // /models read and the source reads; a slow metadata host must degrade, not
  // fail an already-verified gateway catalog.
  const original = globalThis.fetch;
  const savedDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = "/definitely-not-present";
  const controller = new AbortController();
  globalThis.fetch = async (input, init) => {
    if (String(input) === SOURCE_URLS.modelsDevApi) {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) reject(signal.reason);
        else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }
    return Response.json({});
  };
  try {
    const pending = enrichCatalog([{ id: "m", context_window: 96000 }], "https://gw", controller.signal);
    // Let the config read finish so the abort lands inside the source phase.
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    const result = await pending;
    assert.equal(result.models[0]?.contextWindow, 96000, "upstream values survive a source-phase abort");
    assert.ok(
      result.notes.some((note) => /timed out|unavailable/i.test(note)),
      `expected a degradation note, got ${JSON.stringify(result.notes)}`,
    );
  } finally {
    globalThis.fetch = original;
    if (savedDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = savedDir;
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
