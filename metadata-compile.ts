/**
 * Loads the local metadata packages inside a node:worker_threads Worker,
 * compiles the catalog there, and returns only the compiled result. The
 * worker imports the packages by explicit file path inside each package's
 * installed directory (bare subpath imports do not resolve the extension's
 * node_modules inside the Bun-compiled Pi worker), runs compileCatalog, and
 * is terminated so the ~6.9 MB snapshot never stays resident.
 *
 * Tests may inject `loadTables` to supply SourceTables directly (still inside
 * the real Worker when they pass a tables path — see fixtures) or to skip the
 * worker entirely by compiling in-process.
 */
import { Worker } from "node:worker_threads";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  compileCatalog,
  matchModelPattern,
  MetadataConfigError,
  type CompiledCatalog,
  type MetadataConfig,
  type SourceTables,
} from "./model-metadata.ts";

const require = createRequire(import.meta.url);
const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));

function packageDir(name: string): string {
  // Walk up like Node resolution: own node_modules, then parents.
  for (let dir = EXTENSION_DIR; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", name);
    try {
      require.resolve(join(candidate, "package.json"));
      return candidate;
    } catch {
      if (dirname(dir) === dir) break;
    }
  }
  throw new Error(`cannot locate ${name}`);
}

/** Reads the installed package versions for the compile record. */
function packageVersion(dir: string): string | undefined {
  try {
    return (require(join(dir, "package.json")) as { version?: string }).version;
  } catch {
    return undefined;
  }
}

export type CompileResult = {
  catalog: CompiledCatalog;
  /** Sites/shapes whose package data could not be loaded; those steps degrade. */
  degraded: { site: "models.dev" | "modelparams.dev"; reason: string; scope?: "providers" | "models" }[];
};

/** Test seam: supply SourceTables without loading the real packages. */
export type TablesLoader = (
  neededSites: ReadonlySet<"models.dev" | "modelparams.dev">,
  signal?: AbortSignal,
) => Promise<SourceTables>;

/** Per-call injection point; production passes nothing. */
export type CompileDeps = {
  /** In-process tables (no Worker). */
  loadTables?: TablesLoader;
  /** JSON file the Worker reads instead of the real packages. */
  tablesPath?: string;
  /** Module path the Worker imports instead of the installed models.dev
   * snapshot — exercises the real per-shape validation (test-only). */
  modelsDevSnapshotOverride?: string;
};

/** Which sites the effective chains need; `null` = nothing needed. */
export function neededSites(
  config: MetadataConfig,
  publicIds: readonly string[],
): Set<"models.dev" | "modelparams.dev"> {
  const sites = new Set<"models.dev" | "modelparams.dev">();
  if (config.chain === undefined && (config.models === undefined || config.models.length === 0)) {
    // Default chain applies to every model: both sites.
    sites.add("models.dev");
    sites.add("modelparams.dev");
    return sites;
  }
  const effectiveChains = publicIds.map((id) => effectiveChainFor(config, id));
  for (const chain of effectiveChains) {
    for (const entry of chain) {
      const site = entry.split("/", 1)[0];
      if (site === "models.dev" || site === "modelparams.dev") {
        sites.add(site);
      }
      // @creator resolution discovers canonical providers through the
      // models.dev namespace map even when the query site is modelparams.dev.
      if (entry.split("/")[1] === "@creator") sites.add("models.dev");
    }
  }
  return sites;
}

/** Root chain if defined, else default; then per-model rule layering. */
function effectiveChainFor(config: MetadataConfig, publicId: string): string[] {
  const root = config.chain ?? [
    "models.dev/@creator/api_key",
    "modelparams.dev/@creator/api_key",
  ];
  let chain: string[] | undefined;
  for (const rule of config.models ?? []) {
    if (!matchModelPattern(rule.match, publicId)) continue;
    if (rule.chain !== undefined) chain = rule.chain;
  }
  const expanded = (chain ?? root).flatMap((entry) =>
    entry === "@default" ? root : [entry],
  );
  return expanded;
}

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
  const sites = neededSites(config, publicIds);
  if (deps?.loadTables) {
    const tables = await deps.loadTables(sites, signal);
    const catalog = compileCatalog(config, publicIds, tables);
    return { catalog, degraded: tables.degraded ?? [] };
  }
  if (sites.size === 0) {
    const catalog = compileCatalog(config, publicIds, { degraded: [] });
    return { catalog, degraded: [] };
  }
  const degraded: { site: "models.dev" | "modelparams.dev"; reason: string; scope?: "providers" | "models" }[] = [];
  let modelsDevDir: string | undefined;
  let modelparamsDir: string | undefined;
  // With a tables file the worker reads fixture data instead of packages.
  const useFixture = deps?.tablesPath !== undefined;
  if (!useFixture && sites.has("models.dev")) {
    try {
      modelsDevDir = packageDir("@opencode-ai/models");
    } catch {
      degraded.push({ site: "models.dev", reason: "@opencode-ai/models package not installed" });
    }
  }
  if (!useFixture && sites.has("modelparams.dev")) {
    try {
      modelparamsDir = packageDir("modelparams");
    } catch {
      degraded.push({ site: "modelparams.dev", reason: "modelparams package not installed" });
    }
  }
  const workerFile = join(EXTENSION_DIR, "metadata-compile-worker.mjs");
  const tablesPath = deps?.tablesPath;
  const result = await new Promise<CompileResult>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const worker = new Worker(workerFile, {
      // Fresh argv: a `node --test` parent passes --inspect-port which the
      // worker cannot bind twice, and --test would put it in test-runner
      // mode. Type stripping for the .ts import is on by default, so the
      // worker needs no flags at all.
      execArgv: [],
      stderr: true,
      stdout: true,
      workerData: {
        config,
        publicIds,
        neededSites: [...sites],
        modelsDevSnapshotPath: modelsDevDir ? join(modelsDevDir, "dist", "snapshot.js") : undefined,
        modelsDevSnapshotOverride: deps?.modelsDevSnapshotOverride,
        modelparamsPath: modelparamsDir ? join(modelparamsDir, "dist", "index.js") : undefined,
        modelsDevVersion: modelsDevDir ? packageVersion(modelsDevDir) : undefined,
        modelparamsVersion: modelparamsDir ? packageVersion(modelparamsDir) : undefined,
        prescanDegraded: degraded,
        tablesPath,
        compileModulePath: join(EXTENSION_DIR, "model-metadata.ts"),
      },
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
    worker.once("message", (message: {
      ok?: boolean;
      result?: CompileResult;
      error?: { name?: string; path?: string; message?: string };
    }) => {
      finish(() => {
        // Our own terminate is normal; no exit handler runs as a rejection.
        worker.terminate().catch(() => undefined);
        if (message.ok && message.result) {
          resolve(message.result);
        } else {
          const e = message.error;
          if (e?.name === "MetadataConfigError") {
            reject(new MetadataConfigError(e.path ?? "openai-api-extension.yaml", e.message ?? "config error"));
          } else {
            reject(new Error(e?.message ?? "metadata compile worker failed"));
          }
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
  return result;
}
