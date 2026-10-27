/**
 * Guard: the compile Worker's static import graph must contain only relative
 * paths and `node:` builtins. Bare package specifiers (e.g. `yaml`,
 * `marked`, `@earendil-works/*`) do NOT resolve inside a Worker in the
 * Bun-compiled Pi host — this regressed real-host catalog refresh.
 * Data-package entry points are passed via workerData as absolute file
 * paths, not static imports, so they are out of scope here.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SPECIFIER_RE = /(?:import|export)\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']/g;

function specifiersOf(file: string): string[] {
  const source = readFileSync(file, "utf8");
  const out: string[] = [];
  for (const match of source.matchAll(SPECIFIER_RE)) {
    const spec = match[1] ?? match[2];
    if (spec) out.push(spec);
  }
  return out;
}

/** Walk the static import graph from an entry file; returns {bare, files}. */
function walkImportGraph(entry: string): { bare: { file: string; specifier: string }[]; files: string[] } {
  const seen = new Set<string>();
  const bare: { file: string; specifier: string }[] = [];
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of specifiersOf(file)) {
      if (spec.startsWith("node:") || spec.startsWith("bun:")) continue;
      if (spec.startsWith("./") || spec.startsWith("../") || spec.startsWith("/")) {
        queue.push(resolve(dirname(file), spec));
        continue;
      }
      bare.push({ file, specifier: spec });
    }
  }
  return { bare, files: [...seen] };
}

test("worker import graph: no bare package specifiers", () => {
  // Root: the .mjs entry statically imports the host-neutral body and the
  // compiler — the whole graph must stay relative + node: builtins.
  const roots = [join(ROOT, "metadata-compile-worker.mjs")];
  const bare: { file: string; specifier: string }[] = [];
  const files: string[] = [];
  for (const root of roots) {
    const walk = walkImportGraph(root);
    bare.push(...walk.bare);
    files.push(...walk.files);
  }
  assert.ok(files.some((f) => f.endsWith("model-metadata.ts")), "graph must include model-metadata.ts");
  assert.deepEqual(
    bare,
    [],
    `bare specifiers inside the worker graph: ${bare.map((b) => `${b.file}: ${b.specifier}`).join(", ")}`,
  );
});
