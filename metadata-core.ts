/**
 * Host-neutral metadata compile entry. Everything a host needs to parse the
 * shared config, select models, register record sources, compile in an
 * isolated Worker, resolve fields and pre-convert the data packages — with
 * no Pi host imports and no agent-directory lookup. The Pi plugin's
 * metadata-compile.ts is a thin adapter over this module; other hosts (the
 * AI-gateway models-enricher) bundle it together with their own Worker entry
 * that calls `runCompileWorkerBody`.
 */
import { Worker, type ResourceLimits } from "node:worker_threads";

import { matchRules } from "./metadata-glob.ts";
import type { CompileWorkerData, CompileWorkerMessage } from "./metadata-worker.ts";
import {
  compileCatalog,
  DEFAULT_CHAIN,
  MetadataConfigError,
  type CompiledCatalog,
  type DegradedSource,
  type MetadataConfig,
  type MetadataSite,
} from "./model-metadata.ts";

export { parseMetadataConfig, parseMetadataConfigValue, type MetadataConfigOptions } from "./metadata-config.ts";
export { compileModelPattern, matchRules, MODEL_GLOB_OPTIONS, modelGlobMatches, selectModels } from "./metadata-glob.ts";
export { buildSourceTables, type LoadedPackage, type SourceTablesInput } from "./metadata-tables.ts";
export { runCompileWorkerBody, type CompileWorkerData, type CompileWorkerMessage } from "./metadata-worker.ts";
export {
  classifyModelMatch,
  compileCatalog,
  DEFAULT_CHAIN,
  DEFAULT_RECORD_SOURCES,
  makeResolver,
  mergePatch,
  MetadataConfigError,
  normalizeFields,
  resolveChainFields,
  validateRecordSources,
  type CompiledCatalog,
  type CompiledModel,
  type CompiledPlanNode,
  type DegradedSource,
  type HiddenModel,
  type MetadataConfig,
  type MetadataFields,
  type MetadataSite,
  type ModelSelection,
  type RecordSourceProviders,
  type SourceTables,
} from "./model-metadata.ts";

export type CompileResult = {
  catalog: CompiledCatalog;
  /** Sites/shapes whose package data could not be loaded; those steps degrade. */
  degraded: DegradedSource[];
};

/** Root chain if defined, else the shared default; then per-model rule layering. */
function effectiveChainFor(config: MetadataConfig, matched: readonly number[]): string[] {
  const root = config.chain ?? DEFAULT_CHAIN;
  let chain: readonly string[] | undefined;
  for (const index of matched) {
    const rule = config.models![index];
    if (rule.chain !== undefined) chain = rule.chain;
  }
  return (chain ?? root).flatMap((entry) => (entry === "@default" ? root : [entry]));
}

/** Which sites the effective chains of `publicIds` need; empty = no data load. */
export function neededSites(
  config: MetadataConfig,
  publicIds: readonly string[],
  ruleMatches: readonly (readonly number[])[] = matchRules(config, publicIds),
): Set<MetadataSite> {
  const sites = new Set<MetadataSite>();
  // No model to compile (e.g. include_models hid all): load nothing.
  if (publicIds.length === 0) return sites;
  if (config.chain === undefined && (config.models === undefined || config.models.length === 0)) {
    // Default chain applies to every model: both sites.
    sites.add("models.dev");
    sites.add("modelparams.dev");
    return sites;
  }
  for (const matched of ruleMatches) {
    for (const entry of effectiveChainFor(config, matched)) {
      const site = entry.split("/", 1)[0];
      if (site === "models.dev" || site === "modelparams.dev") sites.add(site);
      // @creator resolution discovers canonical providers through the
      // models.dev namespace map even when the query site is modelparams.dev.
      if (entry.split("/")[1] === "@creator") sites.add("models.dev");
    }
  }
  return sites;
}

