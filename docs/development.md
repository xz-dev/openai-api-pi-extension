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

- [`index.ts`](../index.ts) — provider entry: registration, `/login`,
  `/provider-info`, `/provider-metadata`, catalog mapping, transport selection.
- [`model-metadata.ts`](../model-metadata.ts) — chain parsing, compile plan,
  per-field source selection, `DEFAULT_CHAIN`.
- [`metadata-config.ts`](../metadata-config.ts) — YAML config, legacy-field and
  empty-chain errors. Split from `model-metadata.ts` so the compile worker keeps
  an import graph of only relative paths and `node:` builtins.
- [`metadata-compile.ts`](../metadata-compile.ts) / `metadata-compile-worker.mjs`
  — per-site loading, worker orchestration, per-model rule layering.
- [`metadata-view.ts`](../metadata-view.ts) — `/provider-metadata` rendering.
- [`responses-websocket-fetch.ts`](../responses-websocket-fetch.ts) — Responses
  WebSocket bridge; see [transports](transports.md).
- [`request-compression.ts`](../request-compression.ts) — shared compression
  policy bridge; see [request compression](request-compression.md).
- [`response-checkpoints.ts`](../response-checkpoints.ts) /
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
