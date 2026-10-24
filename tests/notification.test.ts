import assert from "node:assert/strict";
import { test } from "node:test";
import { formatPluginOutput, notifyPlugin, OUTPUT_PREFIX } from "../notification.ts";

test("plugin prefix is exact, idempotent and only on the first line", () => {
  const text = formatPluginOutput("first\nsecond");
  assert.equal(text, `${OUTPUT_PREFIX} first\nsecond`);
  assert.equal(formatPluginOutput(text), text);
  assert.equal(formatPluginOutput(`${OUTPUT_PREFIX} ${text}`), text);
  assert.equal(formatPluginOutput("modelparams.dev/@creator/api_key: provider unresolved"),
    `${OUTPUT_PREFIX} modelparams.dev/@creator/api_key: provider unresolved`);
});

test("notification text redacts known secrets, credentials and terminal control characters", () => {
  const text = formatPluginOutput(
    'key-is-secret Authorization: Bearer abc.def\n_authToken=npm-private https://user:password@registry.invalid/\x1b[31m\x07',
    ["key-is-secret"],
  );
  for (const secret of ["key-is-secret", "abc.def", "npm-private", "user:password", "\x1b", "\x07"]) {
    assert.equal(text.includes(secret), false, secret);
  }
  assert.match(text, /\[REDACTED\]/);
  assert.match(text, /\\x1b/);
});

test("npm scoped tokens and basic auth are redacted in UI and stderr without damaging source chains", () => {
  const notices: string[] = [];
  const stderr: string[] = [];
  const original = console.error;
  console.error = (message) => { stderr.push(String(message)); };
  try {
    for (const input of [
      "npm ERR //registry.example/:_authToken=npm-FAKE-REVIEW-TOKEN",
      "npm ERR //registry.example/private/:_authToken='npm-PRIVATE-TOKEN'",
      "npm ERR _auth=BASE64-FAKE-REVIEW",
      'npm ERR "_password":"BASE64-PASSWORD"',
    ]) {
      notifyPlugin({ ui: { notify: (text) => { notices.push(text); } } }, input);
      notifyPlugin(undefined, input);
    }
    for (const message of [...notices, ...stderr]) {
      assert.match(message, /\[REDACTED\]/);
      assert.doesNotMatch(message, /npm-FAKE|npm-PRIVATE|BASE64-/);
    }
    assert.equal(formatPluginOutput("modelparams.dev/@creator/api_key: provider unresolved"),
      `${OUTPUT_PREFIX} modelparams.dev/@creator/api_key: provider unresolved`);
  } finally { console.error = original; }
});

test("notifications preserve severity and fall back to prefixed stderr without stdout", () => {
  const notices: unknown[] = [];
  const stderr: string[] = [];
  const original = console.error;
  console.error = (text) => { stderr.push(String(text)); };
  try {
    notifyPlugin({ hasUI: true, ui: { notify: (...args) => { notices.push(args); } } }, "hello", "warning");
    assert.deepEqual(notices, [[`${OUTPUT_PREFIX} hello`, "warning"]]);
    notifyPlugin({ hasUI: true, ui: { notify: () => { throw new Error("UI failed"); } } }, formatPluginOutput("failed"), "error");
    notifyPlugin({ hasUI: false, ui: { notify: () => assert.fail("non-UI notify") } }, "cli");
    notifyPlugin(undefined, "no context");
    assert.deepEqual(stderr, [`${OUTPUT_PREFIX} failed`, `${OUTPUT_PREFIX} cli`, `${OUTPUT_PREFIX} no context`]);
  } finally {
    console.error = original;
  }
});
