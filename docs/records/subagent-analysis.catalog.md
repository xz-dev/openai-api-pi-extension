# Strict Codex Catalog Review

## Scope

Read-only review of current `openai-api-extension` complete Provider implementation at `4c81204`. Source files were not edited. During review, another writer modified `tests/map-models.test.ts`; those unstaged edits are treated as a concurrent candidate, not this review's work.

## Review Findings

### Blocker: ordinary `/models` endpoint cannot supply required capabilities

[index.ts](/home/xz/Code/ai/openai-api-extension/index.ts:89) currently requests `${baseUrl}/models` and parses only `payload.data`. Gateway's ordinary OpenAI-compatible catalog omits context/output limits, while Codex catalog is selected by `client_version` and returns `payload.models` entries keyed by `slug`.

Minimum fix:

- Import runtime `VERSION` from `@earendil-works/pi-coding-agent` alongside `ExtensionAPI`.
- Construct `/models?client_version=${VERSION}` with `URL`/`searchParams`, not string concatenation.
- Require top-level `{ models: [...] }`; reject `{ data: [...] }`, missing `models`, non-array `models`, and empty arrays.
- Map `slug` to Pi model `id`. Optional `id` compatibility is harmless, but `slug` should be canonical/preferred for Codex manifest.

Do not use extension package version (`0.2.0`) for `client_version`. This query describes client capabilities; Pi's exported runtime `VERSION` is correct signal. Current concurrent test candidate expects `client_version=0.2.0`; change that expectation to imported Pi `VERSION`.

### Blocker: invented defaults publish false catalog data

[index.ts](/home/xz/Code/ai/openai-api-extension/index.ts:25) defines `DEFAULT_CONTEXT_WINDOW = 128000` and `DEFAULT_MAX_TOKENS = 16384`; [mapModel](/home/xz/Code/ai/openai-api-extension/index.ts:65) substitutes them when metadata is absent or invalid.

Minimum fix:

- Delete both constants.
- Resolve `contextWindow` only from positive finite upstream capability fields (`context_window`, optionally existing `context_length` alias).
- Resolve `maxTokens` only from positive finite upstream capability fields (`max_tokens`, optionally existing `max_output_tokens` / `max_completion_tokens` aliases).
- If either resolved value is absent, zero, negative, `NaN`, infinite, string-valued, or otherwise invalid, throw. Do not return a partially populated model and do not invent a number.

Aliases are not invented fallback values because they remain upstream-supplied metadata. Keeping them costs no new mechanism. Canonical Codex fields should remain `context_window` and `max_tokens`.

### Blocker: current row filtering permits partial catalog publication

[fetchModels](/home/xz/Code/ai/openai-api-extension/index.ts:89) uses `flatMap`; malformed entries are silently discarded while valid siblings are published. This violates atomic failure requirement.

Minimum fix:

- Replace filtering/`flatMap` with strict `map`.
- Any non-object row, missing/blank identity, or missing invalid capability limit must throw and abort whole fetch.
- Error should identify catalog/model index or safe model ID, but must never include base URL, Authorization value, or raw response body.
- Optionally reject duplicate slugs. Duplicate rejection is reasonable catalog validation but not required for minimum stated fix if Pi deterministically handles duplicates.

No `createOpenAIApiProvider` publication redesign is needed. [refreshModels](/home/xz/Code/ai/openai-api-extension/index.ts:195) calls `fetchModels` before `context.publish`; an exception therefore prevents persistence/update. Pi first restores `context.stored`, catches network-phase error, and keeps that restored catalog. `context.publish` itself generation-checks persistence plus in-memory update.

### High: tests currently encode obsolete fallback contract

[tests/map-models.test.ts](/home/xz/Code/ai/openai-api-extension/tests/map-models.test.ts:17) at `HEAD` asserts 128K/16K defaults. Replace it with strict validation cases:

- valid Codex row: `slug`, `display_name`, `context_window`, `max_tokens` maps exactly;
- missing context rejects;
- missing max output rejects;
- zero/negative/non-finite/string limits reject;
- invalid row/missing identity causes catalog failure, not silent omission;
- `fetchModels` requests `/models?client_version=<Pi VERSION>`;
- ordinary `{ data: [...] }` and malformed/empty `{ models: ... }` reject;
- mixed valid plus incomplete rows rejects whole fetch;
- existing HTTP error redaction assertion remains.

Current concurrent candidate test starts this conversion but needs two corrections: use Pi `VERSION`, not `0.2.0`, and cover mixed-row atomic rejection rather than only plain-shape rejection.

### High: Provider lifecycle lacks retained-catalog regression

[tests/provider-lifecycle.test.ts](/home/xz/Code/ai/openai-api-extension/tests/provider-lifecycle.test.ts:18) gateway helper currently serves ordinary `{ data: [{ id, context_window, max_output_tokens }] }`. Update helper to assert query path and serve Codex `{ models: [{ slug, context_window, max_tokens }] }`.

Add one public-seam regression using `createModels`, `InMemoryModelsStore`, and `createOpenAIApiProvider`:

1. Seed stored catalog with one known valid `old-model`.
2. Configure gateway to return one valid new model plus one row missing `context_window` or `max_tokens`.
3. Call `models.refresh()`.
4. Assert `result.errors` contains `openai-api-extension`.
5. Assert live catalog still contains only `old-model`.
6. Assert persisted store remains byte-for-byte/deep-equal to seeded entry and contains no new model.

This proves required behavior through Pi's complete Provider seam, including restore, error capture, and atomic non-publication.

### High: loader regression fixture must use real manifest shape

