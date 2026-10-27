import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import {
  compileCatalog,
  externalFields,
  fieldIsMissing,
  type CompiledModel,
  type SourceTables,
} from "../src/model-metadata.ts";
import { matchCategories } from "../index.ts";

/**
 * Task 5.2: deterministic before/after replay. The same fixed public catalog
 * and source fixture are compiled once by the git-HEAD baseline compiler
 * (materialized read-only via `git show`, never a checkout) and once by the
 * current implementation; the capability-match categories are compared. The
 * fixture is self-contained — no gateway URLs, no credentials, no live
 * package data — so the comparison never depends on floating npm numbers.
 */

const CAPABILITY_KEYS = new Set([
  "context_window",
  "max_input_tokens",
  "max_output_tokens",
  "supported_reasoning_levels",
  "default_reasoning_level",
  "input_modalities",
  "output_modalities",
]);

type Category = "complete" | "partial" | "unmatched";

function categorize(model: CompiledModel): Category {
  const fields = externalFields(model);
  const hasCapability = Object.keys(fields).some(
    (key) => CAPABILITY_KEYS.has(key) && !fieldIsMissing(key, fields[key]),
  );
  if (!hasCapability) return "unmatched";
  return model.unresolved.length > 0 ? "partial" : "complete";
}

// --- fixed replay fixture ---------------------------------------------------
// A public gateway catalog with one model per recovery class and a dual-site
// source snapshot that exercises separator/case aliases, canonical renames,
// unified-only data, ambiguity and same-level conflicts.

const PUBLIC_IDS = [
  "gw/claude-fable-5-1", // separator alias -> anthropic creator + unified fill
  "gw/gpt-5-codex", // unified canonical table only (no provider record)
  "gw/deepseek-v4-flash-fast", // renamed source id -> canonical deepseek model
  "gw/gemini-3-1-pro", // same creator, two canonical models -> ambiguous remap; maker's own exact record still supplies fields
  "gw/conflict x", // same-level aliases with conflicting fields -> skipped
  "gw/orphan-9", // no source candidate at all
] as const;

const REPLAY_TABLES: SourceTables = {
  modelsDev: {
    providers: {
      anthropic: {
        models: {
          "claude-fable-5-1": {
            canonical_model_id: "anthropic/claude-fable-5-1",
            limit: { context: 1000000, output: 128000 },
          },
          "claude_fable_5.1": {
            canonical_model_id: "anthropic/claude-fable-5-1",
            limit: { context: 1000000, output: 128000 },
          },
        },
      },
      "llmgateway-providers": {
        models: {
          "anthropic/claude-fable-5-1": {
            canonical_model_id: "anthropic/claude-fable-5-1",
            limit: { context: 1, output: 1 },
          },
        },
      },
      deepseek: {
        models: {
          "deepseek-v4-flash": {
            canonical_model_id: "deepseek/deepseek-v4-flash",
            limit: { context: 131072, output: 32768 },
          },
        },
      },
      agg: {
        models: {
          "deepseek-v4-flash-fast": {
            canonical_model_id: "deepseek/deepseek-v4-flash",
            limit: { context: 5, output: 5 },
          },
        },
      },
      google: {
        models: {
          "gemini-3-1-pro": {
            canonical_model_id: "google/gemini-3-1-pro-preview",
            limit: { context: 10, output: 10 },
          },
        },
      },
      vertex: {
        models: {
          "gemini-3-1-pro": {
            canonical_model_id: "google/gemini-3-1-pro-customtools",
            limit: { context: 20, output: 20 },
          },
        },
      },
      acme: {
        models: {
          "conflict-x": {
            canonical_model_id: "acme/conflict-x",
            limit: { context: 100, output: 10 },
          },
          conflict_x: {
            canonical_model_id: "acme/conflict-x",
            limit: { context: 200, output: 20 },
          },
        },
      },
    },
    models: {
      "anthropic/claude-fable-5-1": {
        name: "Claude Fable 5.1",
        limit: { context: 1000000, input: 400000, output: 128000 },
      },
      "openai/gpt-5-codex": {
        name: "GPT-5 Codex",
        limit: { context: 400000, input: 272000, output: 128000 },
      },
      "deepseek/deepseek-v4-flash": {
        name: "DeepSeek V4 Flash",
        limit: { context: 131072, output: 32768 },
      },
    },
  },
  modelparams: {
    catalog: [
      {
        provider: "deepseek",
        authType: "api_key",
        model: "deepseek-v4-flash",
        params: [{ path: "context_window", range: { max: 64000 } }],
      },
      {
        provider: "acme",
        authType: "api_key",
        model: "conflict-x",
        params: [{ path: "context_window", range: { max: 500 } }],
      },
    ],
  },
  degraded: [],
};

