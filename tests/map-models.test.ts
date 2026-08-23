import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchModels, mapModel, normalizeBaseUrl } from "../index.ts";

test("normalizeBaseUrl trims, strips slashes, rejects non-http", () => {
  assert.equal(normalizeBaseUrl("  https://gw.example.com/v1/  "), "https://gw.example.com/v1");
  assert.equal(normalizeBaseUrl("http://10.0.0.1:9000/v1///"), "http://10.0.0.1:9000/v1");
  assert.equal(normalizeBaseUrl("ftp://nope"), undefined);
  assert.equal(normalizeBaseUrl("https://user:secret@gw.example/v1"), undefined);
  assert.equal(normalizeBaseUrl("https://gw.example/v1?token=secret"), undefined);
  assert.equal(normalizeBaseUrl("https://gw.example/v1#fragment"), undefined);
  assert.equal(normalizeBaseUrl("not a url"), undefined);
  assert.equal(normalizeBaseUrl(undefined), undefined);
  assert.equal(normalizeBaseUrl("   "), undefined);
});

test("mapModel keeps identity id, falls back to defaults", () => {
  const model = mapModel({ id: "vendor/model-5" });
  assert.equal(model?.id, "vendor/model-5");
  assert.equal(model?.name, "vendor/model-5");
  assert.equal(model?.reasoning, true);
  assert.equal(model?.provider, "openai-api-extension");
  assert.equal(model?.api, "openai-responses");
  assert.equal(model?.baseUrl, "https://api.openai.com/v1");
  assert.equal(model?.contextWindow, 128000);
  assert.equal(model?.maxTokens, 16384);
  assert.deepEqual(model?.input, ["text"]);
});

test("mapModel prefers display_name and honors upstream limits", () => {
  const model = mapModel({
    id: "gpt-x",
    display_name: "GPT X",
    context_window: 400000,
    max_output_tokens: 128000,
  });
  assert.equal(model?.name, "GPT X");
  assert.equal(model?.contextWindow, 400000);
  assert.equal(model?.maxTokens, 128000);
});

test("mapModel accepts context_length and max_tokens aliases", () => {
  const model = mapModel({ id: "m", context_length: 64000, max_tokens: 8192 });
  assert.equal(model?.contextWindow, 64000);
  assert.equal(model?.maxTokens, 8192);
});

test("mapModel rejects entries without usable id", () => {
  assert.equal(mapModel({}), undefined);
  assert.equal(mapModel({ id: "   " }), undefined);
  assert.equal(mapModel({ id: 42 }), undefined);
  assert.equal(mapModel(null), undefined);
  assert.equal(mapModel([]), undefined);
});

test("catalog HTTP errors do not expose endpoint or API key", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, { status: 401 });
  try {
    await assert.rejects(
      fetchModels("https://gateway.example/private/account-42/v1", "secret-key"),
      (error: Error) => {
        assert.equal(error.message, "Model discovery failed: HTTP 401");
        assert.doesNotMatch(error.message, /gateway|account-42|secret-key/);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
