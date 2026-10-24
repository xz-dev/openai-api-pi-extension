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
- Discovers models from `GET {baseUrl}/models` on Pi's provider refresh
  (`/login`, interactive background refresh, or `pi --refresh --list-models`).
  Startup itself never touches the network; the persisted catalog restores
  offline. The gateway may expose its complete inventory; this
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

With env-based or stored `/login` credentials, no discovery runs at startup:
the extension loads instantly, Pi restores the last persisted catalog
(without network), and interactive sessions refresh it in the background.
On a fresh install with no persisted catalog, plain `--list-models` shows
nothing for this provider — run `pi --refresh --list-models` once for the
initial discovery and whenever you want to force an update. If discovery
fails, Pi retains the last persisted catalog; offline startup restores it
without network access.

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
refresh. Pi's `/model` overlay only names the provider; catalog and metadata
diagnostics surface as transient native notifications (or stderr without a
UI) — never as session entries. The same applies to `/login`: only
connection failures fail login; if the gateway connects but the catalog is
unusable, the key is saved and the problem is reported where it belongs —
model-list refresh.

### Metadata compile chain

During each online catalog refresh the extension can also enrich models from
two public bulk data packages —
[@opencode-ai/models](https://www.npmjs.com/package/@opencode-ai/models)
(the [models.dev](https://models.dev) snapshot) and
[modelparams](https://www.npmjs.com/package/modelparams)
([modelparams.dev](https://modelparams.dev)) — installed alongside the
extension with an unpinned `*` range. They refresh when `pi update`
installs a new extension commit; to bump only the data without waiting
for a plugin release, run `bun update @opencode-ai/models modelparams`
inside the extension dir (`~/.pi/agent/git/<host>/<owner>/openai-api-pi-extension`). The whole lookup and merge runs inside a worker thread that
only returns a compiled result; the ~7 MB snapshot never enters the main
thread's heap. External sources never decide which models exist; they
enrich only models the upstream `/v1/models` catalog already lists.

Config lives at `~/.pi/agent/openai-api-extension.yaml` (Pi's agent dir,
i.e. `getAgentDir()`). The file is read-only and never created
automatically; a missing file means defaults. A file with invalid YAML,
invalid *known* fields, or removed legacy fields blocks the catalog update
(old catalog kept) and is reported as a metadata config error — never as an
invalid API key. Unknown fields are ignored with one aggregated warning
listing their full paths; everything else still applies.

```yaml
# Defaults — the model developer's own records first, api_key tier.
chain:
  - "models.dev/@creator/api_key"
  - "modelparams.dev/@creator/api_key"
fill_missing_only: false   # built-in default: external data wins

models:
  # Rules match on the full public model ID with `*` wildcards; every
  # matching rule applies in declared order — later rules override fields
  # and merge overrides.
  - match: "*gpt-6-astra"   # matches gpt-6-astra, openai/gpt-6-astra, ...
    chain: ["models.dev/openai/api_key", "modelparams.dev/openai/api_key"]
  - match: "*gpt*"          # matches any full ID containing gpt
    fill_missing_only: true # this family's upstream values win
  - match: "model-a"        # matches only the exact ID model-a
    overrides: { contextWindow: 128000 }
  - match: "proxy/glm-5.1"
    # A rule-level chain replaces the root chain for matching models;
    # @default splices the root chain back in wherever it sits.
    chain: ["modelparams.dev/z-ai/api_key", "@default"]
```

**Chain entries**: `<site>/<provider>/<access>[/<query-id>]` — site is
`models.dev` or `modelparams.dev`, access is `api_key` or `subscription`
(modelparams records carry their own `authType`; models.dev's access is a
declared label), and an optional 4th segment pins the literal query ID
(may contain `/`) when the public ID differs, e.g.
`models.dev/llmgateway-providers/api_key/anthropic/claude-fable-5-1`.
Wildcards (`*`) are not allowed anywhere in a chain entry.

**`@creator`** resolves the model's full canonical identity at compile
time, in four steps:

1. Collect the `@id` query hits for the public ID's last `/` segment
   across all models.dev provider records and the unified canonical
   table.
2. Read the `canonical_model_id` of the identity-bearing hits — unified
   table entries carry their full `creator/model` key.
3. Collapse creators through the built-in ordered alias groups
   (`zhipuai|zai|z-ai`, `moonshotai|moonshot`, `thinkingmachines|thinking-machines`),
   keep the full canonical model (renames like `deepseek-v4-flash-fast`
   still resolve to the creator's real model id), and expand the
   creator to the group members that exist on each site.
4. Read fields only from those concrete provider tables. Other providers'
   records (for example aggregators such as `llmgateway-providers`) help
   identify the creator but never supply fields.

On modelparams.dev, entries also filter by `authType === access`. If no
creator is found, the entry is marked `[unresolved]`: it is skipped and the
upstream value is kept. Only creators from *different* alias groups for the
same model are a config error; name the provider literally in a rule to
resolve it.

**`@id`** queries source records by the public ID's last `/` segment.
At compile time the segment becomes an anchored, escaped,
case-insensitive pattern: the literal string is tried first, then every
record whose id differs only by runs of space/underscore/dot/hyphen or
case is collected, then a date-suffix-stripped fallback
(`-YYYYMMDD` / `-YYYY-MM-DD`). All literal matches are kept as
inspectable candidates — regex input is never executed, channel
prefixes do not change the query, and a literal 4th chain segment
always stays an exact lookup. The default chain uses `@creator` with an
implicit `@id` model query.

**Canonical identity** is resolved from the collected hits: full
`creator/model` canonical IDs (not bare creator prefixes) are compared
through the alias groups; records carrying distinct canonical creators
are a config error on `@creator` chains, and same-creator hits naming
distinct canonical models are marked ambiguous and skipped — never
merged or order-picked. Same-level aliases whose capability fields
conflict are skipped the same way, and compilation continues with the
next source. A unified canonical models table (the snapshot's
`models` shape) supplies identity evidence and, only for the automatic
`@creator/api_key` path, fills fields a concrete creator record left
missing — the provider's own record always wins where it has a valid
value, and unified data can form a logical entry when no provider
record exists at all. Explicit providers, literal model segments and
`subscription` entries never get that fallback; aggregator records only
contribute canonical hints, never fields.

**Original display**: enrichment only supplies capability fields. The
published model keeps its upstream public ID and gateway display name
(`name`/`display_name`); internal query strings, canonical IDs and
source record names never replace them — only explicit `overrides` and
Pi `models.json` `modelOverrides` can rename a model.

**Match summary**: after each refresh the extension reports one short
line classifying every model with an enabled external chain as
complete (capability fields, nothing unresolved), partial-source-missing
(some entries unresolved), or unmatched (no capability field — a
name-only record does not count); models with `chain: []` are listed
separately as disabled and never counted as failures. Degraded data
sources add their own note; the full candidate lists and reasons live
in `/provider-metadata`, not in the notification.

**Notifications are transient**: metadata notes, degraded-source
warnings and config errors reach you through Pi's native notify channel
when a UI is attached, or stderr otherwise — stdout and the session
JSONL stay untouched, and nothing is appended as chat entries. Notes
identical to the previous report are deduplicated; a superseded or
cancelled refresh reports nothing.

**`@default`** inside a rule's `chain` splices the *root* chain at that
position; in the root chain it is a config error.

**Rule layering**: every rule whose `match` glob hits the public ID
contributes in declared order — later rules override `chain`/
`fill_missing_only` fields entirely, and `overrides` merge RFC 7396-style
(nested objects recurse, `null` deletes). `match: "*"` rules apply to all
models; there is no extra priority for exact names.

**Merge mode**: `fill_missing_only: false` is the built-in default —
external values overwrite upstream fields one by one (gateways are
stable, the unstable environment is the client). Setting `true` keeps
upstream values and fills only fields the upstream left missing or
invalid; `null` never erases a value, an explicit empty
`supported_reasoning_levels: []` counts as "no tiers", and an alias like
`context_length` can't slip past the fill-only guard for `context_window`.
Manual `overrides` apply after source merging as one more RFC 7396 patch;
`id`, `provider`, `api`, and `baseUrl` are forbidden override keys. Pi's
`models.json` `modelOverrides` always applies last.

**Viewing the compiled result**: `/provider-metadata` refreshes the
upstream catalog, runs the same worker compile, writes the rendered
text to a private temp file (0700 dir / 0600 file under `os.tmpdir()`),
and notifies you with the file's absolute path — open it with any
editor or pager. The file lists the effective config, data versions,
per-model matched rules, the concrete entries with supplied fields and
their per-field source (`[canonical]` = unified canonical table,
unmarked = provider record), the full candidate list with match level
and selection/skip reasons, `[unresolved]` markers, and final
overrides — never the API key. Files are retained for your session and
reclaimed by the system temp cleaner.

**Opt out** of all external enrichment with a root `chain: []` (and no
rule chains), then refresh. Offline restore and `allowNetwork: false`
refreshes read no config and touch no data. If a data package is missing
or malformed, that site degrades — the upstream-mapped catalog still
publishes with a transient note; if the upstream catalog itself fails, Pi
keeps the persisted catalog. The inference path never reads metadata.

**Legacy fields** from the old selector design are gone: `source_priority`,
`provider_prefix_map`, `lookup_ids`, `models_dev_subscription`, `channels`,
`global_fallback`, and the mapping form of `models:` each raise a config
error that names the exact path and the new equivalent — rewrite them as
`chain` entries, literal providers, `@creator`, and `models:` rule lists.

**Updating the data**: the packages are unpinned. `pi update` refreshes
them only when the extension itself gets a new commit; between releases,
run `bun update @opencode-ai/models modelparams` in the extension dir
(`~/.pi/agent/git/<host>/<owner>/openai-api-pi-extension`).

**Warning**: `fill_missing_only` defaults to `false`, so external values
*override* the gateway's own limits and may claim a larger context or
maxTokens than the upstream actually enforces. Scope overrides to the
providers that need them, e.g.

```yaml
models:
  - match: "openai/*"
    fill_missing_only: true
```

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