export type RunCompileWorkerOptions = {
  /** Worker entry file; it must post `await runCompileWorkerBody(workerData)`. */
  workerFile: string | URL;
  config: MetadataConfig;
  publicIds: readonly string[];
  /** Sites to load; defaults to `neededSites(config, publicIds)`. */
  neededSites?: ReadonlySet<MetadataSite>;
  /** Host-side `matchRules(config, publicIds)`; computed when omitted. */
  ruleMatches?: readonly (readonly number[])[];
  /** SourceTables JSON file read instead of the data packages. */
  tablesPath?: string;
  /** Explicit entry-file paths of the installed data packages. */
  modelsDevSnapshotPath?: string;
  modelparamsPath?: string;
  modelsDevVersion?: string;
  modelparamsVersion?: string;
  /** Degraded entries the host found before spawning (e.g. missing install). */
  prescanDegraded?: readonly DegradedSource[];
  /** Test seam: module path standing in for the installed snapshot module. */
  modelsDevSnapshotOverride?: string;
  resourceLimits?: ResourceLimits;
  signal?: AbortSignal;
};

/**
 * Compiles in a short-lived Worker and returns only the compiled result; the
 * Worker is terminated afterwards so the data tables never stay resident.
 * When no site is needed the compile runs in-process with empty tables.
 * Abort terminates the Worker and rejects with the signal's reason.
 */
export async function runCompileWorker(options: RunCompileWorkerOptions): Promise<CompileResult> {
  const { config, publicIds, signal } = options;
  signal?.throwIfAborted();
  const ruleMatches = options.ruleMatches ?? matchRules(config, publicIds);
  const sites = options.neededSites ?? neededSites(config, publicIds, ruleMatches);
  if (sites.size === 0 && options.tablesPath === undefined) {
    const empty = { modelsDev: undefined, modelparams: undefined, degraded: [] };
    return { catalog: compileCatalog(config, publicIds, empty, ruleMatches), degraded: [] };
  }
  const workerData: CompileWorkerData = {
    config,
    publicIds,
    ruleMatches,
    neededSites: [...sites],
    tablesPath: options.tablesPath,
    modelsDevSnapshotPath: options.modelsDevSnapshotPath,
    modelsDevSnapshotOverride: options.modelsDevSnapshotOverride,
    modelparamsPath: options.modelparamsPath,
    modelsDevVersion: options.modelsDevVersion,
    modelparamsVersion: options.modelparamsVersion,
    prescanDegraded: options.prescanDegraded,
  };
  return new Promise<CompileResult>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const worker = new Worker(options.workerFile, {
      // Fresh argv: a `node --test` parent passes --inspect-port which the
      // worker cannot bind twice, and --test would put it in test-runner
      // mode. Type stripping for .ts imports is on by default, so the
      // worker needs no flags at all.
      execArgv: [],
      stderr: true,
      stdout: true,
      resourceLimits: options.resourceLimits,
      workerData,
    });
    const stderrChunks: Buffer[] = [];
    worker.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    worker.stdout?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    const stderrDetail = () => Buffer.concat(stderrChunks).toString().trim().slice(0, 500);
    const onAbort = () => {
      const reason = signal?.reason;
      worker.terminate().finally(() => finish(() => reject(reason)));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    worker.once("message", (message: CompileWorkerMessage) => {
      finish(() => {
        // Our own terminate is normal; no exit handler runs as a rejection.
        worker.terminate().catch(() => undefined);
        if (message.ok) {
          resolve(message.result);
        } else if (message.error.name === "MetadataConfigError") {
          reject(new MetadataConfigError(message.error.path ?? "openai-api-extension.yaml", message.error.message));
        } else {
          reject(new Error(message.error.message || "metadata compile worker failed"));
        }
      });
    });
    worker.once("error", (error) => finish(() => reject(error)));
    worker.once("exit", (code) => {
      finish(() => {
        if (signal?.aborted) {
          reject(signal.reason);
        } else {
          const detail = stderrDetail();
          reject(new Error(`metadata compile worker exited with code ${code}${detail ? `: ${detail}` : ""}`));
        }
      });
    });
  });
}
