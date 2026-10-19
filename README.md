# openai-api-pi-extension

Minimal modern [Pi](https://pi.dev) provider extension for any
OpenAI-compatible gateway — [Sub2API](https://github.com/Wei-Shaw/sub2api),
CLIProxyAPI, LiteLLM, or the official OpenAI API — using the
**Responses API** over Pi's configured transport (`auto`, `sse`, `websocket`, or
`websocket-cached`).

## What it does

- Registers a complete Pi-native `openai-api-extension` provider. Pi owns
  credentials, model refresh, persistence, offline restore, cancellation, and
  request-time endpoint selection.
- Discovers models from `GET {baseUrl}/models` during async startup or Pi's
  provider refresh. The gateway may expose its complete inventory; this
  extension registers only conversational text models for Pi agent use,
  filtering explicit embedding/image/video/audio kinds and non-text outputs
  while retaining image-input vision models.
- Valid chat entries without declared capability limits use a conservative
  128K context/output fallback instead of rejecting the entire catalog;
  explicit gateway limits always win.
- Every model is registered with `api: "openai-responses"`. Reasoning and
  `thinkingLevelMap` come from the Codex catalog (`supported_reasoning_levels`
  or `capabilities.effort_tiers`), using the same map shape as OmniRoute:
  `off` is hidden, `minimal` aliases `low`, unknown/`ultra`/`none-only` fail
  closed. Request bodies and response streams still go through Pi's standard
  OpenAI Responses adapter; the WebSocket bridge only carries those bytes via
  the official OpenAI SDK.

## Setup

### Option 1: `/login` (recommended)

```
/login openai-api-extension
```

Prompts for the gateway base URL and API key, validates the pair against
`GET {baseUrl}/models`, and stores one API-key credential in
`~/.pi/agent/auth.json`. The API key uses Pi's secret prompt; the base URL is
stored as provider-scoped credential metadata. `/logout openai-api-extension`
removes both.

### Option 2: Environment variables

The provider remains visible for `/login` when unconfigured, but exposes no
models. Environment values override stored `/login` fields independently.

```bash
export OPENAI_API_EXTENSION_BASE_URL="https://your-gateway.example.com/v1"
export OPENAI_API_EXTENSION_API_KEY="sk-..."
```

> The dedicated `OPENAI_API_EXTENSION_*` prefix avoids colliding with the
> official OpenAI provider's environment variables.

Environment-based setup discovers models during the async extension factory,
so they are available at startup and to `--list-models`. Stored `/login`
credentials refresh through Pi's provider lifecycle. If discovery fails, Pi
retains the last persisted catalog; offline startup restores it without network
access.

## Host requirement

Requires Pi's shared transport-compression APIs. Update the host first; see
[compatible hosts and upgrade order](docs/request-compression.md#host-requirement).

## Install

```
pi install git:github.com/xz-dev/openai-api-pi-extension
```

Or try it once without installing:

```
pi -e git:github.com/xz-dev/openai-api-pi-extension --provider openai-api-extension --model <model-id>
```

## Transports

Pi's `transport` setting selects behavior:

- `sse`: normal HTTP `POST /v1/responses` stream.
- `websocket`: one Responses WebSocket per request.
- `websocket-cached`: reuses a session WebSocket and sends
  `previous_response_id` plus only new input when the conversation prefix still
  matches; otherwise sends full context safely.
- `auto`: tries cached WebSocket first. Without durable checkpoint eligibility, a failure before the first response event
  falls back to SSE for that request, without retrying WebSocket in the same
  request (including Pi's provider-level retries). After the first failure, the
  next real request tries a fresh WebSocket with full context. Consecutive failures
  keep that gateway/session on SSE for
  5 minutes before another request can try WebSocket again. A failed recovery
  starts a new 5-minute cooldown; a successfully completed WebSocket response
  resets the failure sequence. Only one recovery request runs at a time;
  concurrent requests use SSE until it finishes. Cancellation does not count as
  a failure. Once any response event has arrived, a failure is surfaced without
  replaying that request over SSE; recovery applies to later requests only.

Explicit `websocket` and `websocket-cached` modes fail without SSE fallback.
Recovery belongs to this extension's Responses bridge, not Pi's built-in Codex
transport. It requires no fork-only WebSocket state accessors or extra
configuration. The host must also meet the [compression API requirement](#host-requirement).

The bridge uses Pi's existing request builder and response parser through its
public `fetch` injection point; it does not copy Pi's Responses protocol code.
[Provider entry](index.ts) explicitly selects SSE **inside the SDK**, so newer
hosts cannot bypass the [bridge](responses-websocket-fetch.ts) with a second
native WebSocket planner. The bridge keeps the caller's requested transport.
Explicit SSE and direct calls without a transport retain HTTP behavior.
Where the host exposes `onTransport(transport, model)`, bridge requests report
`WS/full`, `WS/continuation`, or actual fallback `SSE`, never the internal SSE
parser mode. Continuation labels describe the sent parent reference, not a
server cache hit. Observer failures do not retry inference.

Optional settings, including `responseCheckpointExclude`, pass through without
plugin defaults or native `['*']` defaults being inserted. The actual bridge
owner applies [checkpoint policy and storage](#response-checkpoints); eligible
durable requests have stricter replay limits than ordinary auto fallback.
Public context normalization is used only when available on the host, preserving
system prompts and tool declarations; compression itself requires the updated host exports.

Because message conversion runs inside Pi's shared `transformMessages` step,
the extension itself drops empty-content user/assistant messages (for example
watchdog inquiry fold markers) before delegating, so requests stay clean on any
host pi version.

## Request compression

Lossless HTTP and WebSocket compression reuses Pi's shared policy without changing
model input or image quality. See [compression and compatible hosts](docs/request-compression.md)
and the [paired Pi guide](https://github.com/xz-dev/pi/blob/main/docs/request-compression.md).

## Response checkpoints

Cached transports can resume stored state across reconnects or session restarts.
Eligible requests ask for remote `store: true` by default; check the service's
retention policy or opt out with `responseCheckpointExclude: ["*"]`.
See [checkpoint settings, privacy and recovery](docs/response-checkpoints.md)
and the [native Pi counterpart](https://github.com/xz-dev/pi/blob/main/docs/downstream-changes.md#response-checkpoints).

## Connection status

Run:

```text
/provider-info
```

The command probes the configured gateway with the effective API key and shows
the last transport this plugin actually used, Pi's configured transport, server
URL, connection/key validity, and live usable model count. Before the first
model request, actual transport is reported as `not connected yet`. It never
prints the API key.

## Per-model overrides

Pi composes `~/.pi/agent/models.json` above registered providers. Use it only
to override a catalog-derived map, not to invent the default tiers.

## Model metadata

The extension requests the Codex-compatible `/v1/models?client_version=...`
catalog. Catalog refresh is atomic: every model must provide identity,
context-window, and output-token limits, or the whole list is rejected — Pi
keeps the last verified catalog instead of publishing invented limits or a
partial list. `/login` is not blocked by catalog quality: only connection
failures (unreachable gateway, invalid API key, non-Codex payload) fail login.
If the gateway connects but the catalog is unusable, the key is saved and the
problem is reported where it belongs — model-list refresh. Pi's `/model` overlay
only names the provider; this extension also appends a TUI-only chat entry with
the real discovery error (HTTP status and a short body, no URL or API key).

## Development

```
npm install --ignore-scripts
npm test        # node:test provider lifecycle, loader, and transport tests
```

For older development dependencies, see the
[test-only host-helper setup](docs/request-compression.md#checks-and-development).

[`tests/transport-owner.test.ts`](tests/transport-owner.test.ts) exercises the real SDK `createModels` entry and
direct provider calls against loopback Responses servers. It checks full/delta
frames, request counts, transport reporting, and (where exposed) unused native
WebSocket debug state. This is SDK-entry coverage, not full Agent/CLI,
checkpoint persistence, or production gateway acceptance. Separate
[durable provider](tests/durable-provider.test.ts), [policy](tests/checkpoint-policy.test.ts),
and [production codec](tests/production-codec.test.ts) tests cover checkpoint
boundaries; see [bounded validation scope](docs/response-checkpoints.md#source-and-validation-scope).

## License

MIT
