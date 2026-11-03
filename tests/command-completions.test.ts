import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../index.ts";

test("/provider-metadata completes package actions without running them", async () => {
  type Command = Parameters<ExtensionAPI["registerCommand"]>[1];
  const commands = new Map<string, Command>();
  await extension({
    on: () => {},
    registerCommand: (name: string, command: Command) => commands.set(name, command),
    registerProvider: () => {},
  } as unknown as ExtensionAPI, {
    metadataCommands: { getDeps: () => assert.fail("completion must not access package operations") },
  });
  const complete = commands.get("provider-metadata")?.getArgumentCompletions;
  assert.ok(complete, "the registered command provides argument completion");
  for (const [prefix, expected] of [
    ["", ["check", "update"]],
    ["u", ["update"]],
    ["upd", ["update"]],
    ["c", ["check"]],
    ["  up", ["update"]],
    ["\t", ["check", "update"]],
  ] as const) {
    assert.deepEqual((await complete(prefix))?.map((item) => item.value), expected);
  }
  for (const prefix of ["unknown", "update ", "check update", "update\tmore"]) {
    assert.equal(await complete(prefix), null);
  }
});
