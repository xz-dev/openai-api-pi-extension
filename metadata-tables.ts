/**
 * Builds SourceTables from the two loaded metadata data-package modules.
 * Each data shape is validated independently — the models.dev provider
 * records, the canonical-keyed unified model data, and the modelparams
 * catalog — so one bad shape degrades only the steps that need it. Shared by
 * the compile Worker (runtime package load) and hosts that pre-convert the
 * packages to a SourceTables JSON file at build time. Pure: no I/O, no
 * imports beyond types, so it is safe inside the Worker graph.
 */
import type { DegradedSource, MetadataSite, SourceTables } from "./model-metadata.ts";

/** One package after loading: the module namespace, or why it is unusable. */
export type LoadedPackage = { module: unknown; version?: string } | { error: string };

export type SourceTablesInput = {
  /** Sites the effective chains need; others are skipped without a degrade. */
  neededSites: readonly MetadataSite[];
  modelsDev?: LoadedPackage;
  modelparams?: LoadedPackage;
  /** Degraded entries found before loading (e.g. a missing install). */
  degraded?: readonly DegradedSource[];
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function buildSourceTables(input: SourceTablesInput): SourceTables {
  const degraded: DegradedSource[] = [...(input.degraded ?? [])];
  const tables: SourceTables = { modelsDev: undefined, modelparams: undefined, degraded };
  if (input.neededSites.includes("models.dev")) {
    const loaded = input.modelsDev ?? { error: "@opencode-ai/models package not installed" };
    if ("error" in loaded) {
      degraded.push({ site: "models.dev", reason: loaded.error });
    } else {
      const snapshot = loaded.module as Record<string, unknown> | undefined;
      // providers and models are validated independently: one bad shape must
      // not take down the other (provider records vs unified canonical data).
      const modelsDev: { providers?: unknown; models?: unknown } = {};
      let usable = false;
      if (snapshot && isPlainObject(snapshot.providers)) {
        modelsDev.providers = snapshot.providers;
        usable = true;
      } else {
        degraded.push({ site: "models.dev", scope: "providers", reason: "snapshot did not expose a providers object" });
      }
      if (snapshot && isPlainObject(snapshot.models)) {
        modelsDev.models = snapshot.models;
        usable = true;
      } else {
        degraded.push({ site: "models.dev", scope: "models", reason: "snapshot did not expose a models object" });
      }
      if (usable) {
        tables.modelsDev = modelsDev;
        tables.modelsDevVersion = loaded.version;
        tables.modelsDevGeneratedAt = typeof snapshot?.generatedAt === "string" ? snapshot.generatedAt : undefined;
      }
    }
  }
  if (input.neededSites.includes("modelparams.dev")) {
    const loaded = input.modelparams ?? { error: "modelparams package not installed" };
    if ("error" in loaded) {
      degraded.push({ site: "modelparams.dev", reason: loaded.error });
    } else {
      const mp = loaded.module as Record<string, unknown> | undefined;
      if (Array.isArray(mp?.CATALOG)) {
        tables.modelparams = { catalog: mp.CATALOG };
        tables.modelparamsVersion = loaded.version;
      } else {
        degraded.push({ site: "modelparams.dev", reason: "modelparams did not export a CATALOG array" });
      }
    }
  }
  return tables;
}
