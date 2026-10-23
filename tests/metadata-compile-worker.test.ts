/**
 * Exercises the REAL metadata-compile Worker under `node --test`: spawn,
 * fixture tables through the worker channel, real installed packages,
 * worker failure, and cancellation. The execArgv: [] spawn fix is what
 * makes these pass — inherited --inspect-port kills the worker otherwise.
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import {
  compileCatalogInWorker,
  neededSites,
} from "../metadata-compile.ts";
import {
  MetadataConfigError,
} from "../model-metadata.ts";
import { parseMetadataConfig } from "../metadata-config.ts";
import type { SourceTables } from "../model-metadata.ts";

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

test("neededSites: empty chains load nothing; per-site chains load only their site", () => {
  assert.equal(neededSites(parseMetadataConfig("chain: []"), ["m"]).size, 0);
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
  const rule = parseMetadataConfig("models:\n  - match: m\n    chain: []");
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

test("real Worker: empty chain never spawns and yields a no-entry catalog", async () => {
  agentDir(undefined);
  const { catalog, degraded } = await compileCatalogInWorker(
    parseMetadataConfig("chain: []"),
    ["anything"],
  );
  assert.equal(degraded.length, 0);
  assert.equal(catalog.models[0].entries.length, 0);
});
