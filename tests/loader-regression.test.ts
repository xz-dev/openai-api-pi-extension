import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extensionPath = join(projectRoot, "index.ts");
const tempDirs: string[] = [];
const servers: Server[] = [];
const ENV_KEYS = ["OPENAI_API_EXTENSION_BASE_URL", "OPENAI_API_EXTENSION_API_KEY", "PI_OFFLINE"] as const;
let savedEnv: Record<string, string | undefined>;

afterEach(async () => {
  for (const key of ENV_KEYS) {
    const value = savedEnv?.[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

test("real Pi loader queues exactly one complete native provider", async () => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  delete process.env.OPENAI_API_EXTENSION_BASE_URL;
  delete process.env.OPENAI_API_EXTENSION_API_KEY;
  process.env.PI_OFFLINE = "1";
  const agentDir = await mkdtemp(join(tmpdir(), "openai-api-extension-loader-"));
  tempDirs.push(agentDir);
  const result = await discoverAndLoadExtensions([extensionPath], projectRoot, agentDir);
  assert.equal(result.errors.length, 0, JSON.stringify(result.errors));
  const registrations = result.runtime.pendingNativeProviderRegistrations.filter(
    ({ provider }) => provider.id === "openai-api-extension",
  );
  assert.equal(registrations.length, 1);
  const provider = registrations[0]?.provider;
  assert.equal(provider?.auth.oauth, undefined);
  assert.equal(provider?.auth.apiKey?.name, "OpenAI API Extension connection");
  assert.equal(typeof provider?.refreshModels, "function");
  assert.equal(typeof provider?.stream, "function");
  assert.equal(typeof provider?.streamSimple, "function");
});

test("async factory publishes environment catalog before startup", async () => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  delete process.env.PI_OFFLINE;
  const server = createServer((request, response) => {
    assert.equal(request.url, "/v1/models");
    assert.equal(request.headers.authorization, "Bearer loader-key");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: [{ id: "loader-model" }] }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  process.env.OPENAI_API_EXTENSION_BASE_URL = `http://127.0.0.1:${address.port}/v1`;
  process.env.OPENAI_API_EXTENSION_API_KEY = "loader-key";

  const agentDir = await mkdtemp(join(tmpdir(), "openai-api-extension-loader-"));
  tempDirs.push(agentDir);
  const result = await discoverAndLoadExtensions([extensionPath], projectRoot, agentDir);
  assert.equal(result.errors.length, 0, JSON.stringify(result.errors));
  const provider = result.runtime.pendingNativeProviderRegistrations.find(
    ({ provider }) => provider.id === "openai-api-extension",
  )?.provider;
  assert.equal(provider?.getModels()[0]?.id, "loader-model");
});

test("async factory bounds discovery and degrades on failure", async () => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  delete process.env.PI_OFFLINE;
  process.env.OPENAI_API_EXTENSION_BASE_URL = "https://gateway.example/private/v1";
  process.env.OPENAI_API_EXTENSION_API_KEY = "loader-key";
  const originalFetch = globalThis.fetch;
  const originalTimeout = AbortSignal.timeout;
  const originalWarn = console.warn;
  let timeoutMs: number | undefined;
  const signal = new AbortController().signal;
  globalThis.fetch = async () => { throw new Error("simulated outage"); };
  Object.defineProperty(AbortSignal, "timeout", {
    configurable: true,
    value: (ms: number) => {
      timeoutMs = ms;
      return signal;
    },
  });
  console.warn = () => {};
  try {
    const agentDir = await mkdtemp(join(tmpdir(), "openai-api-extension-loader-"));
    tempDirs.push(agentDir);
    const result = await discoverAndLoadExtensions([extensionPath], projectRoot, agentDir);
    assert.equal(result.errors.length, 0, JSON.stringify(result.errors));
    const provider = result.runtime.pendingNativeProviderRegistrations.find(
      ({ provider }) => provider.id === "openai-api-extension",
    )?.provider;
    assert.equal(timeoutMs, 15_000);
    assert.deepEqual(provider?.getModels(), []);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(AbortSignal, "timeout", { configurable: true, value: originalTimeout });
    console.warn = originalWarn;
  }
});

test("async factory does not fetch in offline mode", async () => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    response.writeHead(500).end();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  process.env.OPENAI_API_EXTENSION_BASE_URL = `http://127.0.0.1:${address.port}/v1`;
  process.env.OPENAI_API_EXTENSION_API_KEY = "loader-key";
  process.env.PI_OFFLINE = "1";

  const agentDir = await mkdtemp(join(tmpdir(), "openai-api-extension-loader-"));
  tempDirs.push(agentDir);
  const result = await discoverAndLoadExtensions([extensionPath], projectRoot, agentDir);
  assert.equal(result.errors.length, 0, JSON.stringify(result.errors));
  const provider = result.runtime.pendingNativeProviderRegistrations.find(
    ({ provider }) => provider.id === "openai-api-extension",
  )?.provider;
  assert.deepEqual(provider?.getModels(), []);
  assert.equal(requests, 0);
});
