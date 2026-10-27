/**
 * Compile Worker body as a plain function, so each host's Worker entry file
 * (the Pi plugin's metadata-compile-worker.mjs, or a host bundle) is a thin
 * wrapper. Imports the two metadata packages by explicit file path (bare
 * subpath imports do not resolve the extension's node_modules under the
 * Bun-compiled Pi host) or reads a pre-built SourceTables JSON, runs
 * compileCatalog, and returns only the compiled result. The ~6.9 MB snapshot
 * and its object graph die with the Worker.
 *
 * The static import graph must stay relative paths + node: builtins only.
 */
import { readFileSync } from "node:fs";

import { buildSourceTables, type LoadedPackage } from "./metadata-tables.ts";
import { compileCatalog, type CompiledCatalog, type DegradedSource, type MetadataConfig, type MetadataSite, type SourceTables } from "./model-metadata.ts";

export type CompileWorkerData = {
  config: MetadataConfig;
  publicIds: readonly string[];
  /** Host-computed `matchRules(config, publicIds)` (the Worker has no glob matcher). */
  ruleMatches?: readonly (readonly number[])[];
  neededSites?: readonly MetadataSite[];
  /** SourceTables JSON read instead of the packages (fixtures, build-time tables). */
  tablesPath?: string;
  modelsDevSnapshotPath?: string;
  /** Test seam: module path standing in for the installed snapshot module,
   * exercising the REAL shape validation without a pre-built tables file. */
  modelsDevSnapshotOverride?: string;
  modelparamsPath?: string;
  modelsDevVersion?: string;
  modelparamsVersion?: string;
  prescanDegraded?: readonly DegradedSource[];
};

export type CompileWorkerMessage =
  | { ok: true; result: { catalog: CompiledCatalog; degraded: DegradedSource[] } }
  | { ok: false; error: { name: string; path?: string; message: string } };

async function loadPackage(
  path: string | undefined,
  version: string | undefined,
  missing: string,
  override?: string,
): Promise<LoadedPackage> {
  if (!path) return { error: missing };
  try {
    return { module: await import(override ?? path), version };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export async function runCompileWorkerBody(data: CompileWorkerData): Promise<CompileWorkerMessage> {
  const neededSites = data.neededSites ?? ["models.dev", "modelparams.dev"];
  const prescan = [...(data.prescanDegraded ?? [])];
  let tables: SourceTables;
  if (data.tablesPath) {
    // Pre-built SourceTables: versions, snapshot time and degraded entries
    // travel inside the file and are recorded as-is.
    const fixture = JSON.parse(readFileSync(data.tablesPath, "utf8")) as SourceTables;
    tables = { ...fixture, degraded: [...(fixture.degraded ?? []), ...prescan] };
  } else {
    // Only load the sites the effective chains actually need.
    const modelsDev = neededSites.includes("models.dev")
      ? await loadPackage(data.modelsDevSnapshotPath, data.modelsDevVersion,
        "@opencode-ai/models package not installed", data.modelsDevSnapshotOverride)
      : undefined;
    const modelparams = neededSites.includes("modelparams.dev")
      ? await loadPackage(data.modelparamsPath, data.modelparamsVersion, "modelparams package not installed")
      : undefined;
    tables = buildSourceTables({ neededSites, modelsDev, modelparams, degraded: prescan });
  }
  try {
    const catalog = compileCatalog(data.config, data.publicIds, tables, data.ruleMatches);
    // A tables file's own degraded entries live in catalog.degraded; the
    // result list reports only what this load found.
    return { ok: true, result: { catalog, degraded: data.tablesPath ? prescan : tables.degraded } };
  } catch (error) {
    // Structured error so the host thread can rebuild the right error type.
    return {
      ok: false,
      error: {
        name: error instanceof Error ? error.name : "Error",
        path: error instanceof Error && "path" in error ? String(error.path) : undefined,
        // `reason` is the unprefixed reason; the host re-prefixes when
        // rebuilding the typed error so the path isn't duplicated.
        message: error instanceof Error && "reason" in error ? String(error.reason) : (error instanceof Error ? error.message : String(error)),
      },
    };
  }
}
