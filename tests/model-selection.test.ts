/**
 * include_models selection, record-source registration and the Pi catalog
 * path that skips hidden models before compilation.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { parseMetadataConfig, parseMetadataConfigValue } from "../metadata-config.ts";
import { matchRules, selectModels } from "../metadata-glob.ts";
import { renderCompiledCatalog } from "../metadata-view.ts";
import {
  classifyModelMatch,
  compileCatalog,
  makeResolver,
  MetadataConfigError,
  type SourceTables,
} from "../model-metadata.ts";

const EMPTY: SourceTables = { modelsDev: { providers: {} }, modelparams: { catalog: [] }, degraded: [] };

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function configError(fn: () => unknown, path: RegExp, message?: RegExp) {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof MetadataConfigError, String(error));
    assert.match(error.path, path);
    if (message) assert.match(error.message, message);
    return true;
  });
}

// --- include_models ----------------------------------------------------------

test("include_models: absent keeps every model", () => {
  const selection = selectModels(parseMetadataConfig(undefined), ["a", "b/c"]);
  assert.deepEqual(selection, { kept: ["a", "b/c"], hidden: [] });
});

test("include_models: */** hides bare aliases", () => {
  const config = parseMetadataConfig('include_models: ["*/**"]');
  const selection = selectModels(config, ["claude", "proxy/claude", "proxy/a/b"]);
  assert.deepEqual(selection.kept, ["proxy/claude", "proxy/a/b"]);
  assert.deepEqual(selection.hidden, [{ id: "claude", ruleIndex: null }]);
});

test("include_models: the last matching entry decides", () => {
  const config = parseMetadataConfig('include_models: ["**", "!**/gpt-image-*", "codex/gpt-image-2"]');
  const selection = selectModels(config, ["codex/gpt-image-2", "codex/gpt-image-1", "gpt-image-1", "codex/gpt-5"]);
  assert.deepEqual(selection.kept, ["codex/gpt-image-2", "codex/gpt-5"]);
  assert.deepEqual(selection.hidden, [
    { id: "codex/gpt-image-1", ruleIndex: 1, pattern: "!**/gpt-image-*" },
    { id: "gpt-image-1", ruleIndex: 1, pattern: "!**/gpt-image-*" },
  ]);
});

test("include_models: an id no entry matches is hidden", () => {
  const selection = selectModels(parseMetadataConfig('include_models: ["proxy/**"]'), ["other/m"]);
  assert.deepEqual(selection, { kept: [], hidden: [{ id: "other/m", ruleIndex: null }] });
});

test("include_models: empty list, non-string, empty string and lone ! are config errors", () => {
  configError(() => parseMetadataConfig("include_models: []"), /^include_models$/, /omit `include_models`/);
  configError(() => parseMetadataConfig("include_models: [3]"), /^include_models\[0\]$/);
  configError(() => parseMetadataConfig('include_models: ["a", ""]'), /^include_models\[1\]$/);
  configError(() => parseMetadataConfig('include_models: ["!"]'), /^include_models\[0\]$/);
  configError(() => parseMetadataConfig('include_models: "**"'), /^include_models$/);
});

test("include_models is a known root key (no ignored-field warning)", () => {
  assert.deepEqual(parseMetadataConfig('include_models: ["**"]').warnings, []);
});

// --- nested config values (host-neutral entry) -------------------------------

test("parseMetadataConfigValue: nested block reports prefixed paths", () => {
  configError(
    () => parseMetadataConfigValue({ models: [{ match: "x", chain: [] }] }, { pathPrefix: "metadata" }),
    /^metadata\.models\[0\]\.chain$/,
  );
  configError(
    () => parseMetadataConfigValue({ include_models: [] }, { pathPrefix: "metadata" }),
    /^metadata\.include_models$/,
  );
  const ok = parseMetadataConfigValue({ chain: ["@self"], odd: 1 }, { pathPrefix: "metadata" });
  assert.deepEqual(ok.warnings, ["metadata.odd"]);
});

// --- record-source registry ----------------------------------------------------

test("record sources: unregistered keywords are config errors listing available ones", () => {
  for (const token of ["@cpa-upstream", "@selfie"]) {
    configError(
      () => parseMetadataConfig(`chain: ["${token}"]`),
      new RegExp(`^chain item "${token}"$`),
      /available: @self/,
    );
  }
  configError(
    () => parseMetadataConfig('models:\n  - match: m\n    chain: ["@probe"]'),
    /^models\[0\]\.chain item "@probe"$/,
    /available: @self/,
  );
});

test("record sources: reserved or malformed registrations are host errors", () => {
  for (const keyword of ["@creator", "@default", "@id", "self", "@Self", "@a_b"]) {
    assert.throws(
      () => parseMetadataConfig(undefined, { recordSources: [keyword] }),
      (error: unknown) => error instanceof TypeError && !(error instanceof MetadataConfigError),
      keyword,
    );
  }
});

test("record sources: default chain needs @self registered", () => {
  configError(() => parseMetadataConfig(undefined, { recordSources: ["@probe"] }), /built-in default/, /available: @probe/);
  assert.ok(parseMetadataConfig('chain: ["@probe"]', { recordSources: ["@probe"] }));
});

const PROBE_TABLES: SourceTables = {
  degraded: [],
  modelparams: { catalog: [] },
  modelsDev: {
    providers: { anthropic: { models: { m: { limit: { context: 50000, output: 9000 } } } } },
    models: {},
  },
};

function compileProbe(yaml: string, ids: readonly string[]) {
  const config = parseMetadataConfig(yaml, { recordSources: ["@self", "@probe"] });
  return compileCatalog(config, ids, PROBE_TABLES, matchRules(config, ids));
}

