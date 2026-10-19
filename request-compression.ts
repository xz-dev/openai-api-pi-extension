/**
 * Thin boundary over the host's shared request-compression fetch wrapper.
 * The helper owns all codecs and the process-memory downgrade ladder; this
 * module holds no codec state. Applied only at the final HTTP send so JSON
 * request bodies stay readable upstream (WS/bridge paths parse raw JSON first).
 *
 * Requires the host compression and label exports listed in
 * docs/request-compression.md from @earendil-works/pi-ai. Older hosts fail
 * at module load — no silent uncompressed fallback.
 */
export {
  createRequestCompressionFetch as compressionFetch,
  getRequestCompressionEncoding,
  getWebSocketCompressionEncoding,
  getWebSocketCompressionPolicy,
  transportLabel,
} from "@earendil-works/pi-ai";
