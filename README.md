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

Requires xz-dev/pi **1.3.0-xz.328.1.g2e2d9ad8** or newer with the shared
transport-compression APIs. Update the host first; see
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

Pi's `transport` setting selects behavior. Absent transport defaults to `auto`
for both `stream` and `streamSimple`, including checkpoint policy/capture:

- `sse`: normal HTTP `POST /v1/responses` stream.
- `websocket`: a fresh Responses WebSocket per request.
- `websocket-cached`: reuses a session WebSocket and sends
  `previous_response_id` plus only new input when the conversation prefix still
  matches; otherwise sends full local context or fails if known server ancestry
  cannot be preserved.
- `auto`: tries cached WebSocket first. Transport failures allow three WebSocket
  retries through Pi's retry owner; the fourth failure starts SSE fallback for
  two minutes. Failed recovery probes step to three, four and at most five
  minutes. Retry settings can stop a request before this budget is exhausted.
  Recovery uses a fresh WebSocket and full local context, preserving an explicit
  caller parent. Once SSE is selected, provider retries stay on SSE for that
  request. A completed WebSocket success resets progression; only the recovery
  owner clears its active deadline. One recovery request runs at a time per
  endpoint/session/header identity; concurrent requests use SSE until it finishes.
  Cancellation does not count as a failure. Once any response event has arrived,
  a failure is surfaced without replaying that request over SSE. Admitted durable
  requests have stricter no-replay fences, even before the first response event.
  Ordinary API, protocol and local errors do not consume the transport budget or select SSE.

Before any response starts, a coded `websocket_connection_limit_reached` rejection
allows one fresh-WebSocket retry, independent of `maxRetries`. Checkpoint-active
requests still require full local history and no consumed reference repair; with
checkpoints disabled, caller-owned parents pass through unchanged. Repeated limits
enter the transport failure budget: auto with a session selects SSE on the fourth
failure, while sessionless auto can select SSE immediately after its fresh retry.

