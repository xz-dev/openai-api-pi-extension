import assert from "node:assert/strict";
import { test } from "node:test";

import { parseMetadataConfigValue } from "../src/metadata-config.ts";
import { compileModelPattern, selectModels } from "../src/metadata-glob.ts";
import { MetadataConfigError } from "../src/model-metadata.ts";

test("model glob compilation preserves matching and config validation", () => {
  for (const [glob, id, expected] of [
    ["proxy/*", "proxy/m", true],
    ["proxy/*", "proxy/a/m", false],
    ["proxy/**", "proxy/a/m", true],
    ["proxy/*", "proxy/.hidden", true],
    ["proxy/*", "Proxy/m", false],
    ["!m", "!m", true],
    ["!m", "m", false],
    ["#m", "#m", true],
    ["{a,b}/[xy]?", "b/x1", true],
    ["{a,b}/[xy]?", "c/x1", false],
    ["proxy/", "proxy/", true],
    ["proxy/", "proxy", false],
  ] as const) {
    assert.equal(compileModelPattern(glob, "models[0].match").match(id), expected, `${glob}: ${id}`);
  }
  assert.throws(() => compileModelPattern("", "metadata.models[0].match"), (error: unknown) => {
    assert.ok(error instanceof MetadataConfigError);
    assert.equal(error.path, "metadata.models[0].match");
    assert.match(error.message, /invalid glob/);
    return true;
  });
  assert.throws(() => compileModelPattern("a".repeat(65537), "models[0].match"), /pattern is too long/);
  const config = parseMetadataConfigValue({
    models: [{ match: "proxy/**", chain: ["@self"] }],
    include_models: ["**", "!proxy/**", "proxy/keep"],
  });
  assert.deepEqual(selectModels(config, ["m", "proxy/hide", "proxy/keep"]), {
    kept: ["m", "proxy/keep"],
    hidden: [{ id: "proxy/hide", ruleIndex: 1, pattern: "!proxy/**" }],
  });
});
