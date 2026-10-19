/** Test helper: decode a content-encoding'd request body. */
import { brotliDecompressSync, gunzipSync, inflateSync, zstdDecompressSync } from "node:zlib";
import type { IncomingMessage } from "node:http";

export async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
  const raw = Buffer.concat(chunks);
  const encoding = request.headers["content-encoding"];
  const body =
    encoding === "zstd" ? zstdDecompressSync(raw)
    : encoding === "gzip" ? gunzipSync(raw)
    : encoding === "deflate" ? inflateSync(raw)
    : encoding === "br" ? brotliDecompressSync(raw)
    : raw;
  return JSON.parse(body.toString("utf8"));
}
