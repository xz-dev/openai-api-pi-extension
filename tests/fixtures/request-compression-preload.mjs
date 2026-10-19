// Test-only preload: when PI_REQUEST_COMPRESSION_HELPER names a module that
// exports createRequestCompressionFetch (e.g. a host source file whose installed
// pi-ai predates the export), remap the "@earendil-works/pi-ai" root and
// "/compat" specifiers to a generated wrapper reexporting the real module plus
// that helper. Covers both plain node resolution and the extension loader's
// jiti alias (@earendil-works/pi-ai -> /compat). No effect when unset.
import { registerHooks } from "node:module";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";

// Propagate this preload to `node --test` child processes only.
const self = import.meta.url;
if (!(process.env.NODE_OPTIONS ?? "").includes(self)) {
  process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ""} --import ${JSON.stringify(self)}`.trim();
}

const helper = process.env.PI_REQUEST_COMPRESSION_HELPER?.trim();
if (helper) {
  const helperUrl = helper.includes("://")
    ? helper
    : pathToFileURL(isAbsolute(helper) ? helper : `${process.cwd()}/${helper}`).href;
  const dir = mkdtempSync(join(tmpdir(), "pi-ai-compression-shim-"));
  const root = import.meta.resolve("@earendil-works/pi-ai");
  const compat = import.meta.resolve("@earendil-works/pi-ai/compat");
  const shim = (target) => {
    const file = join(dir, `shim-${shim.counter++}.mjs`);
    writeFileSync(file,
      `export * from ${JSON.stringify(target)};\n` +
      `export { createRequestCompressionFetch, getRequestCompressionEncoding } from ${JSON.stringify(helperUrl)};\n` +
      `export { transportLabel } from ${JSON.stringify(new URL("./event-stream.ts", helperUrl).href)};\n` +
      `export { getWebSocketCompressionEncoding, getWebSocketCompressionPolicy } from ${JSON.stringify(new URL("./websocket-compression.ts", helperUrl).href)};\n`);
    return pathToFileURL(file).href;
  };
  shim.counter = 0;
  const rootUrl = shim(root);
  const compatUrl = shim(compat);
  registerHooks({
    resolve(specifier, context, next) {
      if (specifier === "@earendil-works/pi-ai") return { url: rootUrl, shortCircuit: true };
      if (specifier === "@earendil-works/pi-ai/compat") return { url: compatUrl, shortCircuit: true };
      return next(specifier, context);
    },
  });
}
