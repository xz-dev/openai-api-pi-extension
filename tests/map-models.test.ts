import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchModels, isConversationalTextModel, mapCatalog, mapModel, normalizeBaseUrl } from "../index.ts";

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

test("mapModel falls back to default context window when limits missing (omniroute semantics)", () => {
  const model = mapModel({ slug: "vendor/model-5" });
  assert.equal(model?.contextWindow, 128_000);
  assert.equal(model?.maxTokens, 128_000);
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

test("mapCatalog is atomic for invalid entries; missing limits never reject", () => {
  const good = { id: "good-model", context_window: 64000, max_tokens: 8192 };
  const noLimits = { slug: "axis/codex-auto-review" };
  assert.equal(mapCatalog([good, noLimits]).length, 2);
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
  assert.equal(model?.reasoning, false);
  assert.equal(model?.thinkingLevelMap, undefined);
  assert.deepEqual(model?.input, ["text"]);
});

test("mapModel copies Codex reasoning levels and image input", () => {
  const model = mapModel({
    slug: "gpt-5.6-sol",
    display_name: "GPT 5.6 Sol",
    context_window: 272000,
    max_tokens: 128000,
    input_modalities: ["text", "image"],
    supported_reasoning_levels: [
      { effort: "low" },
      { effort: "medium" },
      { effort: "high" },
      { effort: "xhigh" },
      { effort: "max" },
      { effort: "ultra" },
    ],
  });
  assert.equal(model?.reasoning, true);
  assert.deepEqual(model?.thinkingLevelMap, {
    off: null,
    minimal: "low",
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: "xhigh",
    max: "max",
  });
  assert.equal((model?.thinkingLevelMap as Record<string, unknown> | undefined)?.ultra, undefined);
  assert.deepEqual(model?.input, ["text", "image"]);
});

test("mapModel accepts OmniRoute effort_tiers and fails closed for none-only", () => {
  const glm = mapModel({
    slug: "glm-5.3",
    context_window: 1048576,
    capabilities: { effort_tiers: ["low", "medium", "high"] },
  });
  assert.deepEqual(glm?.thinkingLevelMap, {
    off: null,
    minimal: "low",
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: null,
    max: null,
  });
  const none = mapModel({
    slug: "no-think",
    context_window: 64000,
    supported_reasoning_levels: ["none", "ultra"],
  });
  assert.equal(none?.reasoning, false);
  assert.equal(none?.thinkingLevelMap, undefined);
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

test("catalog HTTP errors redact an echoed API key", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("upstream rejected secret-key", { status: 401 });
  try {
    await assert.rejects(
      fetchModels("https://gateway.example/v1", "secret-key"),
      (error: Error) => {
        assert.equal(error.message, "Model discovery failed: HTTP 401: upstream rejected [REDACTED]");
        assert.doesNotMatch(error.message, /secret-key/);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("catalog HTTP errors include a short response body", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("Bad Gateway", { status: 502 });
  try {
    await assert.rejects(
      fetchModels("https://gateway.example/v1", "secret-key"),
      (error: Error) => {
        assert.equal(error.message, "Model discovery failed: HTTP 502: Bad Gateway");
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("mapCatalog filters non-chat models before mapping (omniroute semantics)", () => {
  const chat = { id: "chat-model", context_window: 64000, max_tokens: 8192 };
  // image/video model without capability limits must be filtered, not fatal
  const imageNoLimits = { slug: "supergrok/grok-imagine-image-2.0" };
  const byType = { id: "embedding/model", type: "embedding", context_window: 8192 };
  const bySegment = { id: "video/clip-4", context_window: 8192 };
  const byOutput = { id: "image-out", context_window: 8192, output_modalities: ["image"] };
  const models = mapCatalog([chat, imageNoLimits, byType, bySegment, byOutput]);
  assert.equal(models.length, 1);
  assert.equal(models[0].id, "chat-model");
});

test("isConversationalTextModel keeps image INPUT but rejects image OUTPUT", () => {
  assert.equal(
    isConversationalTextModel({ id: "vision-chat", context_window: 8192, input_modalities: ["text", "image"] }),
    true,
  );
  assert.equal(
    isConversationalTextModel({ id: "gen-image", context_window: 8192, output_modalities: ["image"] }),
    false,
  );
  assert.equal(isConversationalTextModel({ slug: "grok-imagine-video-1.5", context_window: 8192 }), false);
  assert.equal(isConversationalTextModel({ slug: "plain-text-model", context_window: 8192 }), true);
});
