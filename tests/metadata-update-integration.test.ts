import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import extension, { type createOpenAIApiProvider } from "../index.ts";
import { MANAGED_PACKAGES, type ProcessRunner } from "../metadata-packages.ts";
import { OUTPUT_PREFIX } from "../notification.ts";

test("update command activates data then refreshes, queries and exports the same versions", { timeout: 20_000 }, async () => {
  const agent = mkdtempSync(join(tmpdir(), "oapi-update-integration-"));
  const originalAgent = process.env.PI_CODING_AGENT_DIR;
  const originalOffline = process.env.PI_OFFLINE;
  process.env.PI_CODING_AGENT_DIR = agent;
  delete process.env.PI_OFFLINE;
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(req.url ?? "");
    assert.equal(req.headers.authorization, "Bearer sk-integration-only");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "m", name: "Gateway Display", context_window: 64000 }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  const runnerCalls: string[][] = [];
  const runner: ProcessRunner = async ({ args, cwd }) => {
    runnerCalls.push(args);
    if (args[0] === "--version") return { code: 0, signal: null, stdout: "11.0.0", stderr: "" };
    if (args[0] === "view") return { code: 0, signal: null, stdout: JSON.stringify("99.0.0"), stderr: "" };
    assert.equal(args[0], "install");
    const manifest = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
    for (const name of MANAGED_PACKAGES) {
      const dir = join(cwd, "node_modules", name);
      mkdirSync(join(dir, "dist"), { recursive: true });
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version: manifest.dependencies[name], type: "module" }));
      writeFileSync(join(dir, "dist", name === MANAGED_PACKAGES[0] ? "snapshot.js" : "index.js"), name === MANAGED_PACKAGES[0]
        ? 'export const generatedAt="fixture-new-snapshot"; export const providers={demo:{models:{m:{canonical_model_id:"demo/m",limit:{context:640000,output:128000}}}}}; export const models={"demo/m":{limit:{context:640000,output:128000}}};'
        : "export const CATALOG=[];");
    }
    return { code: 0, signal: null, stdout: "installed", stderr: "" };
  };
  const commands = new Map<string, { handler: (args: string, ctx: never) => Promise<void> }>();
  const handlers = new Map<string, (event: unknown, ctx: never) => unknown>();
  let provider: ReturnType<typeof createOpenAIApiProvider> | undefined;
  const notices: { message: string; type?: string }[] = [];
  let published: readonly { id: string; name: string; contextWindow: number }[] = [];
  let appendCalls = 0;
  try {
    await extension({
      on: (name: string, handler: (event: unknown, ctx: never) => unknown) => { handlers.set(name, handler); },
      registerCommand: (name: string, command: { handler: (args: string, ctx: never) => Promise<void> }) => { commands.set(name, command); },
      registerProvider: (value: ReturnType<typeof createOpenAIApiProvider>) => { provider = value; },
      appendEntry: () => { appendCalls++; },
    } as never, { metadataCommands: {
      automaticState: { started: false },
      getDeps: () => ({ agentDir: agent, hostRuntime: { bunRuntime: false, bunBinary: false, execPath: process.execPath }, runner }),
    } });
    const ctx = {
      hasUI: true, mode: "rpc", cwd: process.cwd(), isProjectTrusted: () => false,
      sessionManager: { getSessionId: () => "metadata-update-integration" },
      ui: { notify: (message: string, type?: string) => notices.push({ message, type }) },
      modelRegistry: {
        getProviderAuth: async () => ({ auth: { baseUrl, apiKey: "sk-integration-only" } }),
        refresh: async (options: { providers: string[]; signal: AbortSignal; force: boolean; allowNetwork: boolean }) => {
          assert.deepEqual(options.providers, ["openai-api-extension"]);
          assert.equal(options.force, true);
          await provider!.refreshModels!({
            credential: { type: "api_key", key: "sk-integration-only", env: { OPENAI_API_EXTENSION_BASE_URL: baseUrl } },
            signal: options.signal, allowNetwork: true,
            publish: async (entry: { persist?: { models: typeof published }; update: () => void }) => {
              if (entry.persist) published = entry.persist.models;
              entry.update();
              return true;
            },
          } as never);
          return { aborted: false, errors: new Map() };
        },
      },
    };
    await handlers.get("session_start")?.({}, ctx as never);
    await commands.get("provider-metadata")!.handler("update", ctx as never);
    assert.match(notices.at(-1)!.message, /Data packages updated.*model catalog refreshed/);
    assert.equal(published[0]?.contextWindow, 640000);
    assert.equal(published[0]?.id, "m");
    assert.equal(published[0]?.name, "Gateway Display");
    await commands.get("provider-info")!.handler("", ctx as never);
    assert.match(notices.at(-1)!.message, /connected; API key valid/);
    await commands.get("provider-metadata")!.handler("", ctx as never);
    const pathNotice = notices.at(-1)!.message;
    const file = pathNotice.slice(OUTPUT_PREFIX.length + 1);
    const text = readFileSync(file, "utf8");
    assert.match(text, /models\.dev: 99\.0\.0 \(snapshot fixture-new-snapshot\)/);
    assert.match(text, /modelparams\.dev: 99\.0\.0/);
    assert.match(text, /models\.dev\/demo\/api_key\/m/);
    assert.ok(notices.every((n) => n.message.startsWith(`${OUTPUT_PREFIX} `)));
    assert.ok(notices.every((n) => !n.message.includes("sk-integration-only")));
    assert.equal(appendCalls, 0);
    assert.equal(runnerCalls.filter((args) => args[0] === "install").length, 1);
    assert.equal(requests.length, 3, "only gateway catalog requests, no inference or registry HTTP");
    rmSync(join(file, ".."), { recursive: true, force: true });
    await handlers.get("session_shutdown")?.({}, undefined as never);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(agent, { recursive: true, force: true });
    if (originalAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgent;
    if (originalOffline === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = originalOffline;
  }
});
