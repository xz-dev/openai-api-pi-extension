import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { afterEach, test } from "node:test";

import { renderCompiledCatalog, sanitizeTerminalText } from "../metadata-view.ts";
import { writeMetadataTempFile } from "../metadata-tmpfile.ts";
import { OUTPUT_PREFIX } from "../notification.ts";

const claudeEntry = {
  entry: "models.dev/anthropic/api_key/claude-fable-5-1",
  site: "models.dev" as const,
  provider: "anthropic",
  access: "api_key" as const,
  modelId: "claude-fable-5-1",
  fields: { context_window: 1000000, max_output_tokens: 128000 },
  canonical: "anthropic/claude-fable-5-1",
  fieldSources: { context_window: "provider" as const, max_output_tokens: "canonical" as const },
};

const compiled = {
  config: {
    rootChain: ["models.dev/@creator/api_key", "@self"],
    rules: [{ match: "claude-*", overrides: { contextWindow: 200000 } }],
  },
  dataVersions: { modelsDevVersion: "0.0.113", modelsDevGeneratedAt: "2026-10-23", modelparamsVersion: "0.0.72" },
  warnings: ["ignored unsupported fields: weird_field"],
  degraded: [{ site: "modelparams.dev", reason: "package missing" }],
  models: [
    {
      publicId: "claude-fable-5-1",
      matchedRules: [1],
      plan: [
        { kind: "external" as const, entry: claudeEntry },
        { kind: "upstream" as const, modelId: "claude-fable-5-1" },
      ],
      entries: [claudeEntry],
      externalChain: true,
      unresolved: ["modelparams.dev/@creator/api_key: provider unresolved"],
      candidates: [
        {
          site: "models.dev" as const,
          provider: "anthropic",
          access: "api_key" as const,
          kind: "provider" as const,
          sourceId: "claude-fable-5-1",
          sourceKey: "claude-fable-5-1",
          level: 1 as const,
          canonical: "anthropic/claude-fable-5-1",
          selected: true,
          reason: "selected source record",
        },
        {
          site: "models.dev" as const,
          provider: "llmgateway-providers",
          access: "catalog" as const,
          kind: "provider" as const,
          sourceId: "anthropic/claude-fable-5-1",
          sourceKey: "anthropic/claude-fable-5-1",
          level: 1 as const,
          canonical: "anthropic/claude-fable-5-1",
          selected: false,
          reason: "identity evidence only",
        },
      ],
      canonical: "anthropic/claude-fable-5-1",
      skippedEntries: [{ entry: "modelparams.dev/@creator/api_key/@id", reason: "no creator record" }],
      overridePatches: [{ contextWindow: 200000 }],
    },
  ],
};

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("renderCompiledCatalog redacts credential-like override fields but keeps maxTokens", () => {
  const secret = "sk-review-only-9f8e7d";
  const custom = "custom-review-secret";
  const leaky = {
    ...compiled,
    config: {
      ...compiled.config,
      rules: [{ match: "*", overrides: { maxTokens: 2048, headers: { Authorization: `Bearer ${secret}`, "X-Custom-Auth": custom } } }],
    },
    models: [{ ...compiled.models[0], overridePatches: [{ headers: { authorization: `Bearer ${secret}` }, COOKIE: `session=${secret}` }] }],
  };
  const text = renderCompiledCatalog(leaky);
  assert.equal(text.includes(secret), false, `leaked: ${secret}`);
  assert.equal(text.includes(custom), false, `leaked: ${custom}`);
  assert.match(text, /maxTokens":2048/, "maxTokens must stay visible");
  assert.match(text, /\[REDACTED\]/);
});

test("renderCompiledCatalog shows config, versions, entries, upstream node, unresolved, overrides — never the API key", () => {
  const text = renderCompiledCatalog(compiled, {
    "claude-fable-5-1": { context_window: 500000, input_modalities: ["text"] },
  });
  assert.ok(text.startsWith(`${OUTPUT_PREFIX} `));
  assert.match(text, /== effective config ==/);
  assert.match(text, /chain: \["models\.dev\/@creator\/api_key","@self"\]/);
  assert.doesNotMatch(text, /fill_missing_only/, "old boolean mode is not shown");
  assert.match(text, /models\.dev: 0\.0\.113 \(snapshot 2026-10-23\)/);
  assert.match(text, /degraded: modelparams\.dev: package missing/);
  assert.match(text, /models\.dev\/anthropic\/api_key\/claude-fable-5-1 -> context_window, max_output_tokens\[canonical\]/);
  // The upstream node shows the concrete public id and fields it can provide
  // at its declared position — after the external entry, no @self keyword.
  assert.match(text, /upstream claude-fable-5-1 -> context_window, input_modalities/);
  const upstreamLine = text.indexOf("upstream claude-fable-5-1");
  const externalLine = text.indexOf("models.dev/anthropic/api_key/claude-fable-5-1 ->");
  assert.ok(externalLine >= 0 && upstreamLine > externalLine, "upstream node keeps its declared position");
  // Config keeps the literal tokens; the fixed plan must not echo keywords.
  const planLines = text.split("\n").filter((line) => /^    \S+ -> /.test(line));
  assert.ok(planLines.every((line) => !line.includes("@self") && !line.includes("@default")), planLines.join("\n"));
  assert.match(text, /modelparams\.dev\/@creator\/api_key: provider unresolved  \[unresolved\]/);
  assert.match(text, /canonical: anthropic\/claude-fable-5-1/);
  assert.match(text, /candidates:/);
  assert.match(text, /models\.dev\/anthropic\/api_key\/claude-fable-5-1 \[level 1\] selected canonical:anthropic\/claude-fable-5-1 \(selected source record\)/);
  assert.match(text, /models\.dev\/llmgateway-providers\/catalog\/anthropic\/claude-fable-5-1 \[level 1\] skipped.*identity evidence only/);
  assert.match(text, /skipped: modelparams\.dev\/@creator\/api_key\/@id \(no creator record\)/);
  assert.match(text, /overrides: \{"contextWindow":200000\}/);
  assert.doesNotMatch(text, /api key|api_key=|bearer|\btoken\b/i, "rendered view must not contain a credential");
});

test("writeMetadataTempFile creates a 0600 file inside a 0700 pid-prefixed dir", () => {
  const file = writeMetadataTempFile("hello");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const dir = join(file, "..");
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.match(dir, new RegExp(`openai-api-extension-metadata-${process.pid}-`));
  dirs.push(dir);
});

test("writeMetadataTempFile returns an absolute path with a relative TMPDIR", () => {
  const dir = mkdtempSync(join(tmpdir(), "metadata-relative-tmp-"));
  dirs.push(dir);
  const moduleUrl = new URL("../metadata-tmpfile.ts", import.meta.url).href;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e",
    `import { writeMetadataTempFile } from ${JSON.stringify(moduleUrl)}; console.log(writeMetadataTempFile("hello"));`], {
    cwd: dir,
    env: { ...process.env, TMPDIR: ".", TMP: ".", TEMP: "." },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const file = result.stdout.trim();
  assert.ok(isAbsolute(file), `export path must be absolute: ${file}`);
  assert.ok(existsSync(file), "reported file is readable outside the child cwd");
});

test("sanitizeTerminalText: OSC / CSI in a model id cannot reach the terminal", () => {
  const evil = "evil-\x1b]52;c;aGVsbG8=-\x1b[31m-id\x07";
  const text = renderCompiledCatalog({
    ...compiled,
    models: [{ ...compiled.models[0], publicId: evil }],
    degraded: [{ site: "models.dev", reason: "fail-\x1b]8;;http://x\x07" }],
  });
  assert.equal(text.includes("\x1b"), false, "no ESC reaches the temp file text");
  assert.equal(text.includes("\x07"), false, "no BEL reaches the temp file text");
  assert.match(text, /evil-\\x1b\]52;c;aGVsbG8=/, "control chars rendered as visible escapes");
});

