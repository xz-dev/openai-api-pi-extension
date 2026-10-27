/**
 * Exercises the REAL metadata-compile Worker under `node --test`: spawn,
 * fixture tables through the worker channel, real installed packages,
 * worker failure, and cancellation. The execArgv: [] spawn fix is what
 * makes these pass — inherited --inspect-port kills the worker otherwise.
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import {
  compileCatalogInWorker,
  neededSites,
} from "../src/metadata-compile.ts";
import {
  MetadataConfigError,
} from "../src/model-metadata.ts";
import { parseMetadataConfig } from "../src/metadata-config.ts";
import type { SourceTables } from "../src/model-metadata.ts";
import { metadataRoot } from "../src/metadata-packages.ts";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function agentDir(yaml?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "oapi-worker-"));
  dirs.push(dir);
  if (yaml !== undefined) writeFileSync(join(dir, "openai-api-extension.yaml"), yaml);
  process.env.PI_CODING_AGENT_DIR = dir;
  return dir;
}

function activateFixture(agent: string, generation: string, version: string, context: number, delay = 0) {
  const root = metadataRoot(agent);
  for (const name of ["@opencode-ai/models", "modelparams"]) {
    const dir = join(root, "generations", generation, "node_modules", name);
    mkdirSync(join(dir, "dist"), { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version, type: "module" }));
    const models = name === "@opencode-ai/models";
    writeFileSync(join(dir, "dist", models ? "snapshot.js" : "index.js"), models
      ? `await new Promise(r => setTimeout(r, ${delay})); export const generatedAt = ${JSON.stringify(version)}; export const providers = {demo:{models:{m:{limit:{context:${context}}}}}}; export const models = {};`
      : "export const CATALOG = [];");
  }
  writeFileSync(join(root, "active.json"), JSON.stringify({ format: 1, generation,
    versions: { modelsDev: version, modelparams: version } }));
}

test("real Workers capture one active generation and see later activations in the same process", { timeout: 10_000 }, async () => {
  const agent = agentDir();
  const config = parseMetadataConfig('chain: ["models.dev/demo/api_key/m", "modelparams.dev/demo/api_key/m"]');
  activateFixture(agent, "first", "1.0.0", 11000, 100);
  const first = compileCatalogInWorker(config, ["m"], { agentDir: agent });
  activateFixture(agent, "second", "2.0.0", 22000);
  const second = await compileCatalogInWorker(config, ["m"], { agentDir: agent });
  const original = await first;
  assert.equal(original.catalog.dataVersions.modelsDevVersion, "1.0.0");
  assert.equal(original.catalog.models[0].entries[0].fields.context_window, 11000);
  assert.equal(second.catalog.dataVersions.modelsDevVersion, "2.0.0");
  assert.equal(second.catalog.dataVersions.modelparamsVersion, "2.0.0");
  assert.equal(second.catalog.models[0].entries[0].fields.context_window, 22000);
});

test("real Worker rejects broken active records as a whole and reports bundled fallback", { timeout: 10_000 }, async () => {
  const agent = agentDir();
  mkdirSync(metadataRoot(agent), { recursive: true });
  writeFileSync(join(metadataRoot(agent), "active.json"), "invalid JSON");
  const out = await compileCatalogInWorker(parseMetadataConfig(undefined), ["m"], { agentDir: agent });
  assert.match(out.catalog.sourceWarning ?? "", /active record/);
  assert.ok(out.catalog.dataVersions.modelsDevVersion);
  assert.ok(out.catalog.dataVersions.modelparamsVersion);
});

const CONFLICT_TABLES: SourceTables = {
  degraded: [],
  modelsDev: {
    providers: {
      anthropic: { models: { "shared-m": { id: "shared-m", canonical_model_id: "anthropic/shared-m" } } },
      openai: { models: { "shared-m": { id: "shared-m", canonical_model_id: "openai/shared-m" } } },
    },
  },
  modelparams: { catalog: [] },
};

test("neededSites: @self-only chains load nothing; per-site chains load only their site", () => {
  assert.equal(neededSites(parseMetadataConfig("chain: [\"@self\"]"), ["m"]).size, 0);
  assert.deepEqual(
    [...neededSites(parseMetadataConfig(undefined), ["m"])].sort(),
    ["modelparams.dev", "models.dev"],
  );
  // @creator discovery needs models.dev's canonical namespaces even when the
  // query site is modelparams.dev.
  assert.deepEqual(
    [...neededSites(parseMetadataConfig("chain: [\"modelparams.dev/@creator/api_key\"]"), ["m"])].sort(),
    ["modelparams.dev", "models.dev"],
  );
  assert.deepEqual(
    [...neededSites(parseMetadataConfig("chain: [\"modelparams.dev/z-ai/api_key\"]"), ["m"])],
    ["modelparams.dev"],
  );
  const rule = parseMetadataConfig("models:\n  - match: m\n    chain: [\"@self\"]");
  assert.equal(neededSites(rule, ["m"]).size, 0);
});

test("real Worker: compiles with the installed packages (execArgv fix)", async () => {
  agentDir(undefined);
  const { catalog } = await compileCatalogInWorker(
    parseMetadataConfig(undefined),
    ["anthropic/claude-sonnet-4-5"],
  );
  assert.equal(catalog.models.length, 1);
  assert.ok(catalog.dataVersions.modelsDevVersion, "models.dev package version recorded");
  assert.ok(catalog.dataVersions.modelparamsVersion, "modelparams package version recorded");
  const entries = catalog.models[0].entries.map((e) => e.entry);
  assert.ok(entries.some((e) => e.startsWith("models.dev/anthropic/api_key")), JSON.stringify(entries));
}, { timeout: 60_000 });

test("real Worker: fixture tables cross the worker channel", async () => {
  agentDir(undefined);
  const dir = dirs[0];
  const fixture = join(dir, "tables.json");
  writeFileSync(fixture, JSON.stringify(CONFLICT_TABLES));
  // Two different-canonical creators of one shared model id -> conflict error
  // must survive the worker boundary as MetadataConfigError.
  await assert.rejects(
    compileCatalogInWorker(parseMetadataConfig(undefined), ["x/shared-m"], { tablesPath: fixture }),
    (error: unknown) =>
      error instanceof MetadataConfigError &&
      /ambiguous @creator/.test((error as Error).message),
  );
}, { timeout: 60_000 });

test("real Worker: abort rejects and terminates the worker", async () => {
  agentDir(undefined);
  const controller = new AbortController();
  const pending = compileCatalogInWorker(
    parseMetadataConfig(undefined),
    ["anthropic/claude-sonnet-4-5"],
    undefined,
    controller.signal,
  );
  controller.abort();
  await assert.rejects(pending, (error: unknown) => (error as Error).name === "AbortError");
}, { timeout: 30_000 });

test("enrichCatalog: embedding model's conflicting creator cannot block chat models", async () => {
  const dir = agentDir(undefined);
  const fixture = join(dir, "tables.json");
  writeFileSync(fixture, JSON.stringify(CONFLICT_TABLES));
  const { enrichCatalog } = await import("../index.ts");
  const out = await enrichCatalog(
    [
      { id: "chat-ok", name: "chat-ok", type: "chat", context_window: 64000 },
      { id: "x/shared-m", name: "embed", type: "embedding" },
    ],
    "http://127.0.0.1:1/v1",
    undefined,
    { tablesPath: fixture },
  );
  assert.equal(out.models.length, 1);
  assert.equal(out.models[0].id, "chat-ok");
}, { timeout: 60_000 });

test("modelparams-only @creator chain resolves glm-5.1 through models.dev discovery", async () => {
  agentDir(undefined);
  const { catalog } = await compileCatalogInWorker(
    parseMetadataConfig("chain: [\"modelparams.dev/@creator/api_key\"]"),
    ["glm-5.1"],
  );
  const model = catalog.models[0];
  assert.equal(model.unresolved.length, 0, JSON.stringify(model.unresolved));
  assert.ok(
    model.entries.some((e) => e.entry.startsWith("modelparams.dev/z-ai/api_key")),
    JSON.stringify(model.entries.map((e) => e.entry)),
  );
}, { timeout: 60_000 });

test("real Worker: @self-only chain never spawns and yields an upstream-only catalog", async () => {
  agentDir(undefined);
  const { catalog, degraded } = await compileCatalogInWorker(
    parseMetadataConfig("chain: [\"@self\"]"),
    ["anything"],
  );
  assert.equal(degraded.length, 0);
  assert.equal(catalog.models[0].entries.length, 0);
  assert.deepEqual(catalog.models[0].plan, [{ kind: "record", keyword: "@self", modelId: "anything" }]);
});

// --- dual-shape models.dev data (fix-metadata-query-expansion, task 2.3) -----

const UNIFIED_ONLY_TABLES: SourceTables = {
  degraded: [],
  // No providers shape at all: only the unified canonical models table.
  modelsDev: {
    models: {
      "openai/gpt-5-codex": { name: "GPT-5 Codex", limit: { context: 400000, input: 272000, output: 128000 } },
    },
  },
  modelparams: { catalog: [] },
};

test("real Worker: canonical-only tables still enrich through the worker channel", async () => {
  const dir = agentDir(undefined);
  const fixture = join(dir, "tables.json");
  writeFileSync(fixture, JSON.stringify(UNIFIED_ONLY_TABLES));
  const { catalog } = await compileCatalogInWorker(
    parseMetadataConfig(undefined),
    ["gw/gpt-5-codex"],
    { tablesPath: fixture },
  );
  const model = catalog.models[0];
  const entry = model.entries.find((e) => e.site === "models.dev");
  assert.ok(entry, JSON.stringify(model));
  assert.equal(entry.entry, "models.dev/openai/api_key/gpt-5-codex");
  assert.equal(entry.fields.context_window, 400000);
  assert.equal(entry.fieldSources?.context_window, "canonical");
}, { timeout: 60_000 });

test("real Worker: providers shape missing degrades independently", async () => {
  const dir = agentDir(undefined);
  const fixture = join(dir, "tables.json");
  writeFileSync(fixture, JSON.stringify({
    ...UNIFIED_ONLY_TABLES,
    degraded: [{ site: "models.dev", reason: "providers shape invalid", scope: "providers" }],
  }));
  const { catalog } = await compileCatalogInWorker(
    parseMetadataConfig(undefined),
    ["gw/gpt-5-codex"],
    { tablesPath: fixture },
  );
  assert.ok(catalog.degraded.some((d) => d.site === "models.dev" && d.scope === "providers"));
  const entry = catalog.models[0].entries.find((e) => e.site === "models.dev");
  assert.ok(entry, "unified canonical data still enriches without providers");
  assert.equal(entry.fields.context_window, 400000);
}, { timeout: 60_000 });

test("real Worker: compiled result carries candidates and field provenance", async () => {
  const dir = agentDir(undefined);
  const fixture = join(dir, "tables.json");
  writeFileSync(fixture, JSON.stringify({
    degraded: [],
    modelsDev: {
      providers: {
        strictai: { models: { "cap-m": { canonical_model_id: "strictai/cap-m", limit: { context: 200000 } } } },
      },
      models: { "strictai/cap-m": { limit: { context: 1000000, output: 64000 } } },
    },
    modelparams: { catalog: [] },
  }));
  const { catalog } = await compileCatalogInWorker(
    parseMetadataConfig(undefined),
    ["gw/cap-m"],
    { tablesPath: fixture },
  );
  const model = catalog.models[0];
  const entry = model.entries.find((e) => e.site === "models.dev");
  assert.ok(entry);
  assert.equal(entry.fields.context_window, 200000);
  assert.equal(entry.fields.max_output_tokens, 64000);
  assert.equal(entry.fieldSources?.context_window, "provider");
  assert.equal(entry.fieldSources?.max_output_tokens, "canonical");
  assert.ok(model.candidates.some((c) => c.sourceId === "cap-m" && c.selected));
}, { timeout: 60_000 });

test("real Worker: array-valued providers/models are degraded via the module path", async () => {
  // A fake snapshot module exercises the REAL shape-validation path inside
  // the worker (tablesPath would bypass it). Array providers degrade while
  // the valid models shape still enriches, and vice versa.
  const dir = agentDir(undefined);
  const fixture = join(dir, "snapshot.mjs");
  writeFileSync(
    fixture,
    `export const generatedAt = "2026-10-24";\n` +
      `export const providers = [];\n` +
      `export const models = { "openai/gpt-5-codex": { name: "GPT-5 Codex", limit: { context: 400000, output: 128000 } } };\n`,
  );
  const { catalog, degraded } = await compileCatalogInWorker(
    parseMetadataConfig("chain: [\"models.dev/@creator/api_key\"]"),
    ["gw/gpt-5-codex"],
    { modelsDevSnapshotOverride: fixture },
  );
  assert.ok(
    catalog.degraded.some((d) => d.site === "models.dev" && d.scope === "providers"),
    JSON.stringify(catalog.degraded),
  );
  const entry = catalog.models[0].entries.find((e) => e.site === "models.dev");
  assert.ok(entry, "valid models shape stays usable when providers is an array");
  assert.equal(entry.fields.context_window, 400000);
  assert.equal(entry.fieldSources?.context_window, "canonical");

  // Inverse: valid providers + array models still use provider records.
  const fixture2 = join(dir, "snapshot2.mjs");
  writeFileSync(
    fixture2,
    `export const providers = { a: { models: { x: { canonical_model_id: "a/x", limit: { context: 42 } } } } };\n` +
      `export const models = [];\n`,
  );
  const { catalog: catalog2 } = await compileCatalogInWorker(
    parseMetadataConfig("chain: [\"models.dev/@creator/api_key\"]"),
    ["x"],
    { modelsDevSnapshotOverride: fixture2 },
  );
  assert.ok(catalog2.degraded.some((d) => d.site === "models.dev" && d.scope === "models"));
  const entry2 = catalog2.models[0].entries.find((e) => e.site === "models.dev");
  assert.ok(entry2, "provider records stay usable when models is an array");
  assert.equal(entry2.fields.context_window, 42);
  assert.equal(entry2.fieldSources?.context_window, "provider");
}, { timeout: 60_000 });
