# Request compression

The extension uses Pi's shared transport compression automatically. No plugin
setting is required. Smaller uploads preserve model input, including image data;
they do not imply fewer tokens or guaranteed latency savings.

Pi owns the codec ladder, refusal classification and process-local capability
state. See the [host compression guide](https://github.com/xz-dev/pi/blob/main/docs/request-compression.md)
for those rules and their limits.

## Host requirement

Use xz-dev/pi
[1.3.0-xz.328.1.g2e2d9ad8](https://github.com/xz-dev/pi/releases/tag/xz-v1.3.0-xz.328.1.g2e2d9ad8)
or newer. Update Pi before updating this extension, then restart Pi. Other hosts
must export these functions from `@earendil-works/pi-ai`:

- `createRequestCompressionFetch`
- `getWebSocketCompressionPolicy`
- `getRequestCompressionEncoding`
- `getWebSocketCompressionEncoding`
- `transportLabel`

The declared peer-version range alone does not establish these capabilities.
An older host without the exports fails when loading the extension; there is no
production fallback to a local helper or an environment-selected module.

## How it fits the transport bridge

| Requested transport | Compression path |
| --- | --- |
| `sse` | Shared HTTP encoder at the final upload |
| `websocket` / `websocket-cached` | Negotiated WebSocket `permessage-deflate` |
| `auto` | WebSocket negotiation first; an allowed HTTP fallback uses the shared HTTP encoder |

Pi's Responses adapter still serializes the request and parses the response.
The bridge receives plain JSON, parses it, and selects a transport. Only the
final HTTP sender compresses the body. Encoding before the bridge would break
its JSON parser.

The extension imports the host policy rather than copying codecs or keeping a
second downgrade cache. A refusal remembered by that policy stays remembered
for its endpoint/credential scope until process exit. Missing response
`Accept-Encoding` does not disable probing.

WebSocket application messages remain JSON. Gzip/zstd HTTP bodies are never sent
as WebSocket application frames.

## See the active algorithm

The default Working label appends one space and the algorithm: `SSE Zstd`,
`SSE gzip`, `SSE DEFLATE`, `SSE Brotli`, or `WS/continuation DEFLATE`.
HTTP uses the final upload encoding after any refusal fallback. WebSockets
show `DEFLATE` only after `permessage-deflate` negotiation, including pooled
connections. Uncompressed or unobservable compression adds nothing.
These labels describe the endpoint connection, not a proxy's upstream hop.

## Recovery and storage stay separate

Compression does not choose a transport, reset recovery cooldowns, authorize
extra inference retries or change remote storage. A compression refusal and a
WebSocket failure are different signals with different owners.

[Response checkpoints](response-checkpoints.md) can request `store: true` on
eligible cached transports. Their privacy, admission and no-replay rules still
apply; enabling compression does not make a failed durable request safe to
repeat over SSE.

## Checks and development

[Compression integration tests](../tests/request-compression.test.ts) cover direct
SSE, permitted fallback and actual compressed WebSocket frames. Packed installs
were also checked against the published downstream executable using loopback
servers, without replacing its SDK exports. This does not establish universal
real-gateway compatibility.

When development dependencies predate the host exports, set
`PI_REQUEST_COMPRESSION_HELPER` to the updated host source
`packages/ai/src/utils/request-compression.ts` for local tests. The test-only
preload loads its sibling `websocket-compression.ts` and `event-stream.ts` as well. This is not a
production fallback; no machine-specific path is embedded in the package.

Return to [setup and transport selection](../README.md), or read
[Pi's HTTP fallback and WebSocket policy](https://github.com/xz-dev/pi/blob/main/docs/request-compression.md).