test("consecutive-note dedupe suppresses only the immediately previous report", async () => {
  const { makeConsecutiveNoteDedupe } = await import("../index.ts");
  const dedupe = makeConsecutiveNoteDedupe();
  // Startup prefetch then first refresh: identical notes suppressed once.
  assert.deepEqual(dedupe(["n1", "n2"]), ["n1", "n2"]);
  assert.deepEqual(dedupe(["n1", "n2"]), [], "repeat of previous report hidden");
  // A note that drops out of a report may reappear.
  assert.deepEqual(dedupe(["n2"]), []);
  assert.deepEqual(dedupe(["n1", "n2"]), ["n1"], "n1 gone from previous report → shown again");
  // Different text is always shown.
  assert.deepEqual(dedupe(["n3"]), ["n3"]);
});

// --- /provider-metadata registered command ---------------------------------

type NotifyCall = { message: string; type: string };

async function startGateway(body: unknown): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}/v1`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function agentDir(yaml?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "oapi-cmd-"));
  dirs.push(dir);
  if (yaml !== undefined) writeFileSync(join(dir, "openai-api-extension.yaml"), yaml);
  process.env.PI_CODING_AGENT_DIR = dir;
  return dir;
}

test("/provider-metadata writes a retained temp file and notifies its prefixed path", async () => {
  const gateway = await startGateway({
    data: [{ id: "test-model", name: "test-model", type: "chat", context_window: 128000 }],
  });
  agentDir(undefined);
  try {
    const extension = (await import("../index.ts")).default;
    const calls: NotifyCall[] = [];
    let customCalls = 0;
    let clipboardCalls = 0;
    const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
    const pi = {
      on: () => {},
      registerCommand: (name: string, cmd: { handler: (args: string, ctx: unknown) => Promise<void> }) =>
        commands.set(name, cmd),
      registerProvider: () => {},
      registerEntryRenderer: () => {},
      appendEntry: () => {},
    };
    await extension(pi as never);
    const handler = commands.get("provider-metadata")?.handler;
    assert.ok(handler, "provider-metadata command registered");
    const ctx = {
      modelRegistry: {
        getProviderAuth: async () => ({ auth: { baseUrl: gateway.url, apiKey: "sk-test-secret" } }),
      },
      ui: {
        notify: (message: string, type: string) => calls.push({ message, type }),
        custom: () => customCalls++,
        copyToClipboard: () => clipboardCalls++,
      },
    };
    await handler("", ctx);
    assert.equal(customCalls, 0, "ui.custom must not be called");
    assert.equal(clipboardCalls, 0, "clipboard must not be used");
    assert.equal(calls.length, 1, "exactly one notification");
    const { message, type } = calls[0];
    assert.equal(type, "info");
    assert.ok(message.startsWith(`${OUTPUT_PREFIX} `));
    const file = message.slice(OUTPUT_PREFIX.length + 1);
    assert.match(file, /^\/.*metadata-compile\.txt$/, "prefix is not part of the absolute path");
    assert.ok(existsSync(file), "file exists after handler returns");
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(join(file, "..")).mode & 0o777, 0o700);
    const text = await readFile(file, "utf8");
    assert.ok(text.startsWith(`${OUTPUT_PREFIX} `));
    assert.match(text, /== effective config ==/);
    assert.match(text, /test-model/);
    assert.doesNotMatch(text, /sk-test-secret/, "no credential in file");
    dirs.push(join(file, ".."));
  } finally {
    await gateway.close();
  }
}, { timeout: 60_000 });

test("/provider-metadata config error still yields a diagnostics file + warning notify", async () => {
  const gateway = await startGateway({ data: [] });
  agentDir("source_priority: [\"x\"]"); // legacy field → config error
  try {
    const extension = (await import("../index.ts")).default;
    const calls: NotifyCall[] = [];
    const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
    const pi = {
      on: () => {},
      registerCommand: (name: string, cmd: { handler: (args: string, ctx: unknown) => Promise<void> }) =>
        commands.set(name, cmd),
      registerProvider: () => {},
      registerEntryRenderer: () => {},
      appendEntry: () => {},
    };
    await extension(pi as never);
    const handler = commands.get("provider-metadata")?.handler;
    assert.ok(handler);
    const ctx = {
      modelRegistry: {
        getProviderAuth: async () => ({ auth: { baseUrl: gateway.url, apiKey: "sk-test-secret" } }),
      },
      ui: {
        notify: (message: string, type: string) => calls.push({ message, type }),
        custom: () => {},
      },
    };
    await handler("", ctx);
    assert.equal(calls.length, 1);
    const { message, type } = calls[0];
    assert.equal(type, "warning");
    assert.ok(message.startsWith(`${OUTPUT_PREFIX} `));
    const file = message.slice(OUTPUT_PREFIX.length + 1);
    assert.match(file, /^\/.*metadata-compile\.txt$/);
    assert.ok(existsSync(file));
    const text = await readFile(file, "utf8");
    assert.ok(text.startsWith(`${OUTPUT_PREFIX} `));
    assert.match(text, /source_priority/);
    assert.doesNotMatch(text, /sk-test-secret/);
    dirs.push(join(file, ".."));
  } finally {
    await gateway.close();
  }
}, { timeout: 60_000 });
