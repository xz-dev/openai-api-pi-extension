# Development

## Setup and verification

```text
npm install --ignore-scripts
npm test        # node:test provider lifecycle, loader, and transport tests
npm run check   # node --check plus the full test suite
```

For older development dependencies, see the
[test-only host-helper setup](request-compression.md#checks-and-development).

## Implementation entry points

`index.ts` stays at the repository root as the Pi extension entry
(`package.json` `pi.extensions`); every other source file lives in `src/`.
Analysis drafts are kept in [`records/`](records/).

- [`index.ts`](../index.ts) — provider entry: registration, `/login`,
  `/provider-info`, `/provider-metadata`, catalog mapping, transport selection.
- [`model-metadata.ts`](../src/model-metadata.ts) — chain parsing, compile plan,
  per-field source selection, `DEFAULT_CHAIN`.
- [`metadata-config.ts`](../src/metadata-config.ts) — YAML config, legacy-field and
  empty-chain errors. Split from `model-metadata.ts` so the compile worker keeps
  an import graph of only relative paths and `node:` builtins.
- [`metadata-core.ts`](../src/metadata-core.ts) — host-neutral compile entry (no Pi
  imports): config parsing, `include_models` selection, record-source
  registration, Worker compile with a caller-supplied worker file or
  `tablesPath`, field resolution, and SourceTables conversion for hosts such
  as the AI-gateway models-enricher.
- [`metadata-glob.ts`](../src/metadata-glob.ts) — the shared standard-glob matcher
  for `match` and `include_models`; runs on the host thread only.
- [`metadata-worker.ts`](../src/metadata-worker.ts) /
  [`metadata-tables.ts`](../src/metadata-tables.ts) — Worker body and per-shape
  SourceTables validation shared by every host's Worker entry.
- [`metadata-compile.ts`](../src/metadata-compile.ts) / `metadata-compile-worker.mjs`
  — Pi adapter: active data-package selection and the plugin's Worker entry.
- [`metadata-view.ts`](../src/metadata-view.ts) — `/provider-metadata` rendering.
- [`responses-websocket-fetch.ts`](../src/responses-websocket-fetch.ts) — Responses
  WebSocket bridge; see [transports](transports.md).
- [`request-compression.ts`](../src/request-compression.ts) — shared compression
  policy bridge; see [request compression](request-compression.md).
- [`response-checkpoints.ts`](../src/response-checkpoints.ts) /
  `checkpoint-adapter.ts` — checkpoint policy and storage; see
  [response checkpoints](response-checkpoints.md).

## Test scope

[`tests/transport-owner.test.ts`](../tests/transport-owner.test.ts) exercises
the real SDK `createModels` entry and direct provider calls against loopback
Responses servers. It checks full/delta frames, request counts, transport
reporting, and (where exposed) unused native WebSocket debug state. This is
SDK-entry coverage, not full Agent/CLI, checkpoint persistence, or production
gateway acceptance. Separate
[durable provider](../tests/durable-provider.test.ts),
[policy](../tests/checkpoint-policy.test.ts), and
[production codec](../tests/production-codec.test.ts) tests cover checkpoint
boundaries; see
[bounded validation scope](response-checkpoints.md#source-and-validation-scope).
