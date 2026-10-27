# pi-cliproxyapi-provider Codex Loader Analysis

## Findings

### High: runtime source patching cannot work in native Pi bundle

`/tmp/cliproxy-provider-inspect/extensions/codex-stream.ts:205-233` assumes `@earendil-works/pi-ai` has a resolvable physical package path. `loadCliproxyCodexStreams()` then reads and rewrites that file at lines 236-252.

Native Pi deliberately exposes bundled dependencies as Jiti module objects, not filesystem packages:

- `/home/xz/Code/ai/pi/packages/coding-agent/src/core/extensions/loader.ts:49-74` maps `@earendil-works/pi-ai` and `@earendil-works/pi-ai/compat` to `_bundledPiAiCompat` in `VIRTUAL_MODULES`.
- `/home/xz/Code/ai/pi/packages/coding-agent/src/core/extensions/loader.ts:456-464` uses those virtual modules for compiled Bun binaries.
- Jiti resolves a static import through this map, but `import.meta.resolve()` inside extension code does not resolve a virtual-module object to a source file. Bundle contains no stable physical `dist/api/openai-codex-responses.js` to read.

Adding more filesystem candidates, `createRequire()`, walking `process.execPath`, or adding the API subpath to `VIRTUAL_MODULES` does not repair source patching. A virtual module namespace is executable exports, not source text.

### High: current public adapter is loadable, but not configurable enough to replace all patches

Exact current public entrypoint:

```ts
import { openAICodexResponsesApi } from "@earendil-works/pi-ai/compat";

const { stream, streamSimple } = openAICodexResponsesApi();
```

Evidence:

- `/home/xz/Code/ai/pi/packages/ai/src/compat.ts:13-20` publicly re-exports lazy API factories.
- `/home/xz/Code/ai/pi/packages/ai/src/api/openai-codex-responses.lazy.ts:4` exports `openAICodexResponsesApi(): ProviderStreams`.
- Root `@earendil-works/pi-ai` is mapped to compat in native loader, so importing from either root or `/compat` reaches bundled implementation without filesystem resolution.

This entrypoint cannot yet express three CLIProxyAPI requirements:

1. Plain API keys: `/home/xz/Code/ai/pi/packages/ai/src/api/openai-codex-responses.ts:268-275,1746-1756` always parses a ChatGPT JWT and throws when account ID is absent.
2. Header omission: same file lines 1759-1775 always writes `chatgpt-account-id` after caller headers are merged, so `headers: { "chatgpt-account-id": null }` cannot suppress it.
3. Provider-independent Codex tool-call IDs: lines 62 and 673 use a closed provider-ID allowlist. `/home/xz/Code/ai/pi/packages/ai/src/api/openai-responses-shared.ts:138-164` otherwise strips the `call_id|fc_item_id` pair for an unlisted provider.

Transport is a fourth behavioral mismatch: lines 345-375 silently switch WebSocket to SSE before stream start. CLIProxyAPI's current patch intentionally retries and errors instead.

### Medium: existing regression test proves regex output, not runtime loading

`/tmp/cliproxy-provider-inspect/test/fast.test.ts:24-44` reads `node_modules/@earendil-works/pi-ai/dist/api/openai-codex-responses.js` directly. This guarantees test environment has the physical package whose absence causes production failure. It never invokes Pi's native Jiti loader or validates module availability from a compiled binary.

## Minimum Robust Fix

Preferred fix: stop source rewriting. Extend public `openAICodexResponsesApi()` factory with endpoint policy, then consume that factory from extension.

Suggested public contract:

```ts
export interface OpenAICodexResponsesApiOptions {
  accountId: "required" | "optional";
  preserveToolCallItemIds?: boolean;
}

export function openAICodexResponsesApi(
  options?: OpenAICodexResponsesApiOptions,
): ProviderStreams;
```

Required semantics:

- Default remains `{ accountId: "required" }` for official OpenAI Codex.
- `accountId: "optional"` returns `undefined` for non-JWT/plain keys and omits `chatgpt-account-id` entirely.
- `preserveToolCallItemIds: true` selects paired Responses IDs based on adapter capability, not mutable provider names.
- Make explicit `transport: "websocket"` fail closed after `maxRetries`; reserve WebSocket-to-SSE fallback for `transport: "auto"`. This uses existing public `StreamOptions.transport` and `maxRetries`, avoiding another factory option.

Extension then uses standard API identity and only wraps public streams:

```ts
const codex = openAICodexResponsesApi({
  accountId: "optional",
  preserveToolCallItemIds: true,
});

const streamSimple = wrapStreamSimpleForFast(
  (model, context, options) =>
    codex.streamSimple(model, context, {
      ...options,
      transport: "websocket",
      maxRetries: options?.maxRetries ?? 3,
    }),
  shouldUseFast,
);
```

