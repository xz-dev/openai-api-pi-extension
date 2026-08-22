import assert from "node:assert/strict";
import { test } from "node:test";
import { mapModel, normalizeBaseUrl } from "../index.ts";

test("normalizeBaseUrl trims, strips slashes, rejects non-http", () => {
  assert.equal(normalizeBaseUrl("  https://gw.example.com/v1/  "), "https://gw.example.com/v1");
  assert.equal(normalizeBaseUrl("http://10.1.1.22:8086/v1///"), "http://10.1.1.22:8086/v1");
  assert.equal(normalizeBaseUrl("ftp://nope"), undefined);
  assert.equal(normalizeBaseUrl("not a url"), undefined);
  assert.equal(normalizeBaseUrl(undefined), undefined);
  assert.equal(normalizeBaseUrl("   "), undefined);
});

test("mapModel keeps identity id, falls back to defaults", () => {
  const model = mapModel({ id: "zproxy/glm-5.3" });
  assert.equal(model?.id, "zproxy/glm-5.3");
  assert.equal(model?.name, "zproxy/glm-5.3");
  assert.equal(model?.reasoning, true);
  assert.equal(model?.contextWindow, 128000);
  assert.equal(model?.maxTokens, 16384);
  assert.deepEqual(model?.input, ["text"]);
});

test("mapModel prefers display_name and honors upstream limits", () => {
  const model = mapModel({
    id: "gpt-5.6",
    display_name: "GPT-5.6",
    context_window: 400000,
    max_output_tokens: 128000,
  });
  assert.equal(model?.name, "GPT-5.6");
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
});
