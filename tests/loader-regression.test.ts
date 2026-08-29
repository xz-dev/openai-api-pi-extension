import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";
import {
  createAgentSessionServices,
  discoverAndLoadExtensions,
  ExtensionRunner,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extensionPath = join(projectRoot, "index.ts");
const tempDirs: string[] = [];
const servers: Server[] = [];
const ENV_KEYS = [
  "OPENAI_API_EXTENSION_BASE_URL",
  "OPENAI_API_EXTENSION_API_KEY",
  "PI_OFFLINE",
  "PI_CODING_AGENT_DIR",
] as const;
let savedEnv: Record<string, string | undefined>;

afterEach(async () => {
  for (const key of ENV_KEYS) {
    const value = savedEnv?.[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await Promise.all(tempDirs.splice(0).map(async (dir) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await rm(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 10 });
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOTEMPTY" || attempt === 2) throw error;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
  }));
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
  assert.equal(result.extensions[0]?.commands.has("provider-info"), true);
});

test("provider-info reports actual transport and live connection without exposing key", async () => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  delete process.env.PI_OFFLINE;
  const server = createServer((request, response) => {
    assert.equal(request.url, "/v1/models?client_version=0.84.2");
    assert.equal(request.headers.authorization, "Bearer provider-info-key");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      models: [
        { slug: "provider-info-a", context_window: 64000, max_tokens: 8192 },
        { slug: "provider-info-b", context_window: 64000, max_tokens: 8192 },
      ],
    }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  process.env.OPENAI_API_EXTENSION_BASE_URL = baseUrl;
  process.env.OPENAI_API_EXTENSION_API_KEY = "provider-info-key";

  const agentDir = await mkdtemp(join(tmpdir(), "openai-api-extension-provider-info-"));
  tempDirs.push(agentDir);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ transport: "websocket-cached" }));
  const result = await discoverAndLoadExtensions([extensionPath], projectRoot, agentDir);
  assert.equal(result.errors.length, 0, JSON.stringify(result.errors));
  const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), refreshOnCreate: false });
  const runner = new ExtensionRunner(
    result.extensions,
    result.runtime,
    projectRoot,
    SessionManager.inMemory(),
    new ModelRegistry(runtime),
  );
  runner.bindCore({
    sendMessage: () => undefined,
    sendUserMessage: () => undefined,
    appendEntry: () => undefined,
    setSessionName: () => undefined,
    getSessionName: () => undefined,
    setLabel: () => undefined,
    getActiveTools: () => [],
    getAllTools: () => [],
    setActiveTools: () => undefined,
    refreshTools: () => undefined,
    getCommands: () => [],
    setModel: async () => true,
    getThinkingLevel: () => "off",
    setThinkingLevel: () => undefined,
  }, {
    getModel: () => undefined,
    getScopedModels: () => [],
    isIdle: () => true,
    isProjectTrusted: () => true,
    getSignal: () => undefined,
    abort: () => undefined,
    hasPendingMessages: () => false,
    shutdown: () => undefined,
    getContextUsage: () => undefined,
    compact: () => undefined,
    getSystemPrompt: () => "",
  });
  const notifications: Array<{ message: string; type?: "info" | "warning" | "error" }> = [];
  runner.setUIContext({
    select: async () => undefined,
    confirm: async () => false,
    input: async () => undefined,
    notify: (message, type) => notifications.push({ message, type }),
    onTerminalInput: () => () => undefined,
    setStatus: () => undefined,
    setWorkingMessage: () => undefined,
    setWorkingVisible: () => undefined,
    setWorkingIndicator: () => undefined,
    setHiddenThinkingLabel: () => undefined,
    setWidget: () => undefined,
    setFooter: () => undefined,
    setHeader: () => undefined,
    setTitle: () => undefined,
    custom: async () => undefined as never,
    pasteToEditor: () => undefined,
    setEditorText: () => undefined,
    getEditorText: () => "",
    editor: async () => undefined,
    addAutocompleteProvider: () => undefined,
    setEditorComponent: () => undefined,
    getEditorComponent: () => undefined,
    theme: {} as never,
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({ success: false, error: "unused" }),
    getToolsExpanded: () => false,
    setToolsExpanded: () => undefined,
  }, "tui");

  await runner.getCommand("provider-info")?.handler("", runner.createCommandContext());
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0]?.type, "info");
  assert.match(notifications[0]?.message ?? "", /Transport: not connected yet/);
  assert.match(notifications[0]?.message ?? "", /Configured transport: websocket-cached/);
  assert.match(notifications[0]?.message ?? "", new RegExp(`Server: ${baseUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(notifications[0]?.message ?? "", /Connection: ✓ connected; API key valid/);
  assert.match(notifications[0]?.message ?? "", /Models: 2/);
  assert.doesNotMatch(notifications[0]?.message ?? "", /provider-info-key/);
});

test("real Pi runtime lets process environment override stored fields independently", async () => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  delete process.env.PI_OFFLINE;
  const cases = [
    { field: "base URL", envBaseUrl: true },
    { field: "API key", envBaseUrl: false },
  ] as const;

  for (const { field, envBaseUrl } of cases) {
    let expectedBaseUrl = "";
    const server = createServer((request, response) => {
      assert.equal(request.url, "/v1/models?client_version=0.84.2");
      assert.equal(request.headers.authorization, "Bearer current-key");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        models: [{ slug: `${envBaseUrl ? "base" : "key"}-override-model`, context_window: 64000, max_tokens: 8192 }],
      }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    expectedBaseUrl = `http://127.0.0.1:${address.port}/v1`;

    const agentDir = await mkdtemp(join(tmpdir(), "openai-api-extension-runtime-"));
    tempDirs.push(agentDir);
    const storedCredential = envBaseUrl
      ? { type: "api_key", key: "current-key", env: { OPENAI_API_EXTENSION_BASE_URL: "http://127.0.0.1:1/v1" } }
      : { type: "api_key", key: "stored-key", env: { OPENAI_API_EXTENSION_BASE_URL: expectedBaseUrl } };
    await writeFile(join(agentDir, "auth.json"), JSON.stringify({ "openai-api-extension": storedCredential }));
    if (envBaseUrl) {
      process.env.OPENAI_API_EXTENSION_BASE_URL = expectedBaseUrl;
      delete process.env.OPENAI_API_EXTENSION_API_KEY;
    } else {
      delete process.env.OPENAI_API_EXTENSION_BASE_URL;
      process.env.OPENAI_API_EXTENSION_API_KEY = "current-key";
    }

    const services = await createAgentSessionServices({
      cwd: projectRoot,
      agentDir,
      resourceLoaderOptions: {
        additionalExtensionPaths: [extensionPath],
        noContextFiles: true,
        noPromptTemplates: true,
        noSkills: true,
        noThemes: true,
      },
    });
    assert.deepEqual(services.diagnostics, [], field);
    await services.modelRuntime.refresh({ providers: ["openai-api-extension"] });
    const modelId = `${envBaseUrl ? "base" : "key"}-override-model`;
    assert.equal(services.modelRuntime.getModel("openai-api-extension", modelId)?.baseUrl, expectedBaseUrl, field);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    servers.splice(servers.indexOf(server), 1);
  }
});

test("async factory publishes environment catalog before startup", async () => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  delete process.env.PI_OFFLINE;
  const server = createServer((request, response) => {
    assert.equal(request.url, "/v1/models?client_version=0.84.2");
    assert.equal(request.headers.authorization, "Bearer loader-key");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ models: [{ slug: "loader-model", context_window: 64000, max_tokens: 8192 }] }));
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