Register models/provider with `api: "openai-codex-responses"`; delete custom `cliproxyapi-codex-responses` source replacement. Provider-level `streamSimple` already overrides dispatch at `/home/xz/Code/ai/pi/packages/coding-agent/src/core/provider-composer.ts:457-473`, so no global API registry mutation is needed.

This is smaller and more robust than exposing bundled source, adding resolver hooks, or vendoring Pi internals. It preserves host Pi protocol fixes because execution stays in host's bundled adapter.

## Extension-Only Alternative

If Pi public API cannot change, only robust extension-only option is a build-time bundled adapter owned by `pi-cliproxyapi-provider` (single distributable JS artifact, no runtime source lookup). Do not retain runtime regex patching.

Tradeoff: bundled adapter becomes a fork of Pi protocol code and no longer inherits host fixes automatically. It needs explicit Pi-version compatibility and update tests. Making `pi-ai` a regular runtime dependency only hides the immediate error while potentially patching a different adapter version than host Pi; not recommended.

## Regression Test Approach

1. Pi adapter tests:
   - Plain key + `accountId: "optional"` sends no `chatgpt-account-id` header.
   - Default factory still rejects token without ChatGPT account ID.
   - `preserveToolCallItemIds: true` retains `call_id|fc_item_id` for arbitrary provider ID.
   - Explicit `transport: "websocket"` exhausts configured retries, emits provider transport error, and makes zero SSE requests; `transport: "auto"` retains current fallback behavior.

2. Extension unit/integration tests:
   - Remove file-reading test at `test/fast.test.ts:24-44`.
   - Import `openAICodexResponsesApi` through public compat surface and assert wrapped stream options/payload policy.
   - Local mock gateway validates plain key, absent account header, Fast payload, paired tool-call replay, and no SSE fallback.

3. Native-binary black-box gate:
   - Build Pi Bun binary.
   - Use isolated agent dir containing packed `pi-cliproxyapi-provider` with no nested/top-level filesystem `@earendil-works/pi-ai`.
   - Start Pi with mock CLIProxyAPI config and assert provider/model loads without `Cannot resolve openai-codex-responses.js`.
   - Run one tool-call round trip through mock WebSocket gateway. Assert successful response, correct paired tool result, and no HTTP Responses/SSE request.

## Residual Risks

- Public factory change requires Pi release before extension can depend on it. Package should declare minimum compatible Pi version.
- Native Bun dynamic lazy import must be covered by compiled-binary test; Node/Vitest success alone is insufficient.
- Pi worktree contained unrelated pre-existing changes during inspection. No Pi or extension implementation source was modified by this assignment.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Concrete high/medium findings cite codex-stream.ts, Pi loader.ts, compat factory, Codex adapter, provider composer, and current test lines; report provides exact public export and regression plan."
    }
  ],
  "changedFiles": [
    "/home/xz/Code/ai/openai-api-extension/subagent-analysis.loader.md"
  ],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "source inspection with rg/sed/nl/read across pi-cliproxyapi-provider and Pi",
      "result": "passed",
      "summary": "Confirmed runtime file resolver, native Jiti virtual modules, public Codex factory, adapter limitations, dispatch seam, and test gap."
    },
    {
      "command": "git status --porcelain for inspected repositories",
      "result": "passed",
      "summary": "cliproxy inspection clone clean; Pi had unrelated pre-existing changes; no source edits made."
    }
  ],
  "validationOutput": [
    "Native loader maps @earendil-works/pi-ai to bundled compat module object at loader.ts:49-74 and uses virtualModules at loader.ts:456-464.",
    "Public openAICodexResponsesApi(): ProviderStreams exists and is re-exported from compat.",
    "Current adapter hard-requires JWT account ID, closed provider allowlist, and WebSocket-to-SSE fallback, so public factory needs narrow configuration before it can replace source patching."
  ],
  "residualRisks": [
    "Pi public factory extension must ship before extension migration.",
    "Compiled Bun binary E2E remains mandatory because Node test resolution differs."
  ],
  "noStagedFiles": true,
  "diffSummary": "Added read-only loader analysis report; no implementation source changed.",
  "reviewFindings": [
    "high: /tmp/cliproxy-provider-inspect/extensions/codex-stream.ts:205 - import.meta.resolve cannot resolve Pi native virtual modules to physical source, so runtime patch loader always fails when pi-ai is bundle-only.",
    "high: /home/xz/Code/ai/pi/packages/ai/src/api/openai-codex-responses.ts:274 - public stock adapter hard-requires ChatGPT JWT account ID and cannot serve plain CLIProxyAPI keys without a narrow public configuration seam.",
    "medium: /tmp/cliproxy-provider-inspect/test/fast.test.ts:24 - test requires physical node_modules pi-ai and cannot detect native bundle regression."
  ],
  "manualNotes": "Recommended route uses host-bundled public openAICodexResponsesApi and provider streamSimple override; do not add filesystem resolver heuristics."
}
```
