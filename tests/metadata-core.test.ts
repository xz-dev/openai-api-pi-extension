/**
 * The host-neutral compile entry: no Pi host imports anywhere in its static
 * graph, a non-Pi process can compile with a SourceTables file and its own
 * record source, and build-time tables equal a runtime package load.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, test } from "node:test";

import { buildSourceTables, parseMetadataConfig, runCompileWorker } from "../src/metadata-core.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKER = join(ROOT, "tests", "fixtures", "core-worker.mjs");
const SPECIFIER_RE = /(?:import|export)\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']/g;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "oapi-core-"));
  dirs.push(dir);
  return dir;
}

test("metadata-core static import graph has no Pi host package", () => {
  const seen = new Set<string>();
  const bare = new Set<string>();
  const queue = [join(ROOT, "src", "metadata-core.ts")];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const match of readFileSync(file, "utf8").matchAll(SPECIFIER_RE)) {
      const spec = match[1] ?? match[2];
      if (!spec || spec.startsWith("node:")) continue;
      if (spec.startsWith(".")) queue.push(resolve(dirname(file), spec));
      else bare.add(spec);
    }
  }
  assert.ok([...seen].some((file) => file.endsWith("metadata-worker.ts")), [...seen].join("\n"));
  assert.deepEqual([...bare].sort(), ["minimatch", "yaml"]);
  assert.ok(![...seen].some((file) => /metadata-(compile|packages)\.ts$|index\.ts$/.test(file)));
});

test("a process that refuses Pi packages compiles via tablesPath and a host record source", () => {
  const dir = scratch();
  const tablesPath = join(dir, "tables.json");
  writeFileSync(tablesPath, JSON.stringify({
    modelsDevVersion: "9.9.9",
    modelparamsVersion: "8.8.8",
    modelsDevGeneratedAt: "2026-01-02",
    degraded: [],
    modelparams: { catalog: [] },
    modelsDev: { providers: { anthropic: { models: { m: { limit: { context: 50000, output: 9000 } } } } }, models: {} },
  }));
  const script = join(dir, "host.mjs");
  writeFileSync(script, `
import { registerHooks } from "node:module";
registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith("@earendil-works/")) throw new Error("Pi import: " + specifier);
  return next(specifier, context);
} });
const core = await import(${JSON.stringify(pathToFileURL(join(ROOT, "src", "metadata-core.ts")).href)});
const config = core.parseMetadataConfigValue(
  { chain: ["@probe", "models.dev/anthropic/api_key"], include_models: ["**", "!hidden/**"] },
  { pathPrefix: "metadata", recordSources: ["@self", "@probe"] },
);
const selection = core.selectModels(config, ["m", "hidden/m"]);
const { catalog } = await core.runCompileWorker({
  workerFile: ${JSON.stringify(WORKER)}, config, publicIds: selection.kept, tablesPath: ${JSON.stringify(tablesPath)},
});
const fields = core.makeResolver(catalog, { "@probe": () => ({ context_window: 200000 }) }).resolve("m");
process.stdout.write(JSON.stringify({ hidden: selection.hidden, versions: catalog.dataVersions, plan: catalog.models[0].plan.map((n) => n.kind === "record" ? n.keyword : n.entry.entry), fields }));
`);
  const run = spawnSync(process.execPath, [script], { encoding: "utf8", timeout: 60_000, env: { ...process.env, NODE_OPTIONS: "" } });
  assert.equal(run.status, 0, run.stderr);
  const out = JSON.parse(run.stdout);
  assert.deepEqual(out.hidden, [{ id: "hidden/m", ruleIndex: 1, pattern: "!hidden/**" }]);
  assert.deepEqual(out.versions, { modelsDevVersion: "9.9.9", modelsDevGeneratedAt: "2026-01-02", modelparamsVersion: "8.8.8" });
  assert.deepEqual(out.plan, ["@probe", "models.dev/anthropic/api_key/m"]);
  assert.equal(out.fields.context_window, 200000);
  assert.equal(out.fields.max_output_tokens, 9000);
});

test("build-time SourceTables JSON compiles identically to a runtime package load", async () => {
  const modelsDevDir = join(ROOT, "node_modules", "@opencode-ai", "models");
  const modelparamsDir = join(ROOT, "node_modules", "modelparams");
  const modelsDevVersion = JSON.parse(readFileSync(join(modelsDevDir, "package.json"), "utf8")).version as string;
  const modelparamsVersion = JSON.parse(readFileSync(join(modelparamsDir, "package.json"), "utf8")).version as string;
  const modelsDevSnapshotPath = join(modelsDevDir, "dist", "snapshot.js");
  const modelparamsPath = join(modelparamsDir, "dist", "index.js");
  const tables = buildSourceTables({
    neededSites: ["models.dev", "modelparams.dev"],
    modelsDev: { module: await import(modelsDevSnapshotPath), version: modelsDevVersion },
    modelparams: { module: await import(modelparamsPath), version: modelparamsVersion },
  });
  assert.deepEqual(tables.degraded, []);
  const tablesPath = join(scratch(), "source-tables.json");
  writeFileSync(tablesPath, JSON.stringify(tables));

  const config = parseMetadataConfig('models:\n  - match: "**/glm-*"\n    chain: ["modelparams.dev/@creator/api_key", "@self"]\n');
  const publicIds = ["anthropic/claude-sonnet-4-5", "proxy/gpt-5-codex", "glm-5.1", "unknown-alias"];
  const fromFile = await runCompileWorker({ workerFile: WORKER, config, publicIds, tablesPath });
  const fromPackages = await runCompileWorker({
    workerFile: WORKER, config, publicIds, modelsDevSnapshotPath, modelparamsPath, modelsDevVersion, modelparamsVersion,
  });
  assert.deepEqual(fromFile.catalog.models, fromPackages.catalog.models);
  assert.deepEqual(fromFile.catalog.dataVersions, fromPackages.catalog.dataVersions);
  assert.deepEqual(fromFile.catalog.degraded, fromPackages.catalog.degraded);
  assert.equal(fromFile.catalog.dataVersions.modelsDevVersion, modelsDevVersion);
  assert.ok(fromFile.catalog.models.some((model) => model.entries.length > 0));
}, { timeout: 120_000 });

test("buildSourceTables: one bad models.dev shape degrades only that shape", () => {
  const tables = buildSourceTables({
    neededSites: ["models.dev", "modelparams.dev"],
    modelsDev: { module: { models: { "openai/x": { limit: { context: 1 } } }, generatedAt: "t" }, version: "1" },
    modelparams: { module: { CATALOG: "nope" }, version: "2" },
  });
  assert.deepEqual(tables.modelsDev, { models: { "openai/x": { limit: { context: 1 } } } });
  assert.equal(tables.modelsDevVersion, "1");
  assert.equal(tables.modelsDevGeneratedAt, "t");
  assert.equal(tables.modelparams, undefined);
  assert.deepEqual(tables.degraded, [
    { site: "models.dev", scope: "providers", reason: "snapshot did not expose a providers object" },
    { site: "modelparams.dev", reason: "modelparams did not export a CATALOG array" },
  ]);
});

test("buildSourceTables: unneeded sites are skipped without degradation", () => {
  const tables = buildSourceTables({ neededSites: [] });
  assert.deepEqual(tables, { modelsDev: undefined, modelparams: undefined, degraded: [] });
});
