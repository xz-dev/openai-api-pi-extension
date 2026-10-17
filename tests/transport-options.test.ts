import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

// Observe the real SDK adapter boundary; do not replace its serializer/parser.
const compat = import.meta.resolve("@earendil-works/pi-ai/compat");
const wrapper = `
  export * from ${JSON.stringify(compat)};
  import { openAIResponsesApi as original } from ${JSON.stringify(compat)};
  export const calls = [];
  export function openAIResponsesApi() {
    const api = original();
    for (const method of ['stream', 'streamSimple']) {
      const stream = api[method];
      api[method] = (model, context, options) => {
        calls.push({ method, options });
        return stream(model, context, options);
      };
    }
    return api;
  }
`;
const url = `data:text/javascript,${encodeURIComponent(wrapper)}`;
const hook = registerHooks({ resolve(specifier, context, next) {
  return specifier === "@earendil-works/pi-ai/compat" ? { url, shortCircuit: true } : next(specifier, context);
} });
const { createOpenAIApiProvider } = await import("../index.ts");
const { calls } = await import(url);
hook.deregister();

for (const method of ["stream", "streamSimple"] as const) {
  test(`${method} forwards raw optional values/absence without native policy defaults`, async () => {
    const provider = createOpenAIApiProvider();
    const model = { id: "mock-options", name: "Mock", provider: "openai-api-extension", api: "openai-responses" as const,
      baseUrl: "http://127.0.0.1:1/v1", reasoning: false, input: ["text"] as ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024 };
    for (const raw of [{}, { responseCheckpointExclude: undefined }, { responseCheckpointExclude: [] },
      { responseCheckpointExclude: ["*"] }, { responseCheckpointExclude: ["provider/**", "model"] }]) {
      const controller = new AbortController();
      controller.abort();
      const options = { ...raw, apiKey: "dummy-options-key", signal: controller.signal, maxRetries: 0,
        transport: "auto" as const, sessionId: "options", timeoutMs: 1234,
        onTransport: () => { throw new Error("should not notify aborted request"); } };
      await provider[method](model, { messages: [{ role: "user", content: "one", timestamp: 1 }] }, options).result();
      const received = calls.at(-1).options;
      assert.equal(received.transport, "sse");
      assert.equal(received.onTransport, undefined);
      assert.equal(typeof received.fetch, "function");
      for (const key of ["responseCheckpointExclude", "cacheRetention", "websocketConnectTimeoutMs", "timeoutMs", "signal"]) {
        assert.equal(Object.hasOwn(received, key), Object.hasOwn(options, key), `${key}: preserve absence`);
        assert.equal(received[key], options[key], `${key}: preserve raw value/reference`);
      }
      assert.equal(options.transport, "auto");
      assert.equal(typeof options.onTransport, "function");
    }
  });
}