[tests/loader-regression.test.ts](/home/xz/Code/ai/openai-api-extension/tests/loader-regression.test.ts:44) currently expects `/v1/models` and returns a metadata-free ordinary row. Update `async factory publishes environment catalog before startup` to:

- assert `/v1/models?client_version=<encoded Pi VERSION>`;
- return `{ models: [{ slug: "loader-model", context_window: 64000, max_tokens: 8192 }] }`;
- retain assertion that model is available before startup.

Keep `async factory bounds discovery and degrades on failure`: startup with no prior catalog should register provider with zero models after strict discovery failure. This is “do not update/expose”, not numeric fallback.

### Medium: documentation promises prohibited behavior

[README.md](/home/xz/Code/ai/openai-api-extension/README.md:98) says ordinary `/v1/models` metadata is used and missing fields receive “sensible defaults”. Replace with:

- extension requests Codex-compatible manifest via `client_version`;
- every published model requires valid context and output limits;
- incomplete/invalid refresh fails without replacing Pi's last verified catalog;
- initial discovery failure exposes no models.

## Exact Symbols To Change

- `index.ts`: imports, `UpstreamModel`, remove `DEFAULT_CONTEXT_WINDOW`, remove `DEFAULT_MAX_TOKENS`, `mapModel`, `fetchModels`.
- `index.ts`: no behavioral change needed in `apiKeyAuth`, `createOpenAIApiProvider`, or default async factory beyond their inherited strict `fetchModels` behavior.
- `tests/map-models.test.ts`: replace fallback test; add URL/shape/strict whole-catalog cases.
- `tests/provider-lifecycle.test.ts`: update `gateway`; add retained-catalog atomic refresh test.
- `tests/loader-regression.test.ts`: update successful environment discovery fixture/path.
- `README.md`: replace fallback metadata contract.

## Edge Cases

- Base URL already has no query/hash because `normalizeBaseUrl` rejects both; still use `URL.searchParams` for correct encoding.
- `client_version` must be Pi runtime version, including downstream suffix if exported; do not hardcode test/package version.
- Abort during fetch must remain `AbortError`/aborted refresh and must not publish.
- Invalid JSON naturally rejects before publication; retain secret-safe outward messaging.
- Mixed catalog is failure even if most rows are valid.
- Empty `models` is failure; no old catalog means provider remains empty.
- A previous verified catalog remains usable after HTTP, JSON, shape, or row validation failure.
- Legacy persisted 128K/16K entries cannot be distinguished from legitimately upstream-supplied identical numbers. Current complete Provider implementation is new and current local store has no `openai-api-extension` entry, so no migration code is justified. If this version was externally released with persisted synthetic values, catalog provenance/versioning would be needed to invalidate them safely.
- Reasoning tiers and input modalities are outside requested fix. Do not add speculative mapping in same change.

## Validation Evidence

Baseline `npm test` passed 18/18 before implementation, confirming tests currently bless fallback behavior rather than catching bug. Source inspection confirmed Pi's `Models.refresh()` restores stored state before network phase and records thrown provider errors without replacing provider state.

Working tree was concurrently modified during review: unstaged `tests/map-models.test.ts`. No staged files were present when checked. Parent writer should preserve/reconcile those edits rather than overwrite blindly.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Concrete blocker/high/medium findings identify index.ts symbols, exact test files, atomic Provider behavior, minimum changes, and edge cases."
    }
  ],
  "changedFiles": [
    "subagent-analysis.catalog.md"
  ],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "npm test",
      "result": "passed",
      "summary": "Baseline suite passed 18/18; existing suite still asserts synthetic fallback behavior."
    },
    {
      "command": "git diff --stat; git diff --name-only; git status --porcelain=v1",
      "result": "passed",
      "summary": "Detected concurrent unstaged modification to tests/map-models.test.ts and no staged files."
    },
    {
      "command": "Serena symbol inspection for mapModel, fetchModels, createOpenAIApiProvider, apiKeyAuth, and default export",
      "result": "passed",
      "summary": "Confirmed strict validation belongs in fetchModels/mapModel and existing publish flow is already atomic."
    }
  ],
  "validationOutput": [
    "Current fetchModels requests plain /models and parses payload.data.",
    "Current mapModel invents 128000 contextWindow and 16384 maxTokens.",
    "Current refreshModels invokes context.publish only after fetchModels resolves.",
    "Pi Models.refresh restores stored catalog before network refresh and captures thrown errors."
  ],
  "residualRisks": [
    "Legacy persisted synthetic values are indistinguishable from identical legitimate upstream values without provenance/version metadata.",
    "Concurrent writer edits in tests/map-models.test.ts require reconciliation; current candidate wrongly expects extension version 0.2.0 as client_version."
  ],
  "noStagedFiles": true,
  "diffSummary": "Read-only source review; added requested analysis artifact only.",
  "reviewFindings": [
    "blocker: index.ts:89 - fetchModels requests ordinary catalog and cannot obtain Codex capability metadata.",
    "blocker: index.ts:25 - synthetic 128K/16K defaults publish false model limits.",
    "blocker: index.ts:100 - flatMap silently drops invalid rows and permits partial catalog publication.",
    "high: tests/provider-lifecycle.test.ts:18 - no regression proves failed incomplete refresh retains stored catalog atomically.",
    "high: tests/loader-regression.test.ts:44 - success fixture encodes ordinary metadata-free catalog contract.",
    "medium: README.md:98 - documentation promises prohibited fallback behavior."
  ],
  "manualNotes": "Use @earendil-works/pi-coding-agent VERSION for client_version. No source edits made by this subagent."
}
```
