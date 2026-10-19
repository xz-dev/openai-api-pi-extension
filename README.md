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

Request compression requires a Pi build whose `@earendil-works/pi-ai` exports `createRequestCompressionFetch` and `getWebSocketCompressionPolicy`. The declared peer version range alone does not establish that capability. Older hosts without these exports fail at module load; install the matching updated host before this plugin revision. Earlier stock-host validation results below describe the pre-compression revision, not this new requirement.

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

Direct SSE uploads and auto-mode HTTP fallbacks use Pi's shared `createRequestCompressionFetch` only at the final network sender. The bridge still parses plain JSON before choosing its transport; there is no copied codec implementation or independent HTTP downgrade cache in this plugin.

Unknown endpoints are actively tried with zstd level 3. Explicit encoding refusals step down through gzip level 4, deflate, Brotli, then plain JSON. State is process-local, target/credential-scoped, never persisted and never automatically upgraded. A missing `Accept-Encoding` response does not disable probing. Generic JSON errors, authentication failures, rate limits, server/network errors and cancellation do not justify another compression attempt.

WebSockets separately use shared `getWebSocketCompressionPolicy` with the existing SDK/ws client. Negotiated `permessage-deflate` compresses actual upload frames while application payloads remain JSON. A declined extension is not offered again for that target/auth scope until process exit. Existing transport and checkpoint cooldown rules remain independent.

Compression is lossless: image bytes, resolution, quality and model input are unchanged. Smaller network payloads do not imply fewer tokens or guaranteed lower first-token latency.

## Response checkpoints

Durable continuation can request `store: true` on eligible Responses endpoints,
on `auto` or `websocket-cached` transport only. A reconnect or restored session
can send an existing response ID plus new input instead of resending the whole
conversation.

Two independent settings apply. `responseCheckpointMode` selects when to ask for
checkpoints at all:

| Mode | Meaning |
| --- | --- |
| `always` (default when absent) | Request `store: true` on every eligible endpoint, even when `compat.supportsResponseCheckpoints` is `false` |
| `auto` | Request unless the model declares `compat.supportsResponseCheckpoints: false` |
| `declared` | Request only with an exact `compat.supportsResponseCheckpoints: true` declaration, or the official OpenAI service |

Malformed mode values disable checkpoints. The second setting is the per-target
opt-out `responseCheckpointExclude: string[]`:

| Raw setting | Plugin | Native fork without plugin |
| --- | --- | --- |
| Absent | Eligible targets enabled (`[]`) | Eligible targets enabled (`[]`) |
| `[]` | Eligible targets enabled | Eligible targets enabled |
| `["*"]` | All excluded | All excluded |

Raw absence remains absent in settings and forwarded options. Native defaults
are never injected into plugin requests. To exclude all targets in
`~/.pi/agent/settings.json`:

```json
{
  "responseCheckpointExclude": ["*"]
}
```

To enable otherwise eligible targets explicitly:

```json
{
  "transport": "auto",
  "responseCheckpointExclude": []
}
```

Matching uses `minimatch` **10.2.6**, `{ nocase: true }`, against provider ID,
model ID, and `provider/model`, not display names. Any match excludes; order does
not create exceptions. Literal `"*"` also excludes slash-containing IDs. Other
patterns retain segment/globstar, braces, and character classes; for example
`["openai-api-extension/**", "gpt-[45]*"]`. Malformed values or non-string
members disable checkpoints. Trusted project settings replace the global list;
untrusted project values are ignored. Incoming request options take precedence
when the property is present.

### Endpoint capability and privacy

Supported API-key mode at `https://api.openai.com/v1` has the official-service
default. Unsupported Codex/ChatGPT modes stay unchanged. In `declared` mode
custom services still require an exact `compat.supportsResponseCheckpoints: true`
declaration after verifying persistent Responses support for the actual
endpoint/account. `always` (the default) tries eligible endpoints even without
a declaration; the cooldown below bounds the cost of a wrong guess.

For an **already discovered** model, merge this override into
`~/.pi/agent/models.json`, replacing `your-model-id` with its actual catalog ID:

```json
{
  "providers": {
    "openai-api-extension": {
      "modelOverrides": {
        "your-model-id": {
          "compat": { "supportsResponseCheckpoints": true }
        }
      }
    }
  }
}
```

This declares capability; it does not create a model or verify the server.
Configure endpoint/auth and use the ordinary provider discovery/refresh lifecycle
first. No direct catalog-store editing is needed.

**Privacy:** eligible requests ask the server for `store: true` before the user's
payload hook, on third-party gateways included by default. Hook `store: false`
prevents durable use/capture; server `store: false` prevents capture. Use
`responseCheckpointMode: "declared"` or `responseCheckpointExclude: ["*"]`
to opt out. Confirm remote retention/privacy requirements before enabling.
Explicit SSE, uncached `websocket`, and `cacheRetention: "none"` do not enable
this plugin feature. No TTL, answer cache, KV-cache hit, reduced billing, or
server retention guarantee is invented.

### Verification cooldown

Mode and gates decide whether to *try* checkpoints; a separate per-endpoint,
per-session cooldown verifies that `store: true` continuation actually works.
The first pre-execution reference failure — `previous_response_not_found`, a
code-less `previous_response_id is not available` rejection, a rejection of the
`store` parameter, or a previous_response_id capability rejection — repairs the
turn once with full history (no `store`, no `previous_response_id`) and opens a
5-minute cooldown. During cooldown the session sends full history without
`store`. After the deadline, the next real request probes once with `store:
true` plus full history; success clears the state, failure renews the cooldown.
No background probes; nothing is persisted.