test("record sources: a host-registered @probe binds per model in chain order", () => {
  const compiled = compileProbe('chain: ["@probe", "@self"]', ["m"]);
  assert.deepEqual(compiled.models[0].plan, [
    { kind: "record", keyword: "@probe", modelId: "m" },
    { kind: "record", keyword: "@self", modelId: "m" },
  ]);
  const resolver = makeResolver(compiled, {
    "@probe": () => ({ context_window: 200000 }),
    "@self": () => ({ context_window: 128000, max_output_tokens: 64000 }),
  });
  const fields = resolver.resolve("m")!;
  assert.equal(fields.context_window, 200000);
  assert.equal(fields.max_output_tokens, 64000);
  // Record-only chains are "external chain disabled", never match failures.
  assert.equal(classifyModelMatch(compiled.models[0]), "disabled");
});

test("record sources: no record falls through; it is not an external miss", () => {
  const compiled = compileProbe('chain: ["@probe", "models.dev/anthropic/api_key"]', ["m"]);
  const fields = makeResolver(compiled, { "@probe": () => undefined }).resolve("m")!;
  assert.equal(fields.context_window, 50000);
  assert.deepEqual(compiled.models[0].unresolved, []);
  assert.equal(classifyModelMatch(compiled.models[0]), "complete");
});

test("record sources: a source absent from every chain is never called", () => {
  const compiled = compileProbe('chain: ["@self"]', ["m", "n"]);
  let probeCalls = 0;
  const resolver = makeResolver(compiled, {
    "@probe": () => {
      probeCalls += 1;
      return {};
    },
    "@self": () => ({ context_window: 1 }),
  });
  resolver.resolve("m");
  resolver.resolve("n");
  assert.equal(probeCalls, 0);
});

test("record sources: each keyword's row is read once per model", () => {
  const compiled = compileProbe('chain: ["@probe", "@self", "@probe"]', ["m"]);
  let calls = 0;
  makeResolver(compiled, { "@probe": () => (calls++, { context_window: 2 }), "@self": () => undefined }).resolve("m");
  assert.equal(calls, 1);
});

test("record sources: export labels non-@self nodes by keyword and model id", () => {
  const compiled = compileProbe('chain: ["models.dev/anthropic/api_key", "@probe"]', ["m"]);
  const text = renderCompiledCatalog(compiled);
  assert.match(text, /record:probe m -> /);
  const external = text.indexOf("models.dev/anthropic/api_key/m ->");
  assert.ok(external >= 0 && text.indexOf("record:probe m") > external);
  assert.match(text, /enabled 1, disabled 0/);
});

// --- Pi catalog path -----------------------------------------------------------

function agentDir(yaml: string): void {
  const dir = mkdtempSync(join(tmpdir(), "oapi-select-"));
  dirs.push(dir);
  writeFileSync(join(dir, "openai-api-extension.yaml"), yaml);
  process.env.PI_CODING_AGENT_DIR = dir;
}

test("enrichCatalog: hidden models never reach compilation and their rows are not read", async () => {
  // models.dev/@creator with conflicting creators would throw if the hidden
  // id were compiled; a getter detects any upstream capability read.
  const dir = mkdtempSync(join(tmpdir(), "oapi-select-tables-"));
  dirs.push(dir);
  const tablesPath = join(dir, "tables.json");
  writeFileSync(tablesPath, JSON.stringify({
    degraded: [],
    modelparams: { catalog: [] },
    modelsDev: {
      providers: {
        a: { models: { "shared-m": { canonical_model_id: "vendor-a/shared-m" } } },
        b: { models: { "shared-m": { canonical_model_id: "vendor-b/shared-m" } } },
      },
      models: {},
    },
  }));
  agentDir('include_models: ["**", "!x/**"]\n');
  let hiddenReads = 0;
  const hiddenRow = { id: "x/shared-m", name: "hidden", type: "chat" } as Record<string, unknown>;
  Object.defineProperty(hiddenRow, "context_window", { enumerable: true, get: () => (hiddenReads++, 1) });
  const { enrichCatalog } = await import("../index.ts");
  const out = await enrichCatalog(
    [{ id: "chat-ok", name: "chat-ok", type: "chat", context_window: 64000 }, hiddenRow],
    "http://127.0.0.1:1/v1",
    undefined,
    { tablesPath },
  );
  assert.deepEqual(out.models.map((model) => model.id), ["chat-ok"]);
  assert.equal(hiddenReads, 0);
  assert.deepEqual(out.warnings, []);
}, { timeout: 60_000 });

test("enrichCatalog: every model hidden publishes an empty catalog with a warning", async () => {
  agentDir('chain: ["@self"]\ninclude_models: ["nothing/**"]\n');
  const { enrichCatalog } = await import("../index.ts");
  const out = await enrichCatalog(
    [{ id: "a", type: "chat", context_window: 1 }, { id: "b/c", type: "chat", context_window: 1 }],
    "http://127.0.0.1:1/v1",
    undefined,
  );
  assert.deepEqual(out.models, []);
  assert.equal(out.warnings.length, 1);
  assert.match(out.warnings[0], /include_models hid all 2 models/);
  // Hidden models are absent from match statistics.
  assert.ok(!out.notes.some((note) => /metadata match:/.test(note)));
});

test("mapCompiledCatalog: no usable model without a selection still fails", async () => {
  const { mapCompiledCatalog } = await import("../index.ts");
  const compiled = compileCatalog({ warnings: [] }, [], EMPTY);
  assert.throws(() => mapCompiledCatalog([], "http://127.0.0.1:1/v1", compiled), /no usable models/);
});
