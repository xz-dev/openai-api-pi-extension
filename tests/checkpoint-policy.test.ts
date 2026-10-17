import assert from "node:assert/strict";
import { test } from "node:test";
import { checkpointsEnabled } from "../checkpoint-adapter.ts";

test("checkpoint policy: raw validation and minimatch identity/segment semantics", () => {
  const model: any = { provider: "openai-api-extension", id: "mock/nested", name: "Display Only",
    baseUrl: "http://127.0.0.1/v1", compat: { supportsResponseCheckpoints: true } };
  const options: any = { transport: "auto", apiKey: "dummy" };
  const cases: [string, unknown, boolean][] = [
    ["absent", undefined, true], ["empty", [], true], ["star includes slash", ["*"], false],
    ["provider", ["OPENAI-API-*"], false], ["model", ["MOCK/*"], false],
    ["combined", ["OPENAI-API-EXTENSION/MOCK/*"], false],
    ["braces", ["{other,mock}/nested"], false], ["class", ["mock/[no]ested"], false],
    ["globstar", ["openai-api-extension/**"], false],
    ["segment is not globstar", ["openai-api-extension/*"], true],
    ["display name ignored", ["Display Only"], true], ["unrelated", ["other/**"], true],
    ["null", null, false], ["string", "*", false], ["object", {}, false],
    ["invalid member", ["unrelated", 1], false], ["null member", [null], false],
    ["sparse", Array(1), false],
  ];
  for (const [label, raw, enabled] of cases) {
    assert.equal(checkpointsEnabled(model, options, raw), enabled, label);
  }
});
