/**
 * Pi adapter over the host-neutral compile entry (metadata-core.ts): resolves
 * the active local data packages under Pi's agent directory, then compiles in
 * the plugin's Worker (metadata-compile-worker.mjs), which imports the
 * packages by explicit file path (bare subpath imports do not resolve the
 * extension's node_modules inside the Bun-compiled Pi worker). Only the
 * compiled result returns; the ~6.9 MB snapshot never stays resident.
 *
 * Tests may inject `loadTables` to supply SourceTables directly (compiled
 * in-process) or `tablesPath` to feed a fixture through the real Worker.
 */
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { selectDataSource } from "./metadata-packages.ts";
import { fileURLToPath } from "node:url";
import { neededSites, runCompileWorker, type CompileResult } from "./metadata-core.ts";
import { matchRules } from "./metadata-glob.ts";
import {
  compileCatalog,
  type MetadataConfig,
  type SourceTables,
} from "./model-metadata.ts";

export { neededSites, type CompileResult } from "./metadata-core.ts";

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));

/** Test seam: supply SourceTables without loading the real packages. */
export type TablesLoader = (
  neededSites: ReadonlySet<"models.dev" | "modelparams.dev">,
  signal?: AbortSignal,
) => Promise<SourceTables>;

/** Per-call injection point; production passes nothing. */
export type CompileDeps = {
  /** Isolated agent data root (production uses Pi's public agent directory). */
  agentDir?: string;
  /** In-process tables (no Worker). */
  loadTables?: TablesLoader;
  /** JSON file the Worker reads instead of the real packages. */
  tablesPath?: string;
  /** Module path the Worker imports instead of the installed models.dev
   * snapshot — exercises the real per-shape validation (test-only). */
  modelsDevSnapshotOverride?: string;
};

/**
 * Compiles the catalog. With `loadTables` supplied (tests), tables come from
 * the loader; otherwise the real packages load inside a Worker and only the
 * compiled result crosses the thread boundary.
 */
export async function compileCatalogInWorker(
  config: MetadataConfig,
  publicIds: readonly string[],
  deps?: CompileDeps,
  signal?: AbortSignal,
): Promise<CompileResult> {
  signal?.throwIfAborted();
  const ruleMatches = matchRules(config, publicIds);
  const sites = neededSites(config, publicIds, ruleMatches);
  if (deps?.loadTables) {
    const tables = await deps.loadTables(sites, signal);
    const catalog = compileCatalog(config, publicIds, tables, ruleMatches);
    return { catalog, degraded: tables.degraded ?? [] };
  }
  if (sites.size === 0) {
    const catalog = compileCatalog(config, publicIds, { modelsDev: undefined, modelparams: undefined, degraded: [] }, ruleMatches);
    return { catalog, degraded: [] };
  }
  const degraded: CompileResult["degraded"] = [];
  // Capture both paths and versions once: a concurrent activation cannot
  // mix generations within this Worker.
  const useFixture = deps?.tablesPath !== undefined;
  const source = useFixture ? undefined : selectDataSource({ agentDir: deps?.agentDir ?? getAgentDir() });
  const modelsDevDir = sites.has("models.dev") ? source?.modelsDev?.dir : undefined;
  const modelparamsDir = sites.has("modelparams.dev") ? source?.modelparams?.dir : undefined;
  if (!useFixture && sites.has("models.dev") && !modelsDevDir) {
    degraded.push({ site: "models.dev", reason: "@opencode-ai/models package not installed" });
  }
  if (!useFixture && sites.has("modelparams.dev") && !modelparamsDir) {
    degraded.push({ site: "modelparams.dev", reason: "modelparams package not installed" });
  }
  const result = await runCompileWorker({
    workerFile: join(EXTENSION_DIR, "metadata-compile-worker.mjs"),
    config,
    publicIds,
    ruleMatches,
    neededSites: sites,
    tablesPath: deps?.tablesPath,
    modelsDevSnapshotPath: modelsDevDir ? join(modelsDevDir, "dist", "snapshot.js") : undefined,
    modelsDevSnapshotOverride: deps?.modelsDevSnapshotOverride,
    modelparamsPath: modelparamsDir ? join(modelparamsDir, "dist", "index.js") : undefined,
    modelsDevVersion: source?.modelsDev?.version,
    modelparamsVersion: source?.modelparams?.version,
    prescanDegraded: degraded,
    signal,
  });
  if (source?.warning) result.catalog.sourceWarning = source.warning;
  return result;
}
