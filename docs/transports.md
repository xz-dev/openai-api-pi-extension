# Transports

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
configuration. The host must meet the
[compression API requirement](request-compression.md#host-requirement).

The bridge uses Pi's existing request builder and response parser through its
public `fetch` injection point; it does not copy Pi's Responses protocol code.
[Provider entry](../index.ts) explicitly selects SSE **inside the SDK**, so newer
hosts cannot bypass the [bridge](../responses-websocket-fetch.ts) with a second
native WebSocket planner. The bridge keeps the caller's requested transport.
Only explicit `sse` keeps the direct HTTP path and hard-disables checkpoints.
Where the host exposes `onTransport(transport, model)`, bridge requests report
`WS/full`, `WS/continuation`, or actual fallback `SSE`, never the internal SSE
parser mode. Continuation labels describe the sent parent reference, not a
server cache hit. Observer failures do not retry inference.

## Credentials on the wire

An explicit `Authorization` header overrides `apiKey`. Request headers override
model headers case-insensitively. WebSocket authentication, socket/checkpoint
identity, recovery cooldowns and compression use the effective wire credential:
changing an unused API key keeps the socket/continuation; changing effective
Authorization isolates them. Alternate `cf-aig-authorization` authentication
sends no synthetic bearer header when Authorization is absent.

Optional settings, including `responseCheckpointExclude`, pass through without
plugin defaults or native `['*']` defaults being inserted. The actual bridge
owner applies [checkpoint policy and storage](response-checkpoints.md); eligible
durable requests have stricter replay limits than ordinary auto fallback.
Stopping the host's ordinary retries after a started reference repair requires
Pi's matching shared retry consumer; automatic overflow compaction remains a
[separate recovery exception](response-checkpoints.md#reference-repair-retry-fence).
Public context normalization is used only when available on the host, preserving
system prompts and tool declarations; compression itself requires the updated
host exports.

Because message conversion runs inside Pi's shared `transformMessages` step,
the extension itself resolves ancestry, then drops empty-content user/assistant
messages (for example watchdog inquiry fold markers) before delegating, so
filtering cannot erase an applicable ancestry fact. On hosts with native ancestry
guards, the existing payload hook exposes only a validated bridge-owned parent
before that guard. The bridge revalidates the final payload and wire identity;
this does not turn its parent into caller authority or permit parent-free replay.

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

## Request compression

Lossless HTTP and WebSocket compression reuses Pi's shared policy without changing
model input or image quality. The default Working label shows the active algorithm,
for example `SSE Zstd` or `WS/continuation DEFLATE`; uncompressed requests keep
the original protocol label. See
[compression and compatible hosts](request-compression.md) and the
[paired Pi guide](https://github.com/xz-dev/pi/blob/main/docs/request-compression.md).

## Response checkpoints

Cached transports can resume stored state across reconnects or session restarts.
Eligible requests ask for remote `store: true` by default; check the service's
retention policy or opt out with `responseCheckpointExclude: ["*"]`. See
[checkpoint settings, privacy and recovery](response-checkpoints.md) and the
[native Pi counterpart](https://github.com/xz-dev/pi/blob/main/docs/downstream-changes.md#response-checkpoints).
