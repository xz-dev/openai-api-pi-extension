import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchModels, mapCatalog, mapModel, normalizeBaseUrl } from "../index.ts";

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

test("mapModel rejects missing capability limits", () => {
  assert.throws(() => mapModel({ slug: "vendor/model-5" }), /vendor\/model-5.*capability limits/);
});

test("mapModel falls back to contextWindow when max tokens missing", () => {
  const model = mapModel({ slug: "glm-5.3", context_window: 1048576 });
  assert.equal(model?.contextWindow, 1048576);
  assert.equal(model?.maxTokens, 1048576);
});

test("mapModel keeps explicit max tokens over fallback", () => {
  const model = mapModel({ slug: "gpt-x", context_window: 272000, max_tokens: 128000 });
  assert.equal(model?.maxTokens, 128000);
});

test("mapCatalog is atomic: one bad entry rejects the whole catalog", () => {
  const good = { id: "good-model", context_window: 64000, max_tokens: 8192 };
  assert.throws(
    () => mapCatalog([good, { slug: "axis/codex-auto-review" }]),
    /axis\/codex-auto-review.*capability limits/,
  );
  assert.equal(mapCatalog([good]).length, 1);
  assert.throws(() => mapCatalog([]), /no usable models/);
});

test("mapModel prefers display_name and honors upstream limits", () => {
  const model = mapModel({
    slug: "gpt-x",
    display_name: "GPT X",
    context_window: 400000,
    max_tokens: 128000,
  });
  assert.equal(model?.id, "gpt-x");
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

test("fetchModels requests Codex catalog and rejects plain OpenAI shape", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  globalThis.fetch = async (input) => {
    requestedUrl = String(input);
    return Response.json({ data: [{ id: "gpt-x" }] });
  };
  try {
    await assert.rejects(fetchModels("https://gateway.example/v1", "secret-key"), /Codex model catalog/);
    assert.equal(requestedUrl, "https://gateway.example/v1/models?client_version=0.84.2");
  } finally {
    globalThis.fetch = originalFetch;
  }
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