### Restore and safe failure

Full canonical JSONL remains authoritative. A completed stored assistant response
with independently complete local history can carry bounded v1 metadata:
`scopeHash`, `requestHash`, `prefixHash` (SHA-256), `inputCount`, `createdAt`, and
optional known `expiresAt`, plus `version: 1`. The ID stays in existing
`responseId`; metadata contains neither payload snapshots nor credentials. No
side database is created.

The latest assistant on the active branch is the only candidate. Restore or
rollback uses it only when actual endpoint/account/header scope, full request
envelope, and exact encoded history prefix still match, including tool and
opaque reasoning data. Invalid/expired metadata, edited history, changed scope
or envelope, unknown versions, incomplete output, and empty/unsafe suffixes send
full history. A caller-owned parent is not replaced or declared full history.

At most one WS repair is allowed for a proven pre-execution reference rejection
with genuine complete local history. Missing stored responses and the original
strict message-ID rejection repair are distinct: that existing repair includes
the exact WS 1008 signature, not arbitrary policy closes. No replay after
output, auth failure, unknown execution, or caller-dependent ancestry; no
hidden provider retry or HTTP/SSE replay after a failed repair. Explicit SSE and the auto WS→SSE fallback never carry the
policy `store: true`; a hook `store: false` is always kept.

### Source and validation scope

[Provider entry](index.ts), [policy/host codec adapter](checkpoint-adapter.ts),
[WS bridge](responses-websocket-fetch.ts), and [portable kernel](response-checkpoints.ts)
implement this path. The native checkpoint counterpart lives on
[`xz-dev/pi`'s Responses transport patch branch](https://github.com/xz-dev/pi/tree/patch/responses-websocket-transport),
with [request adapter](https://github.com/xz-dev/pi/blob/patch/responses-websocket-transport/packages/ai/src/api/openai-responses.ts)
and [package docs](https://github.com/xz-dev/pi/blob/patch/responses-websocket-transport/packages/ai/README.md).
Both copies use the same portable kernel; adapter
scope deliberately prevents assuming cross-adapter checkpoint portability.

Native alone, plugin alone on stock, and plugin plus fork use one request owner.
The inner SSE mode is only the SDK codec bridge, not HTTP continuation or a
second native planner. The public host codec prepares checkpoint output without
network I/O; unsupported reconstruction declines the optimization.

Loopback validation passed 222/222 plugin tests on each of stock Pi 0.84.2 and
fork 1.3. Independent parent reruns passed eight targeted plus four frozen cases
on each host. Separate CLI gates used four native-only processes and eight
combined stock/fork plugin processes, including restart with raw absent and
`["*"]` policies. Fork CLI input retained its actual command-line provenance,
not a fabricated human/direct-terminal origin; stock retained its legacy format.
Successful pairs had exact reconstructed input and zero HTTP inference. Model
discovery preparation and retained failed setup attempts are separate from
those successful inference counts.

Additional network-namespace-isolated loopback checks passed all 10 processes:
Bun single-executable Pi 1.3.0-xz.306 with the installed plugin (absent resumes,
`["*"]` sends full input), native candidate source under Bun 1.4.3 (`[]` resumes,
absent sends full input), and stock 0.84.2 with the installed plugin (absent
resumes). All exited 0 with zero HTTP inference.

Real packed-plugin installs via `pi install npm:...@<tgz>` passed on the Bun
single-executable and stock 0.84.2 hosts, with online registry access for
dependencies: exactly six runtime packages and no Pi SDK. The earlier offline
`ENOTCACHED` result was a cache miss, not an unresolved installer failure.

With model data hydrated separately in each checkout (`npm run hydrate:model-data`),
latest main `41be7dc` plus the candidate passed `tsc` and full `npm run check`,
with AI tests 206/206 and settings tests 179/179. The earlier Kimi TS2322 was a
foreign-catalog artifact; older owner-branch fixture diagnostics are fixed
upstream, not caused by checkpoints. Rebasing the owning transport branch onto
newer upstream remains a maintainer sync step.

Evidence remains limited to loopback fixtures, not real-gateway retention,
account isolation, every host layout, or deployment. Verify persistent Responses
support for the actual endpoint/account before enabling checkpoints.

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

When the development dependency predates the new host exports, set `PI_REQUEST_COMPRESSION_HELPER` to the updated host source file `packages/ai/src/utils/request-compression.ts` for local tests. The test-only preload also loads its sibling `websocket-compression.ts`; it is never a production fallback. No machine-specific path is embedded in the package.

[`tests/transport-owner.test.ts`](tests/transport-owner.test.ts) exercises the real SDK `createModels` entry and
direct provider calls against loopback Responses servers. It checks full/delta
frames, request counts, transport reporting, and (where exposed) unused native
WebSocket debug state. This is SDK-entry coverage, not full Agent/CLI,
checkpoint persistence, or production gateway acceptance. Separate
[durable provider](tests/durable-provider.test.ts), [policy](tests/checkpoint-policy.test.ts),
and [production codec](tests/production-codec.test.ts) tests cover checkpoint
boundaries; see [bounded validation scope](#source-and-validation-scope).

## License

MIT