// --- baseline compiler (git HEAD, materialized read-only) --------------------

const scratchDir = mkdtempSync(join(tmpdir(), "metadata-replay-"));
after(() => rmSync(scratchDir, { recursive: true, force: true }));

function baselineModulePath(): string {
  const file = join(scratchDir, "model-metadata-baseline.ts");
  writeFileSync(
    file,
    execFileSync("git", ["show", "HEAD:model-metadata.ts"], { encoding: "utf8" }),
  );
  return file;
}

test("replay fixture: every recoverable public id gains capability fields, not only a name", async () => {
  const baseline = (await import(baselineModulePath())) as {
    compileCatalog: typeof compileCatalog;
    externalFields: typeof externalFields;
  };
  const before = baseline.compileCatalog({ warnings: [] }, [...PUBLIC_IDS], REPLAY_TABLES);
  const after = compileCatalog({ warnings: [] }, [...PUBLIC_IDS], REPLAY_TABLES);

  const beforeById = new Map(before.models.map((m) => [m.publicId, m]));
  const afterById = new Map(after.models.map((m) => [m.publicId, m]));
  assert.equal(before.models.length, PUBLIC_IDS.length);
  assert.equal(after.models.length, PUBLIC_IDS.length);

  const capabilityOf = (
    fieldsFn: (m: { entries: { fields: Record<string, unknown> }[] }) => Record<string, unknown>,
    model: { entries: { fields: Record<string, unknown> }[] },
  ) => {
    const fields = fieldsFn(model as never);
    return Object.keys(fields).some(
      (key) => CAPABILITY_KEYS.has(key) && !fieldIsMissing(key, fields[key]),
    );
  };

  const comparison: Record<string, string> = {};
  for (const id of PUBLIC_IDS) {
    const oldModel = beforeById.get(id)!;
    const newModel = afterById.get(id)!;
    const beforeCap = capabilityOf(baseline.externalFields as never, oldModel as never);
    const newCap = capabilityOf(externalFields as never, newModel as never);
    comparison[id] = `${beforeCap ? "capability" : "none"} -> ${categorize(newModel)}`;
    // The new compiler may never lose a capability the baseline found —
    // except where the baseline merged an ambiguous identity the new
    // compiler correctly refuses to merge (same-creator multi-model or
    // same-level field conflicts are skipped, never silently adjudicated).
    const refused = (newModel.skippedEntries ?? []).length > 0;
    if (beforeCap && !refused) assert.equal(newCap, true, `${id}: capability regressed`);
    // Never capabilities from nothing recoverable: a model with no candidate
    // strings must not gain fields out of thin air.
    if (newModel.candidates.length === 0) assert.equal(newCap, false, `${id}: phantom capability`);
  }

  // Expected replay verdicts (recorded, not floating-count asserts):
  // - claude-fable-5-1: capability -> partial (modelparams creator unresolved)
  // - gpt-5-codex: none -> partial (unified canonical data; modelparams miss)
  // - deepseek-v4-flash-fast: capability -> complete (canonical rename + mp hit)
  // - gemini-3-1-pro: none -> partial (ambiguous remap blocked; maker's own
  //   exact record still supplies its own declared-canonical fields)
  // - conflict x: none -> partial (conflicting aliases skipped; mp recovers)
  // - orphan-9: none -> unmatched
  assert.equal(categorize(afterById.get("gw/claude-fable-5-1")!), "partial");
  assert.equal(categorize(afterById.get("gw/gpt-5-codex")!), "partial");
  assert.equal(categorize(afterById.get("gw/deepseek-v4-flash-fast")!), "complete");
  assert.equal(categorize(afterById.get("gw/gemini-3-1-pro")!), "partial");
  assert.equal(categorize(afterById.get("gw/conflict x")!), "partial");
  assert.equal(categorize(afterById.get("gw/orphan-9")!), "unmatched");

  const categories = matchCategories(after.models);
  assert.deepEqual(categories, { complete: 1, partial: 4, unmatched: 1, disabled: 0 });

  // The unified-only gpt-5-codex entry proves valid capability fields, and the
  // ambiguity/skip reasons stay diagnosable rather than silently dropped.
  const codex = afterById.get("gw/gpt-5-codex")!;
  const unifiedEntry = codex.entries.find((e) => e.site === "models.dev");
  assert.ok(unifiedEntry?.fields.context_window === 400000);
  assert.equal(unifiedEntry?.fieldSources?.context_window, "canonical");
  const gemini = afterById.get("gw/gemini-3-1-pro")!;
  assert.ok(gemini.skippedEntries?.some((s) => /multiple canonical models/.test(s.reason)));
  const conflict = afterById.get("gw/conflict x")!;
  assert.ok(conflict.skippedEntries?.some((s) => /conflicting same-level aliases/.test(s.reason)));
});
