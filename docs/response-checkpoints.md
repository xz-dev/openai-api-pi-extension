# Response checkpoints

A checkpoint can resume stored Responses state after a reconnect or session
restart: send an existing response ID and new input instead of the whole
conversation. Local JSONL history remains authoritative when it contains the
whole lineage, or when Pi explicitly adopts a summary plus retained messages.
Caller-owned parents can include history that exists only on the server.

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
enable this extension feature. Absent transport resolves to `auto` for both
provider stream entry points. The official OpenAI API-key guard checks effective
Authorization, including model/request header overrides, not an unused `apiKey`.

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

The first proven pre-execution reference failure starts a two-minute
per-endpoint/session/effective-header-identity cooldown and repairs the turn
once with full history, without `store` or `previous_response_id`. Recognized failures include
`previous_response_not_found`, a code-less `previous_response_id is not
available` rejection, rejection of `store`, and a previous-response capability
rejection.

During cooldown, send full history without storage; an explicit `store: false`
veto and caller-owned ancestry remain intact. After the deadline, one real
request probes with `store: true` and full history while overlapping requests
stay checkpoint-free. Failed admitted/sent probes step to three, four and at
most five minutes. A rejection and its failed full-history repair count as one
logical probe: renew the same deadline, never advance twice or release ownership
while repair runs. A completed probe with no captured checkpoint also renews.

Only a valid captured checkpoint resets progression; only its owning probe can
clear the active deadline. Aborted or unsent attempts only release their claim;
SSE-only requests do not claim it. Checkpoint and transport cooldowns progress
independently. No background probes or persisted cooldown.

## Reconnect without checkpoint metadata

The bridge also keeps the latest confirmed anchor in memory for each exact
endpoint, credential, header set and session. After an idle close, a new socket
can send that response ID and only the new input, even when the assistant message
has no persisted checkpoint metadata. The envelope and encoded history prefix
must still match; the transport label reports `WS/continuation`.

An in-memory anchor requires sent `store: true`, a successful completion explicitly
acknowledging `store: true`, and verified encoded output. Omitted or false storage
acknowledgement cannot create this anchor. A caller-owned parent retires any older
local anchor. Its latest confirmed stored descendant may chain under the same
identity, envelope and exact-prefix checks, but cannot certify complete local
history or authorize parent-free repair. Failed or partial turns never replace
an anchor. Delayed completion cannot restore an invalidated or superseded anchor.
The cache holds at most 32 identities, expires anchors after ten minutes without
extending their age on use, and clears them on session shutdown, cooldown,
recovery probes and reference rejection. These are client bounds, not a
server-retention guarantee. Cache loss removes reuse permission, not ancestry:
local history may send full input; known-dependent history must find a validated
latest chain or fail. Durable message checkpoints below remain a separate restore
path.

On hosts with native ancestry guards, the extension uses the existing `onPayload`
hook after the caller's hook to prepare only an independently validated live
connection or stored-anchor continuation. Preparation performs no network I/O,
keeps the full logical input, and creates no checkpoint or host exemption. The
bridge revalidates final payload, endpoint, model/session, effective credential
and header identity, exact prefix, source lifetime and storage proof before
transport. Later mutation, expiration or invalidation fails closed. The generated
parent stays bridge-owned; it cannot authorize caller takeover, parent-free repair
or SSE fallback. An actual caller-supplied parent remains caller-owned.

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
envelope, unknown versions, incomplete output and unsafe suffixes disable reuse.
Only local or legacy-compatible history may then send full input. A caller-owned
parent is not replaced or declared full history by durable planning.

## Ancestry and summary boundaries

New assistant messages carry optional `responseAncestry`: exact `local` or
`server-dependent`. This fact survives ordinary host JSONL/export/fork persistence,
independent of checkpoint settings, remote storage and socket lifetime. It stays
out of provider JSON, headers, transport labels and conversation text. Both
`stream` and `streamSimple` resolve it before empty-message filtering, including
explicit SSE (which opens no WebSocket for bookkeeping) and auto fallback.

- `local`: independently local input; losing an optimization permits full-input
  fallback. Completion, storage and output-reconstruction gates still govern
  checkpoint capture and repair.
- `server-dependent`: actual caller-owned wire parent or inherited dependent
  ancestry. Use only the latest independently validated chain; otherwise fail
  before a parent-free WS/HTTP request. No complete-history checkpoint or repair.
- Genuinely absent: preserve legacy fallback and capture eligibility. This is
  compatibility trust, not independently verified local history; descendants
  remain unmarked until a real new local baseline.
- Present but malformed (including `null`, own `undefined`, wrong type or unknown
  value): unknown, not absent. An independently validated chain can still work,
  but malformed data grants no complete-history privilege. Subsequent output
  remains conservatively server-dependent.

**Accepted legacy risk:** old unmarked local and caller-rooted histories can be
indistinguishable. Compatibility fallback can omit server-only ancestry in old
caller-rooted conversations. This does not guarantee universally safe legacy
continuation.

Actual structured compaction or branch-summary projection adopts summary plus
retained messages as new local input. The host projects pre-boundary retained
assistants as local copies and conveys the baseline through the same non-wire
fact on its converted user summary. Adopted assistant copies, not a user/local
field, establish that baseline. Ordinary user metadata cannot clear preceding
dependent, malformed or legacy ancestry. Stored history is not rewritten. Old
checkpoints still need exact-prefix validation. A later caller takeover remains
dependent even while that old summary stays in context. Plain edits, empty
filtering, forks, rollback, identity changes and cache loss are not rebases.

The extension consumes this typed `Context` seam; summary text is never inspected.
When the host exposes its public context event and session projection, the
extension associates the complete ordered cloned input with the canonical
projection, raw source-entry IDs and active branch positions. Only genuine
structured compaction/branch-summary entries adopt copied assistants. Unmatched,
ambiguous, reordered or replaced third-party input is not adopted. Already
corrected native projection is a no-op. An old host's ordinary omission of an
unsafe or legacy assistant retains its fact or genuine absence in an empty copy;
omission is not local-history proof. Event input, raw entries and JSONL stay
unchanged. A later dependent output remains negative, including across a model
switch. Actual supported-host projection and persistence propagation require
paired host integration validation; component fixtures alone do not establish
that gate.

## Reference-repair retry fence

At most one provider-local WS repair is allowed for a proven pre-execution
reference rejection with genuine complete local history. The existing strict
message-ID repair includes the exact WS 1008 signature, not arbitrary policy
closes. Auth failure, unknown execution and caller-dependent ancestry do not
permit this repair. A failed repair cannot trigger another provider-local retry
or HTTP/SSE replay, including when checkpoints are disabled.

If the repair starts yielding mapped response events and then fails without an
abort, its current error output carries a `provider_reference_repair_terminal`
diagnostic containing only `type` and `timestamp`. A Pi host with the matching
shared retry consumer blocks ordinary automatic retries of that output. Older
hosts can still load the plugin, but do not provide this outer-retry guarantee.
Later unrelated requests are not poisoned.

Automatic overflow recovery remains a separate exception: when enabled, the
host may omit the failed attempt from active context, compact history and
continue the interrupted turn with a smaller request. The original partial
output remains in append-only session JSONL; it need not remain in active model
context. A response-start event or overflow error text alone does not prove that
nothing was generated before failure. This exception is not an exactly-once
execution guarantee.

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
