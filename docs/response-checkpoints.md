# Response checkpoints

A checkpoint can resume stored Responses state after a reconnect or session
restart: send an existing response ID and new input instead of the whole
conversation. Full local JSONL history remains authoritative.

**Privacy:** eligible `auto` and `websocket-cached` requests ask for remote
`store: true` by default, including on third-party gateways. Confirm the
service's retention policy. Use `responseCheckpointMode: "declared"` to require
an explicit capability, or `responseCheckpointExclude: ["*"]` to opt out.

The [native Pi counterpart](https://github.com/xz-dev/pi/blob/main/docs/downstream-changes.md#response-checkpoints)
has its own request owner. The extension uses one bridge when loaded on the
fork, not a second native WebSocket planner.

## Choose when to request storage

`responseCheckpointMode` selects the capability policy:

| Mode | Meaning |
| --- | --- |
| `always` (default when absent) | Request checkpoints on eligible endpoints even when `compat.supportsResponseCheckpoints` is `false` |
| `auto` | Request unless the model declares `compat.supportsResponseCheckpoints: false` |
| `declared` | Request only with an exact `compat.supportsResponseCheckpoints: true` declaration, or the official OpenAI service |

Malformed mode values disable checkpoints. All modes still enforce transport,
authentication, history and explicit payload exclusions. SSE, uncached
`websocket`, unsupported Codex/ChatGPT modes and `cacheRetention: "none"` do not
enable this extension feature.

`responseCheckpointExclude` is an independent per-target opt-out. Absent and
`[]` allow otherwise eligible targets; `["*"]` excludes all. To opt out in
`~/.pi/agent/settings.json`:

```json
{
  "responseCheckpointExclude": ["*"]
}
```

To require declared capability while using cached transport:

```json
{
  "transport": "auto",
  "responseCheckpointMode": "declared",
  "responseCheckpointExclude": []
}
```

Matching uses `minimatch` **10.2.6**, `{ nocase: true }`, against provider ID,
model ID and `provider/model`, not display names. Any match excludes; order does
not create exceptions. Literal `"*"` also excludes slash-containing IDs. Other
patterns retain segment/globstar, braces and character classes, for example
`["openai-api-extension/**", "gpt-[45]*"]`. Malformed values or non-string
members disable checkpoints. Trusted project settings replace the global list;
untrusted project values are ignored. Incoming request options take precedence
when the property is present. Raw absence stays absent until the actual request
owner applies policy.

## Declare a verified endpoint

Supported API-key mode at `https://api.openai.com/v1` has the official-service
default. In `declared` mode, a custom service needs an exact capability
declaration after persistent Responses support has been verified for that
endpoint/account. `always` and `auto` can try without this declaration; the
cooldown below bounds a failed guess.

For an **already discovered** model, merge this override into
`~/.pi/agent/models.json`, replacing `your-model-id` with its catalog ID:

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
Configure endpoint/auth and use ordinary provider discovery first. Do not edit
the catalog store directly.

Eligible requests set `store: true` before the payload hook. Hook `store: false`
prevents durable use and capture; server `store: false` prevents capture. No
TTL, answer cache, KV-cache hit, lower bill or server-retention guarantee is
invented. [Request compression](request-compression.md) reduces bytes without
changing these storage rules.

## Verification cooldown

The first proven pre-execution reference failure repairs the turn once with
full history, without `store` or `previous_response_id`, then starts a
five-minute per-endpoint/session cooldown. Recognized failures include
`previous_response_not_found`, a code-less `previous_response_id is not
available` rejection, rejection of `store`, and a previous-response capability
rejection.

During cooldown, send full history without storage. After the deadline, the
next real request probes once with `store: true` and full history. Success
clears the state; failure renews it. No background probes or persisted cooldown.

## Reconnect without checkpoint metadata

The bridge also keeps the latest confirmed anchor in memory for each exact
endpoint, credential, header set and session. After an idle close, a new socket
can send that response ID and only the new input, even when the assistant message
has no persisted checkpoint metadata. The envelope and encoded history prefix
must still match; the transport label reports `WS/continuation`.

An in-memory anchor requires sent `store: true`, a successful completion explicitly
acknowledging `store: true`, and complete local history with verified encoded
output. Omitted or false storage acknowledgement cannot create this anchor.
Failed or partial turns never replace it. The cache holds at most 32 identities,
expires anchors after ten minutes without extending their age on use, and clears
them on session shutdown, cooldown, recovery probes and reference rejection.
These are client bounds, not a server-retention guarantee. A cache miss sends full
history; durable message checkpoints below remain a separate restore path.

## Restore and safe failure

A completed stored assistant response with independently complete local history
can carry bounded v1 metadata: `scopeHash`, `requestHash`, `prefixHash`
(SHA-256), `inputCount`, `createdAt`, optional known `expiresAt`, and `version`.
The ID stays in existing `responseId`; metadata holds neither payload snapshots
nor credentials. There is no side database.

The latest assistant on the active branch is the only candidate. Restore or
rollback uses it only when actual endpoint/account/header scope, the request
envelope and the exact encoded history prefix still match, including tools and
opaque reasoning. Invalid/expired metadata, edited history, changed scope or
envelope, unknown versions, incomplete output and unsafe suffixes send full
history. A caller-owned parent is not replaced or declared full history.

At most one WS repair is allowed for a proven pre-execution reference rejection
with genuine complete local history. The existing strict message-ID repair
includes the exact WS 1008 signature, not arbitrary policy closes. There is no
replay after output, auth failure, unknown execution or caller-dependent
ancestry; no hidden provider retry or HTTP/SSE replay after a failed repair.
Explicit SSE and allowed auto WS-to-SSE fallback never carry policy
`store: true`; a hook's `store: false` is kept.

## Source and validation scope

- [Provider entry](../index.ts), [policy/host adapter](../checkpoint-adapter.ts),
  [WS bridge](../responses-websocket-fetch.ts) and
  [portable kernel](../response-checkpoints.ts).
- [Durable-provider tests](../tests/durable-provider.test.ts),
  [policy tests](../tests/checkpoint-policy.test.ts),
  [cooldown tests](../tests/checkpoint-cooldown.test.ts),
  [cross-socket tests](../tests/cross-connection-continuation.test.ts) and
  [production-codec tests](../tests/production-codec.test.ts).
- Native Pi: [settings](https://github.com/xz-dev/pi/blob/main/packages/coding-agent/docs/settings.md#response-checkpoints),
  [endpoint capabilities](https://github.com/xz-dev/pi/blob/main/packages/coding-agent/docs/models.md#response-checkpoint-capability)
  and [SDK policy](https://github.com/xz-dev/pi/blob/main/packages/ai/README.md#response-checkpoints).

The public host codec prepares checkpoint output without network I/O;
unsupported reconstruction declines the optimization. Adapter scope prevents
assuming that checkpoints are portable across adapters.

Evidence uses loopback fixtures, not universal real-gateway retention or
account-isolation checks. Verify persistence for the actual service/account.
Current host requirements are in the [compression guide](request-compression.md#host-requirement).

<details>
<summary>Earlier checkpoint-only validation record</summary>

This record predates the shared-compression dependency. Stock 0.84.2 results do
not establish compatibility with the current extension revision.

Loopback validation passed 222/222 plugin tests on each of stock Pi 0.84.2 and
fork 1.3. Independent reruns passed eight targeted plus four frozen cases on each
host. Separate CLI gates used four native-only processes and eight combined
stock/fork plugin processes, including restart with raw absent and `["*"]`
policies. Fork CLI input retained its actual command-line provenance, not a
fabricated human/direct-terminal origin; stock retained its legacy format.
Successful pairs had exact reconstructed input and zero HTTP inference. Model
discovery and failed setup attempts were separate from those successful counts.

Network-namespace-isolated loopback checks passed all 10 processes: Bun
single-executable Pi 1.3.0-xz.306 with the installed plugin, native candidate
source under Bun 1.4.3, and stock 0.84.2 with the installed plugin. All exited 0
with zero HTTP inference. Those runs tested the checkpoint defaults at that
revision, not the current `responseCheckpointMode` policy.

Packed-plugin installs via `pi install npm:...@<tgz>` passed on the Bun
single-executable and stock 0.84.2 hosts, with online dependency access: six
runtime packages and no Pi SDK. An earlier offline `ENOTCACHED` attempt was a
cache miss, not an unresolved installer failure.

With model data hydrated separately, main `41be7dc` plus that candidate passed
TypeScript and full checks, with 206 AI tests and 179 settings tests. An earlier
Kimi TS2322 came from foreign catalog data; owner-branch fixtures were corrected
upstream. These are historical validation receipts, not a deployment guarantee.

</details>

Return to [setup and transports](../README.md), or read the
[paired Pi checkpoint documentation](https://github.com/xz-dev/pi/blob/main/docs/downstream-changes.md#response-checkpoints).