Explicit `websocket` and `websocket-cached` modes fail without SSE fallback.
Recovery belongs to this extension's Responses bridge, not Pi's built-in Codex
transport. It requires no fork-only WebSocket state accessors or extra
configuration. The host must also meet the [compression API requirement](#host-requirement).

The bridge uses Pi's existing request builder and response parser through its
public `fetch` injection point; it does not copy Pi's Responses protocol code.
[Provider entry](index.ts) explicitly selects SSE **inside the SDK**, so newer
hosts cannot bypass the [bridge](responses-websocket-fetch.ts) with a second
native WebSocket planner. The bridge keeps the caller's requested transport.
Only explicit `sse` keeps the direct HTTP path and hard-disables checkpoints.
Where the host exposes `onTransport(transport, model)`, bridge requests report
`WS/full`, `WS/continuation`, or actual fallback `SSE`, never the internal SSE
parser mode. Continuation labels describe the sent parent reference, not a
server cache hit. Observer failures do not retry inference.

An explicit `Authorization` header overrides `apiKey`. Request headers override
model headers case-insensitively. WebSocket authentication, socket/checkpoint
identity, recovery cooldowns and compression use the effective wire credential:
changing an unused API key keeps the socket/continuation; changing effective
Authorization isolates them. Alternate `cf-aig-authorization` authentication
sends no synthetic bearer header when Authorization is absent.

Optional settings, including `responseCheckpointExclude`, pass through without
plugin defaults or native `['*']` defaults being inserted. The actual bridge
owner applies [checkpoint policy and storage](#response-checkpoints); eligible
durable requests have stricter replay limits than ordinary auto fallback.
Stopping the host's ordinary retries after a started reference repair requires
Pi's matching shared retry consumer; automatic overflow compaction remains a
[separate recovery exception](docs/response-checkpoints.md#reference-repair-retry-fence).
Public context normalization is used only when available on the host, preserving
system prompts and tool declarations; compression itself requires the updated host exports.

Because message conversion runs inside Pi's shared `transformMessages` step,
the extension itself resolves ancestry, then drops empty-content user/assistant
messages (for example watchdog inquiry fold markers) before delegating, so
filtering cannot erase an applicable ancestry fact. On hosts with native ancestry
guards, the existing payload hook exposes only a validated bridge-owned parent
before that guard. The bridge revalidates the final payload and wire identity;
this does not turn its parent into caller authority or permit parent-free replay.

## Request compression

Lossless HTTP and WebSocket compression reuses Pi's shared policy without changing
model input or image quality. The default Working label shows the active algorithm,
for example `SSE Zstd` or `WS/continuation DEFLATE`; uncompressed requests keep
the original protocol label. See [compression and compatible hosts](docs/request-compression.md)
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

The extension requests the `/v1/models` catalog (Codex `models[]` or plain
OpenAI `data[]`). The upstream catalog alone decides which models exist and
their public IDs; it is never rebuilt from external sources. Identity,
context-window, and output-token limits are kept as provided, then fields
missing from all configured sources fall back to the conservative 128K
default — an invalid catalog is still rejected atomically and Pi keeps the
last verified list. `/login` is not blocked by catalog quality: only
connection failures (unreachable gateway, invalid API key, non-models
payload) fail login. If the gateway connects but the catalog is unusable,
the key is saved and the problem is reported where it belongs — model-list
refresh. Pi's `/model` overlay only names the provider; this extension also
appends a TUI-only chat entry with the real discovery error (HTTP status and
a short body, no URL or API key).

### Metadata fallback chain

During each online catalog refresh the extension can also enrich models from
two public bulk metadata sites — [models.dev](https://models.dev) and
[modelparams.dev](https://modelparams.dev) — using the same fallback-chain
idea as AI-gateway's models-enricher, but only over public data. External
sources never decide which models exist; they only fill or overwrite
metadata. Membership stays 100% upstream. Requests are bounded (16 MiB, 5 s,
no cross-origin redirects) and never carry the gateway API key.

Config lives at `~/.pi/agent/openai-api-extension.yaml` (Pi's agent dir,
i.e. `getAgentDir()`). The file is read-only and never created
automatically; a missing file means defaults. A file with invalid YAML or
invalid *known* fields blocks the catalog update (old catalog kept) and is
reported as a metadata config error — never as an invalid API key. Unknown
top-level/channel/model fields (e.g. AI-gateway-only keys like
`static_models`, `custom_channels`, `metadata_from`, `cpa_base_url`,
`fetch_models`, `ollama_native_base_url`) are ignored with one warning
listing their full paths; everything else still applies.

```yaml
# Defaults when source_priority is absent — subscriptions first, then API.
source_priority:
  - "*/subscription"
  - "*/api_key"
fill_missing_only: false

models:
  # Model rules are string globs on the full public model ID; quote keys
  # that start with *. Exact key wins, else the first matching glob in
  # declared order; no merging with other matching rules.
  "*gpt-6-astra":   # matches gpt-6-astra, openai/gpt-6-astra, proxy/openai/...
    source_priority: ["models.dev/openai", "modelparams.dev/openai/subscription"]
  "*gpt*":          # matches any full ID containing gpt, incl. provider segments
    fill_missing_only: true
  model-a:          # exact: does NOT match proxy/model-a
    overrides: { context_window: 128000 }

channels:
  proxy:
    source_priority: ["models.dev/*/subscription"]
    global_fallback: true   # append the root chain after this channel chain
    fill_missing_only: true
    models:
      model-a:              # matches channel-relative ID (prefix stripped once)
        source_priority: [] # model chain replaces channel+global entirely
```

**Source selectors** (`source_priority` entries): `models.dev/<provider>`,
`models.dev/<pattern>` (any access),
`modelparams.dev/<provider>/<subscription|api_key>`, the two-segment
shorthands `*/subscription` and `*/api_key` (all sites), and the three-part
`<site>/<provider-glob>/<subscription|api_key|*>`. Your list order wins;
inside one selector models.dev is consulted before modelparams.dev.
Overlapping selectors can't double-apply the same adopted record.

**Access classification** is a local policy, not a claim about your gateway:
modelparams.dev uses each record's own `authType`; models.dev has no auth
field, so a fixed subscription-provider set ships in the plugin
(`MODELS_DEV_SUBSCRIPTION_PROVIDERS` in `model-metadata.ts`) and every other
models.dev provider counts as `api_key`. Pin a provider earlier with an
exact `models.dev/<provider>` selector if needed.

**Ambiguity**: when one selector yields several same-named records from
different providers on one site, models.dev entries arbitrate via
`canonical_model_id` — the model developer's self-hosted entry wins, but
only if every candidate agrees on the same canonical ID and the developer's
own record is inside this selector's access scope. Otherwise the group is
skipped (with a short diagnostic) rather than guessed; a later, more
specific selector can still resolve it. Skipped groups don't consume the
first-hit dedupe slot.

**Scope precedence**: channel-model rule > global-model rule > channel
default > global default > built-ins. `fill_missing_only` inherits the same
way (explicit `false` beats a parent's `true`). A model-level
`source_priority` replaces the channel and global chains entirely —
including `[]` to disable external sources for that model.

**Merge modes**: default is full overwrite (external values win field by
field); `fill_missing_only: true` only fills fields the upstream left
missing. `null` never erases a lower-priority value; an explicit empty
`supported_reasoning_levels: []` means "no tiers" rather than "missing".
Manual `overrides` (model rule, then legacy channel `overrides.<model>`)
apply after source merging; Pi's `models.json` `modelOverrides` always
applies last. `lookup_ids` keys are exact concrete sources
(`models.dev/<provider>` or `modelparams.dev/<provider>/<access>`) and map
that source to a fixed query ID whenever any selector — including wildcards
and the built-in default chain — expands to it; `provider_prefix_map` only
changes the query identity, never the public ID.

**Opt out** of all external enrichment with a root `source_priority: []`
(and no local chains), then refresh. Offline restore and `allowNetwork:
false` refreshes read no config and hit no metadata site. If every metadata
source fails, the upstream-mapped catalog still publishes with a degrade
note; if the upstream catalog itself fails, Pi keeps the persisted catalog.
The inference path never fetches metadata.

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
