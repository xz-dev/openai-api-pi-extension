/**
 * Worker body: imports the two metadata packages by explicit file path
 * (bare subpath imports do not resolve the extension's node_modules under
 * the Bun-compiled Pi host), rebuilds SourceTables, runs compileCatalog, and
 * posts back only the compiled result. The 6.9 MB snapshot and its object
 * graph die with this worker; the main thread never imports either package.
 */
import { parentPort, workerData } from "node:worker_threads";

const {
  config,
  publicIds,
  neededSites = ["models.dev", "modelparams.dev"],
  modelsDevSnapshotPath,
  modelparamsPath,
  modelsDevVersion,
  modelparamsVersion,
  compileModulePath,
  prescanDegraded,
} = workerData;

const degraded = [...(prescanDegraded ?? [])];
let tables = { degraded };

if (workerData.tablesPath) {
  // Fixture channel: read SourceTables JSON inside the worker so tests
  // exercise the real spawn + compile path with deterministic data.
  const { readFileSync } = await import("node:fs");
  tables = { ...JSON.parse(readFileSync(workerData.tablesPath, "utf8")), degraded };
  tables.degraded = [...(tables.degraded ?? []), ...degraded];
}

// Only load the sites the effective chains actually need.
try {
  if (workerData.tablesPath || !neededSites.includes("models.dev")) {
    // skipped
  } else if (!modelsDevSnapshotPath) throw new Error("@opencode-ai/models package not installed");
  else {
    const snapshot = await import(modelsDevSnapshotPath);
    if (snapshot && typeof snapshot.providers === "object" && snapshot.providers !== null) {
      tables.modelsDev = { providers: snapshot.providers };
      tables.modelsDevVersion = modelsDevVersion;
      tables.modelsDevGeneratedAt = typeof snapshot.generatedAt === "string" ? snapshot.generatedAt : undefined;
    } else {
      degraded.push({ site: "models.dev", reason: "snapshot did not expose a providers object" });
    }
  }
} catch (error) {
  if (neededSites.includes("models.dev")) {
    degraded.push({ site: "models.dev", reason: error instanceof Error ? error.message : String(error) });
  }
}

try {
  if (workerData.tablesPath || !neededSites.includes("modelparams.dev")) {
    // skipped
  } else if (!modelparamsPath) throw new Error("modelparams package not installed");
  else {
    const mp = await import(modelparamsPath);
    if (Array.isArray(mp?.CATALOG)) {
      tables.modelparams = { catalog: mp.CATALOG };
      tables.modelparamsVersion = modelparamsVersion;
    } else {
      degraded.push({ site: "modelparams.dev", reason: "modelparams did not export a CATALOG array" });
    }
  }
} catch (error) {
  if (neededSites.includes("modelparams.dev")) {
    degraded.push({ site: "modelparams.dev", reason: error instanceof Error ? error.message : String(error) });
  }
}

try {
  const module = await import(compileModulePath ?? "./model-metadata.ts");
  const catalog = module.compileCatalog(config, publicIds, tables);
  parentPort.postMessage({ ok: true, result: { catalog, degraded } });
} catch (error) {
  // Structured error so the main thread can rebuild the right error type.
  parentPort.postMessage({
    ok: false,
    error: {
      name: error instanceof Error ? error.name : "Error",
      path: error instanceof Error && "path" in error ? error.path : undefined,
      // `reason` is the unprefixed reason; the main thread re-prefixes when
      // rebuilding the typed error so the path isn't duplicated.
      message: error instanceof Error && "reason" in error ? error.reason : (error instanceof Error ? error.message : String(error)),
    },
  });
}
