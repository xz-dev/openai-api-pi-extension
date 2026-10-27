Workflow completed with 2 child run(s). Return: # Strict Codex Catalog Review

## Scope

Read-only review of current `openai-api-extension` complete Provider implementation at `4c81204`. Source files were not edited. During review, another writer modified `tests/map-models.test.ts`; those unstaged edits are treated as a concurrent candidate, not this review's work.

## Review Findings

### Blocker: ordinary `/models` endpoint cannot supply required capabilities

[index.ts](/home/xz/Code/ai/openai-api-extension/index.ts:89) currently requests `${baseUrl}/models` and parses only `payload.data`. Gateway's ordinary OpenAI-compatible catalog omits context/output limits, while Codex catalog is selected by `client_version` and returns `payload.models` entries keyed by `slug`.

Minimum fix:

- Import runtime `VERSION` from `@earendil-works/pi-coding-agent` alongside `ExtensionAPI`.
- Construct `/models?client_version=${VERSION}` with `URL`/`searchParams`, not string concatenation.
- Require top-level `{ models: [...] }`; reject `{ data: [.. Trace: 4 event(s).