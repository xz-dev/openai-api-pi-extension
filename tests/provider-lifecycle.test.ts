import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, test } from "node:test";
import {
  createModels,
  InMemoryCredentialStore,
  InMemoryModelsStore,
  type AuthContext,
  type AuthPrompt,
} from "@earendil-works/pi-ai";
import { createOpenAIApiProvider } from "../index.ts";
import { readJsonBody } from "./fixtures/wire-decode.ts";
import { OUTPUT_PREFIX } from "../notification.ts";

const PROVIDER = "openai-api-extension";
const BASE_URL_ENV = "OPENAI_API_EXTENSION_BASE_URL";
const API_KEY_ENV = "OPENAI_API_EXTENSION_API_KEY";
const servers: Server[] = [];
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = { [BASE_URL_ENV]: process.env[BASE_URL_ENV], [API_KEY_ENV]: process.env[API_KEY_ENV] };
  delete process.env[BASE_URL_ENV];
  delete process.env[API_KEY_ENV];
});

async function gateway(modelId: string, expectedKey = "test-key", includeLimits = true) {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url} ${request.headers.authorization ?? ""}`);
    if (request.headers.authorization !== `Bearer ${expectedKey}`) {
      response.writeHead(401).end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      models: [{ slug: modelId, ...(includeLimits ? { context_window: 64000, max_tokens: 8192 } : {}) }],
    }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, requests };
}

function authContext(env: Record<string, string | undefined> = {}): AuthContext {
  return {
    env: async (name) => env[name],
    fileExists: async () => false,
  };
}

afterEach(async () => {
  for (const key of [BASE_URL_ENV, API_KEY_ENV]) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

test("complete provider exposes native auth, refresh, and Responses streams", () => {
  const provider = createOpenAIApiProvider([], undefined, undefined, undefined, undefined, currentDeps);
  assert.equal(provider.id, PROVIDER);
  assert.equal(provider.name, "OpenAI API Extension");
  assert.equal(provider.auth.oauth, undefined);
  assert.equal(provider.auth.apiKey?.name, "OpenAI API Extension connection");
  assert.equal(typeof provider.auth.apiKey?.login, "function");
  assert.equal(typeof provider.refreshModels, "function");
  assert.equal(typeof provider.stream, "function");
  assert.equal(typeof provider.streamSimple, "function");
  assert.deepEqual(provider.getModels(), []);
});

test("API-key login uses secret prompt, validates, and logout removes the whole connection", async () => {
  metadataEnv(undefined);
  const gatewayServer = await gateway("login-model");
  const credentials = new InMemoryCredentialStore();
  const modelsStore = new InMemoryModelsStore();
  const models = createModels({ credentials, modelsStore, authContext: authContext() });
  models.setProvider(createOpenAIApiProvider([], undefined, undefined, undefined, undefined, currentDeps));
  const prompts: AuthPrompt[] = [];
  const notices: string[] = [];
  const answers = [gatewayServer.baseUrl, "test-key"];

  const credential = await models.login(PROVIDER, "api_key", {
    prompt: async (prompt) => {
      prompts.push(prompt);
      return answers.shift() ?? "";
    },
    notify: (event) => { notices.push(event.message); },
  });

  assert.deepEqual(
    prompts.map((prompt) => prompt.type),
    ["text", "secret"],
  );
  assert.ok(prompts.every((prompt) => prompt.message.startsWith(`${OUTPUT_PREFIX} `)));
  assert.ok(notices.length >= 2 && notices.every((message) => message.startsWith(`${OUTPUT_PREFIX} `)));
  assert.deepEqual(credential, {
    type: "api_key",
    key: "test-key",
    env: { [BASE_URL_ENV]: gatewayServer.baseUrl },
  });
  assert.deepEqual(await credentials.read(PROVIDER), credential);
  assert.deepEqual((await models.getAuth(PROVIDER))?.auth, {
    apiKey: "test-key",
    baseUrl: gatewayServer.baseUrl,
  });

  const synchronized = await models.refresh({ allowNetwork: false, providers: [PROVIDER] });
  assert.equal(synchronized.errors.size, 0);
  assert.equal(models.getModel(PROVIDER, "login-model")?.baseUrl, gatewayServer.baseUrl);
  assert.equal((await modelsStore.read(PROVIDER))?.models[0]?.id, "login-model");
  assert.equal(gatewayServer.requests.length, 1, "validated login must not refetch during credential synchronization");

  await models.logout(PROVIDER);
  assert.equal(await credentials.read(PROVIDER), undefined);
  assert.equal(await models.getAuth(PROVIDER), undefined);
});

test("host convergence persists initial provider models without another network request", async () => {
  const modelsStore = new InMemoryModelsStore();
  const prefetched = {
    id: "prefetched-model",
    name: "prefetched-model",
    provider: PROVIDER,
    api: "openai-responses" as const,
    baseUrl: "https://gateway.example/v1",
    reasoning: true,
    input: ["text"] as Array<"text" | "image">,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 64000,
    maxTokens: 8192,
  };
  const models = createModels({ modelsStore, authContext: authContext() });
  models.setProvider(createOpenAIApiProvider([prefetched], undefined, undefined, undefined, undefined, currentDeps));

  const result = await models.refresh({ allowNetwork: false });
  assert.equal(result.errors.size, 0);
  assert.deepEqual((await modelsStore.read(PROVIDER))?.models, [prefetched]);
});

test("Pi persists dynamic models and restores them offline without network", async () => {
  metadataEnv(undefined);
  const gatewayServer = await gateway("stored-model");
  const credentials = new InMemoryCredentialStore();
  const modelsStore = new InMemoryModelsStore();
  await credentials.modify(PROVIDER, async () => ({
    type: "api_key",
    key: "test-key",
    env: { [BASE_URL_ENV]: gatewayServer.baseUrl },
  }));

  const online = createModels({ credentials, modelsStore, authContext: authContext() });
  online.setProvider(createOpenAIApiProvider([], undefined, undefined, undefined, undefined, currentDeps));
  const result = await online.refresh();
  assert.equal(result.errors.size, 0);
  assert.equal(online.getModel(PROVIDER, "stored-model")?.baseUrl, gatewayServer.baseUrl);
  assert.equal(gatewayServer.requests.length, 1);

  const offline = createModels({ credentials, modelsStore, authContext: authContext() });
  offline.setProvider(createOpenAIApiProvider([], undefined, undefined, undefined, undefined, currentDeps));
  const restored = await offline.refresh({ allowNetwork: false });
  assert.equal(restored.errors.size, 0);
  assert.equal(offline.getModel(PROVIDER, "stored-model")?.baseUrl, gatewayServer.baseUrl);
  assert.equal(gatewayServer.requests.length, 1, "offline restore must not fetch");
});

test("environment fields override stored connection during refresh and request auth", async () => {
  metadataEnv(undefined);
  const oldGateway = await gateway("old-model", "old-key");
  const currentGateway = await gateway("current-model", "env-key");
  const credentials = new InMemoryCredentialStore();
  const modelsStore = new InMemoryModelsStore();
  await credentials.modify(PROVIDER, async () => ({
    type: "api_key",
    key: "old-key",
    env: { [BASE_URL_ENV]: oldGateway.baseUrl },
  }));
  await modelsStore.write(PROVIDER, {
    models: [
      {
        id: "old-model",
        name: "old-model",
        provider: PROVIDER,
        api: "openai-responses",
        baseUrl: oldGateway.baseUrl,
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 64000,
        maxTokens: 8192,
      },
    ],
  });
  const models = createModels({
    credentials,
    modelsStore,
    authContext: authContext({ [BASE_URL_ENV]: currentGateway.baseUrl, [API_KEY_ENV]: "env-key" }),
  });
  models.setProvider(createOpenAIApiProvider([], undefined, undefined, undefined, undefined, currentDeps));

  const result = await models.refresh();
  assert.equal(result.errors.size, 0);
  assert.equal(models.getModel(PROVIDER, "old-model"), undefined);
  assert.equal(models.getModel(PROVIDER, "current-model")?.baseUrl, currentGateway.baseUrl);
  assert.equal(oldGateway.requests.length, 0);
  assert.equal(currentGateway.requests.length, 1);
  assert.deepEqual((await models.getAuth(PROVIDER))?.auth, {
    apiKey: "env-key",
    baseUrl: currentGateway.baseUrl,
  });
});

test("auth context fields override stored connection independently", async () => {
  const apiKeyAuth = createOpenAIApiProvider([], undefined, undefined, undefined, undefined, currentDeps).auth.apiKey;
  assert.ok(apiKeyAuth);
  const credential = {
    type: "api_key" as const,
    key: "old-key",
    env: { [BASE_URL_ENV]: "https://stored.example/v1" },
  };
  const signal = new AbortController().signal;

  const overriddenBaseUrl = await apiKeyAuth.resolve({
    ctx: authContext({ [BASE_URL_ENV]: "https://environment.example/v1" }),
    credential,
    signal,
  });
  assert.deepEqual(overriddenBaseUrl?.auth, {
    apiKey: "old-key",
    baseUrl: "https://environment.example/v1",
  });

  const overriddenApiKey = await apiKeyAuth.resolve({
    ctx: authContext({ [API_KEY_ENV]: "env-key" }),
    credential,
    signal,
  });
  assert.deepEqual(overriddenApiKey?.auth, {
    apiKey: "env-key",
    baseUrl: "https://stored.example/v1",
  });
});

test("invalid environment connection fails closed without mixing stored fields", async () => {
  const storedGateway = await gateway("stored-model", "stored-key");
  const credentials = new InMemoryCredentialStore();
  await credentials.modify(PROVIDER, async () => ({
    type: "api_key",
    key: "stored-key",
    env: { [BASE_URL_ENV]: storedGateway.baseUrl },
  }));
  const models = createModels({
    credentials,
    authContext: authContext({ [BASE_URL_ENV]: "not-a-valid-url", [API_KEY_ENV]: "new-env-key" }),
  });
  models.setProvider(createOpenAIApiProvider([], undefined, undefined, undefined, undefined, currentDeps));

  const result = await models.refresh();
  assert.equal(result.errors.size, 0);
  assert.equal(storedGateway.requests.length, 0);
  assert.equal(await models.getAuth(PROVIDER), undefined);
});

test("login saves the API key; catalog without limits maps via defaults and refresh succeeds", async () => {
  metadataEnv(undefined);
  const gatewayServer = await gateway("axis/codex-auto-review", "test-key", false);
  const credentials = new InMemoryCredentialStore();
  const modelsStore = new InMemoryModelsStore();
  const models = createModels({ credentials, modelsStore, authContext: authContext() });
  models.setProvider(createOpenAIApiProvider([], undefined, undefined, undefined, undefined, currentDeps));
  const notifications: string[] = [];
  let promptCount = 0;

  const credential = await models.login(PROVIDER, "api_key", {
    prompt: async () => (promptCount++ === 0 ? gatewayServer.baseUrl : "test-key"),
    notify: (event) => {
      if (event.type === "info") notifications.push(event.message);
    },
  });

  assert.equal(credential.key, "test-key");
  assert.deepEqual(await credentials.read(PROVIDER), credential);
  assert.equal(
    notifications.find((message) => /Found \d+ models/.test(message)) !== undefined,
    true,
    "missing limits must map via defaults, not make the catalog unusable",
  );

  const result = await models.refresh();
  assert.equal(result.errors.size, 0);
  assert.equal(models.getModels(PROVIDER).length, 1);
  assert.equal(models.getModel(PROVIDER, "axis/codex-auto-review")?.contextWindow, 128_000);
});

test("entries without limits use defaults and publish alongside verified models", async () => {
  metadataEnv(undefined);
  const gatewayServer = await gateway("untrusted-model", "test-key", false);
  const credentials = new InMemoryCredentialStore();
  const modelsStore = new InMemoryModelsStore();
  await credentials.modify(PROVIDER, async () => ({
    type: "api_key",
    key: "test-key",
    env: { [BASE_URL_ENV]: gatewayServer.baseUrl },
  }));
  await modelsStore.write(PROVIDER, {
    models: [{
      id: "verified-model",
      name: "verified-model",
      provider: PROVIDER,
      api: "openai-responses",
      baseUrl: gatewayServer.baseUrl,
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 64000,
      maxTokens: 8192,
    }],
  });
  const models = createModels({ credentials, modelsStore, authContext: authContext() });
  models.setProvider(createOpenAIApiProvider([], undefined, undefined, undefined, undefined, currentDeps));

  const result = await models.refresh();
  assert.equal(result.errors.size, 0, "missing limits must not fail refresh");
  assert.equal(models.getModel(PROVIDER, "untrusted-model")?.contextWindow, 128_000);
});

test("refresh without catalog errors reports nothing and publishes models", async () => {
  metadataEnv(undefined);
  const gatewayServer = await gateway("untrusted-model", "test-key", false);
  const credentials = new InMemoryCredentialStore();
  const modelsStore = new InMemoryModelsStore();
  await credentials.modify(PROVIDER, async () => ({
    type: "api_key",
    key: "test-key",
    env: { [BASE_URL_ENV]: gatewayServer.baseUrl },
  }));
  await modelsStore.write(PROVIDER, {
    models: [{
      id: "verified-model",
      name: "verified-model",
      provider: PROVIDER,
      api: "openai-responses",
      baseUrl: gatewayServer.baseUrl,
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 64000,
      maxTokens: 8192,
    }],
  });
  const reported: string[] = [];
  const models = createModels({ credentials, modelsStore, authContext: authContext() });
  models.setProvider(createOpenAIApiProvider([], (message) => {
    reported.push(message);
  }, undefined, undefined, undefined, currentDeps));

  const result = await models.refresh();
  assert.equal(result.errors.size, 0);
  assert.deepEqual(reported, []);
  assert.equal(models.getModel(PROVIDER, "untrusted-model")?.contextWindow, 128_000);
});

test("refresh abort reaches the catalog request without publishing partial state", async () => {
  const server = createServer(() => undefined);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  const credentials = new InMemoryCredentialStore();
  await credentials.modify(PROVIDER, async () => ({
    type: "api_key",
    key: "test-key",
    env: { [BASE_URL_ENV]: baseUrl },
  }));
  const models = createModels({ credentials, authContext: authContext() });
  models.setProvider(createOpenAIApiProvider([], undefined, undefined, undefined, undefined, currentDeps));
  const controller = new AbortController();
  const refresh = models.refresh({ signal: controller.signal });
  controller.abort();

  const result = await refresh;
  assert.equal(result.aborted, true);
  assert.equal(models.getModels(PROVIDER).length, 0);
});

// --- Metadata fallback chain lifecycle (tasks 4.1-4.4) ----------------------
// Loopback/fake-fetch fixtures only. The config file is pointed at a temp dir
// via PI_CODING_AGENT_DIR; source endpoints are intercepted at globalThis.fetch
// by URL so production source endpoints and config path are exercised.

import { mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SourceTables } from "../model-metadata.ts";
import type { CompileDeps } from "../metadata-compile.ts";

const metadataDirs: string[] = [];
const realFetch = globalThis.fetch;
const METADATA_HOSTS = /models\.dev|modelparams\.dev/;

/** Loopback SourceTables: one models.dev provider `openai` with `gpt-meta`. */
const FIXTURE_TABLES: SourceTables = {
  modelsDev: {
    providers: {
      openai: {
        models: {
          "gpt-meta": {
            name: "GPT Meta",
            canonical_model_id: "openai/gpt-meta",
            limit: { context: 200000, output: 32768 },
            modalities: { input: ["text"], output: ["text"] },
          },
        },
      },
    },
  },
  modelparams: { catalog: [] },
  degraded: [],
};

/**
 * Sets PI_CODING_AGENT_DIR to a temp config dir, injects fixture tables
 * through setMetadataTablesLoader (no real packages touched), and watches
 * fetch for any models.dev / modelparams.dev request (there must be none).
 * Pass `null` tables to use the real Worker + packages.
 */
/** Latest deps injected through createOpenAIApiProvider's 6th param. */
let currentDeps: CompileDeps | undefined;

function metadataEnv(yaml: string | undefined, tables: SourceTables | null = FIXTURE_TABLES) {
  const dir = mkdtempSync(join(tmpdir(), "openai-api-metadata-"));
  metadataDirs.push(dir);
  if (yaml !== undefined) writeFileSync(join(dir, "openai-api-extension.yaml"), yaml);
  process.env.PI_CODING_AGENT_DIR = dir;
  currentDeps = tables === null ? undefined : { loadTables: async () => tables };
  const hits: Record<string, number> = {};
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (METADATA_HOSTS.test(url)) {
      hits[url] = (hits[url] ?? 0) + 1;
      throw new Error("metadata must never hit the network");
    }
    return realFetch(input, init);
  };
  return { hits };
}

afterEach(async () => {
  globalThis.fetch = realFetch;
  delete process.env.PI_CODING_AGENT_DIR;
  currentDeps = undefined;
  await Promise.all(metadataDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

test("refresh enriches models through the shared metadata path", async () => {
  const { hits } = metadataEnv(undefined);
  const gatewayServer = await gateway("gpt-meta", "test-key", false);
  const credentials = new InMemoryCredentialStore();
  await credentials.modify(PROVIDER, async () => ({
    type: "api_key", key: "test-key", env: { [BASE_URL_ENV]: gatewayServer.baseUrl },
  }));
  const models = createModels({ credentials, authContext: authContext() });
  models.setProvider(createOpenAIApiProvider([], undefined, undefined, undefined, undefined, currentDeps));

  const result = await models.refresh();
  assert.equal(result.errors.size, 0);
  const model = models.getModel(PROVIDER, "gpt-meta");
  assert.equal(model?.contextWindow, 200_000, "metadata chain overwrites upstream default");
  assert.equal(model?.maxTokens, 32_768);
  assert.deepEqual(hits, {}, "enrichment must not hit any metadata endpoint");
});

test("offline restore reads no config and hits no metadata source", async () => {
  const { hits } = metadataEnv("chain: [\"models.dev/@creator/api_key\"]");
  const credentials = new InMemoryCredentialStore();
  const modelsStore = new InMemoryModelsStore();
  await credentials.modify(PROVIDER, async () => ({
    type: "api_key", key: "test-key", env: { [BASE_URL_ENV]: "http://127.0.0.1:1/v1" },
  }));
  await modelsStore.write(PROVIDER, { models: [{
    id: "stored-model", name: "stored-model", provider: PROVIDER, api: "openai-responses",
    baseUrl: "http://127.0.0.1:1/v1", reasoning: false, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 64000, maxTokens: 8192,
  }] });
  const models = createModels({ credentials, modelsStore, authContext: authContext() });
  models.setProvider(createOpenAIApiProvider([], undefined, undefined, undefined, undefined, currentDeps));

  const result = await models.refresh({ allowNetwork: false });
  assert.equal(result.errors.size, 0);
  assert.equal(models.getModel(PROVIDER, "stored-model")?.contextWindow, 64000);
  assert.deepEqual(hits, {}, "offline must not fetch metadata");
});

test("invalid metadata config blocks the new catalog, keeps the old one, and is not an auth error", async () => {
  const gatewayServer = await gateway("fresh-model", "test-key");
  const { hits } = metadataEnv("fill_missing_only: maybe");
  const credentials = new InMemoryCredentialStore();
  const modelsStore = new InMemoryModelsStore();
  await credentials.modify(PROVIDER, async () => ({
    type: "api_key", key: "test-key", env: { [BASE_URL_ENV]: gatewayServer.baseUrl },
  }));
  await modelsStore.write(PROVIDER, { models: [{
    id: "old-model", name: "old-model", provider: PROVIDER, api: "openai-responses",
    baseUrl: gatewayServer.baseUrl, reasoning: false, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 64000, maxTokens: 8192,
  }] });
  const reported: string[] = [];
  const models = createModels({ credentials, modelsStore, authContext: authContext() });
  models.setProvider(createOpenAIApiProvider([], (message) => reported.push(message), undefined, undefined, undefined, currentDeps));

  const result = await models.refresh();
  assert.equal(result.errors.size, 1);
  assert.match(result.errors.get(PROVIDER)?.message ?? "", /fill_missing_only/);
  assert.equal(models.getModel(PROVIDER, "old-model")?.contextWindow, 64000, "old catalog kept");
  assert.equal(models.getModel(PROVIDER, "fresh-model"), undefined, "new catalog blocked");
  assert.deepEqual((await modelsStore.read(PROVIDER))?.models.map((model) => model.id), ["old-model"]);
  assert.equal(hits.modelsDevApi ?? 0, 0, "invalid config never reaches the sources");
  const report = reported.find((message) => /fill_missing_only/.test(message));
  assert.ok(report, "config error must be reported");
  assert.doesNotMatch(report ?? "", /api key|unauthorized|401/i, "config error must not read as an auth failure");
});

test("failing metadata sources degrade to upstream-mapped models with a report", async () => {
  const gatewayServer = await gateway("degraded-model", "test-key", false);
  metadataEnv(undefined, {
    modelsDev: undefined,
    modelparams: undefined,
    degraded: [
      { site: "models.dev", reason: "snapshot missing" },
      { site: "modelparams.dev", reason: "CATALOG missing" },
    ],
  });
  const credentials = new InMemoryCredentialStore();
  await credentials.modify(PROVIDER, async () => ({
    type: "api_key", key: "test-key", env: { [BASE_URL_ENV]: gatewayServer.baseUrl },
  }));
  const reported: string[] = [];
  const models = createModels({ credentials, authContext: authContext() });
  models.setProvider(createOpenAIApiProvider([], undefined, undefined, undefined, (ns) => reported.push(...ns), currentDeps));

  const result = await models.refresh();
  assert.equal(result.errors.size, 0, "degraded enrichment is not a refresh error");
  assert.equal(models.getModel(PROVIDER, "degraded-model")?.contextWindow, 128_000, "upstream defaults apply");
  assert.ok(reported.some((message) => /metadata source .* unavailable/i.test(message)));
});

test("degraded sites report through the note callback, not the error callback", async () => {
  const gatewayServer = await gateway("note-model", "test-key", false);
  metadataEnv(undefined, {
    modelsDev: undefined,
    modelparams: { catalog: [] },
    degraded: [{ site: "models.dev", reason: "down" }],
  });
  const credentials = new InMemoryCredentialStore();
  await credentials.modify(PROVIDER, async () => ({
    type: "api_key", key: "test-key", env: { [BASE_URL_ENV]: gatewayServer.baseUrl },
  }));
  const errors: string[] = [];
  const notes: string[] = [];
  const models = createModels({ credentials, authContext: authContext() });
  models.setProvider(createOpenAIApiProvider([], (m) => errors.push(m), undefined, undefined, (ns) => notes.push(...ns), currentDeps));
  const result = await models.refresh();
  assert.equal(result.errors.size, 0);
  assert.ok(notes.some((m) => /models\.dev/.test(m)), "note callback receives the degradation");
  assert.ok(!errors.some((m) => /models\.dev.*unavailable/i.test(m)), "error callback stays error-only");
});

test("login saves the validated key and reports a metadata config error, not an auth failure", async () => {
  const gatewayServer = await gateway("login-meta-model", "test-key");
  metadataEnv("chain: not-a-list");
  const credentials = new InMemoryCredentialStore();
  const models = createModels({ credentials, authContext: authContext() });
  models.setProvider(createOpenAIApiProvider([], undefined, undefined, undefined, undefined, currentDeps));
  const notifications: string[] = [];
  let promptCount = 0;

  const credential = await models.login(PROVIDER, "api_key", {
    prompt: async () => (promptCount++ === 0 ? gatewayServer.baseUrl : "test-key"),
    notify: (event) => {
      if (event.type === "info") notifications.push(event.message);
    },
  });

  assert.equal(credential.key, "test-key", "validated credential still saved");
  assert.deepEqual(await credentials.read(PROVIDER), credential);
  const note = notifications.find((message) => /metadata config/i.test(message));
  assert.ok(note, "config error must surface as metadata config, not catalog unusable");
  assert.doesNotMatch(note, /not usable|invalid api key/i);
});

test("cancelled login during enrichment never publishes or persists its catalog", async () => {
  // P1-1: caller abort inside the metadata source fetch must abort the whole
  // login; a later refresh keeps the previously stored catalog.
  const gatewayServer = await gateway("cancelled-model", "test-key");
  const credentials = new InMemoryCredentialStore();
  const modelsStore = new InMemoryModelsStore();
  await credentials.modify(PROVIDER, async () => ({
    type: "api_key",
    key: "test-key",
    env: { [BASE_URL_ENV]: gatewayServer.baseUrl },
  }));
  await modelsStore.write(PROVIDER, { models: [{
    id: "old-model", name: "old-model", provider: PROVIDER, api: "openai-responses",
    baseUrl: gatewayServer.baseUrl, reasoning: false, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 64000, maxTokens: 8192,
  }] });

  // The compile worker is aborted by the caller signal — a hanging loader
  // makes the abort deterministic instead of racing the real package load.
  metadataEnv(undefined, null);
  const hang: CompileDeps = {
    loadTables: (_sites, signal) => new Promise<SourceTables>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
  };
  currentDeps = hang;

  const models = createModels({ credentials, modelsStore, authContext: authContext() });
  models.setProvider(createOpenAIApiProvider([], undefined, undefined, undefined, undefined, currentDeps));

  // Prime the restored catalog so a later offline refresh publishes "old-model".
  await models.refresh({ allowNetwork: false });
  assert.deepEqual(models.getModels(PROVIDER).map((model) => model.id), ["old-model"]);

  const controller = new AbortController();
  let prompts = 0;
  const login = models
    .login(PROVIDER, "api_key", {
      signal: controller.signal,
      prompt: async () => (prompts++ === 0 ? gatewayServer.baseUrl : "test-key"),
      notify: () => undefined,
    })
    .then(
      () => "resolved",
      (error: unknown) => (error instanceof Error ? error.name : "unknown"),
    );
  // Wait until the gateway catalog was read and enrichment is waiting on the
  // hanging source endpoints, then cancel.
  await new Promise((resolve) => setTimeout(resolve, 200));
  controller.abort();
  assert.equal(await login, "AbortError");

  await new Promise((resolve) => setTimeout(resolve, 30));
  const result = await models.refresh({ allowNetwork: false });
  assert.equal(result.errors.size, 0);
  assert.deepEqual(
    models.getModels(PROVIDER).map((model) => model.id),
    ["old-model"],
    "cancelled login's catalog must not be published",
  );
  assert.deepEqual(
    (await modelsStore.read(PROVIDER))?.models.map((model) => model.id),
    ["old-model"],
    "cancelled login's catalog must not persist",
  );
});

test("chain: [\"@self\"] opts out of all external metadata reads", async () => {
  const gatewayServer = await gateway("optout-model", "test-key", false);
  const { hits } = metadataEnv("chain: [\"@self\"]");
  const credentials = new InMemoryCredentialStore();
  await credentials.modify(PROVIDER, async () => ({
    type: "api_key", key: "test-key", env: { [BASE_URL_ENV]: gatewayServer.baseUrl },
  }));
  const models = createModels({ credentials, authContext: authContext() });
  models.setProvider(createOpenAIApiProvider([], undefined, undefined, undefined, undefined, currentDeps));

  const result = await models.refresh();
  assert.equal(result.errors.size, 0);
  assert.equal(models.getModel(PROVIDER, "optout-model")?.contextWindow, 128_000);
  assert.deepEqual(hits, {}, "upstream-only chain must not fetch external data");
});

test("explicit empty chain is a config error, not an opt-out", async () => {
  const gatewayServer = await gateway("empty-chain-model", "test-key", false);
  const { hits } = metadataEnv("chain: []");
  const credentials = new InMemoryCredentialStore();
  await credentials.modify(PROVIDER, async () => ({
    type: "api_key", key: "test-key", env: { [BASE_URL_ENV]: gatewayServer.baseUrl },
  }));
  const reported: string[] = [];
  const models = createModels({ credentials, authContext: authContext() });
  models.setProvider(createOpenAIApiProvider([], (m) => reported.push(m), undefined, undefined, undefined, currentDeps));

  const result = await models.refresh();
  assert.equal(result.errors.size, 1);
  const message = result.errors.get(PROVIDER)?.message ?? "";
  assert.match(message, /chain/);
  assert.match(message, /@self/, "error must suggest the upstream-only chain");
  assert.equal(models.getModel(PROVIDER, "empty-chain-model"), undefined, "invalid config publishes nothing");
  assert.deepEqual(hits, {}, "config error must not reach the sources");
});

test("legacy config fields are config errors with a migration hint", async () => {
  const gatewayServer = await gateway("legacy-model", "test-key", false);
  metadataEnv("source_priority: [\"*/api_key\"]");
  const credentials = new InMemoryCredentialStore();
  await credentials.modify(PROVIDER, async () => ({
    type: "api_key", key: "test-key", env: { [BASE_URL_ENV]: gatewayServer.baseUrl },
  }));
  const reported: string[] = [];
  const models = createModels({ credentials, authContext: authContext() });
  models.setProvider(createOpenAIApiProvider([], (m) => reported.push(m), undefined, undefined, undefined, currentDeps));
  const result = await models.refresh();
  assert.equal(result.errors.size, 1);
  const message = result.errors.get(PROVIDER)?.message ?? "";
  assert.match(message, /source_priority/);
  assert.match(message, /chain/);
});

test("unknown config fields warn once and the rest of the config still applies", async () => {
  const gatewayServer = await gateway("warn-model", "test-key", false);
  metadataEnv("unsupported_gateway_field: true\nmodels:\n  - match: 'warn-model'\n    bogus_rule_field: 1\n");
  const credentials = new InMemoryCredentialStore();
  await credentials.modify(PROVIDER, async () => ({
    type: "api_key", key: "test-key", env: { [BASE_URL_ENV]: gatewayServer.baseUrl },
  }));
  const reported: string[] = [];
  const models = createModels({ credentials, authContext: authContext() });
  models.setProvider(createOpenAIApiProvider([], undefined, undefined, undefined, (ns) => reported.push(...ns), currentDeps));

  const result = await models.refresh();
  assert.equal(result.errors.size, 0);
  assert.ok(models.getModel(PROVIDER, "warn-model"));
  const warnings = reported.filter((message) => /ignored unsupported fields/.test(message));
  assert.equal(warnings.length, 1, "one aggregated note line per refresh");
  assert.match(warnings[0] ?? "", /unsupported_gateway_field/);
  assert.match(warnings[0] ?? "", /bogus_rule_field/);
});

// --- Transient catalog notifications (tasks 4.1-4.3) -------------------------
// These go through the extension default export's registered handlers: the
// provider is captured from pi.registerProvider, the session context from the
// registered session_start/session_shutdown handlers, and refreshModels runs
// the real fetch->compile->publish path against a loopback gateway.

type SessionHandler = (event: unknown, ctx: unknown) => unknown;

async function loadExtension(dependencies?: Parameters<typeof import("../index.ts").default>[1]) {
  const extension = (await import("../index.ts")).default;
  const handlers = new Map<string, SessionHandler>();
  const commands = new Map<string, { handler: (args: string, ctx: never) => Promise<void> }>();
  const registered: { provider?: ReturnType<typeof createOpenAIApiProvider> } = {};
  let appended = 0;
  const pi = {
    on: (name: string, handler: SessionHandler) => { handlers.set(name, handler); },
    registerCommand: (name: string, command: { handler: (args: string, ctx: never) => Promise<void> }) => { commands.set(name, command); },
    registerProvider: (provider: ReturnType<typeof createOpenAIApiProvider>) => { registered.provider = provider; },
    registerEntryRenderer: () => { throw new Error("entry renderers must not be registered"); },
    appendEntry: () => { appended++; },
  };
  await extension(pi as never, dependencies);
  assert.ok(registered.provider, "provider registered");
  return { handlers, commands, provider: registered.provider, appends: () => appended };
}

function notifyContext(hasUI: boolean, sink: { message: string; type?: string }[]) {
  return {
    hasUI,
    ui: { notify: (message: string, type?: string) => sink.push({ message, type }) },
    sessionManager: { getSessionId: () => "test" },
    cwd: process.cwd(),
    isProjectTrusted: () => true,
  };
}

function refreshContext(credential: { key: string; baseUrl: string }, published: boolean[] = []) {
  return {
    credential: { type: "api_key" as const, key: credential.key, env: { [BASE_URL_ENV]: credential.baseUrl } },
    stored: undefined,
    publish: async () => (published.push(true), true),
    allowNetwork: true,
    signal: new AbortController().signal,
  };
}

test("provider-info prefixes configured and unconfigured connection results", async () => {
  metadataEnv(undefined);
  const server = await gateway("info-prefix-model");
  const { commands, appends } = await loadExtension();
  const notices: { message: string; type?: string }[] = [];
  let auth: { auth: { baseUrl: string; apiKey: string } } | undefined;
  const ctx = {
    ...notifyContext(true, notices),
    modelRegistry: { getProviderAuth: async () => auth },
  };
  await commands.get("provider-info")!.handler("", ctx as never);
  assert.equal(notices[0]?.type, "warning");
  auth = { auth: { baseUrl: server.baseUrl, apiKey: "test-key" } };
  await commands.get("provider-info")!.handler("", ctx as never);
  assert.equal(notices[1]?.type, "info");
  assert.ok(notices.every((notice) => notice.message.startsWith(`${OUTPUT_PREFIX} `)));
  assert.ok(notices.every((notice) => !notice.message.includes("test-key")));
  assert.match(notices[1].message, /connected; API key valid/);
  assert.equal(appends(), 0);
});

test("automatic package checks start only after accepted network publication and never block it", async () => {
  metadataEnv(undefined);
  const server = await gateway("auto-check-model");
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  let checks = 0;
  const { handlers, provider } = await loadExtension({ metadataCompile: currentDeps, metadataCommands: {
    getDeps: () => ({ agentDir: "unused", hostRuntime: { bunRuntime: false, bunBinary: false, execPath: process.execPath } }),
    automaticState: { started: false },
    check: async () => {
      checks++;
      await wait;
      return { manager: { kind: "npm", reason: "test" }, updateAvailable: false, packages: {
        "@opencode-ai/models": { status: "up-to-date", localVersion: "1.0.0", latest: "1.0.0" },
        modelparams: { status: "up-to-date", localVersion: "1.0.0", latest: "1.0.0" },
      } };
    },
  } });
  const ui: { message: string; type?: string }[] = [];
  await handlers.get("session_start")?.({}, { ...notifyContext(true, ui), mode: "tui" });
  const context = refreshContext({ key: "test-key", baseUrl: server.baseUrl });
  await provider.refreshModels?.({ ...context, allowNetwork: false } as never);
  await provider.refreshModels?.({ ...context, publish: async () => false } as never);
  assert.equal(checks, 0);
  await provider.refreshModels?.(context as never);
  assert.equal(checks, 1, "refresh returns while registry promise remains pending");
  await provider.refreshModels?.(context as never);
  assert.equal(checks, 1);
  release();
  await handlers.get("session_shutdown")?.({}, undefined);
});

test("enrichment keeps the original public id on the wire; display name follows the chain", { timeout: 10_000 }, async () => {
  // The metadata source names the model (external `name` + canonical id):
  // the display name follows the chain, but the published model and the
  // Responses request model stay the upstream identity.
  const FIXTURE: SourceTables = {
    modelsDev: {
      providers: {
        acme: {
          models: {
            "wire-m": {
              name: "External Display Name",
              canonical_model_id: "acme/wire-m",
              limit: { context: 555000, output: 4444 },
            },
          },
        },
      },
      models: { "acme/wire-m": { name: "External Display Name", limit: { context: 555000 } } },
    },
    modelparams: { catalog: [] },
    degraded: [],
  };
  metadataEnv(undefined, FIXTURE);
  const bodies: Record<string, unknown>[] = [];
  const server = createServer(async (request, response) => {
    if (request.url?.startsWith("/v1/models")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        models: [{ slug: "wire-m", name: "Gateway Wire", context_window: 64000 }],
      }));
      return;
    }
    try {
      bodies.push(await readJsonBody(request) as Record<string, unknown>);
      const message = {
        id: "msg_wire_1", type: "message", role: "assistant", status: "completed",
        content: [{ type: "output_text", text: "wire ok", annotations: [] }],
      };
      response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
      for (const event of [
        { type: "response.created", response: { id: "resp_wire_1" } },
        { type: "response.output_item.added", output_index: 0, item: message },
        { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "wire ok" },
        { type: "response.output_item.done", output_index: 0, item: message },
        { type: "response.completed", response: { id: "resp_wire_1", status: "completed", output: [message],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
      ]) response.write(`data: ${JSON.stringify(event)}\n\n`);
      response.end("data: [DONE]\n\n");
    } catch {
      response.writeHead(400, { connection: "close" }).end("Invalid request body");
    }
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  const credentials = new InMemoryCredentialStore();
  await credentials.modify(PROVIDER, async () => ({
    type: "api_key", key: "test-key", env: { [BASE_URL_ENV]: baseUrl },
  }));
  const models = createModels({ credentials, authContext: authContext() });
  const provider = createOpenAIApiProvider([], undefined, undefined, undefined, undefined, currentDeps);
  models.setProvider(provider);
  const result = await models.refresh();
  assert.equal(result.errors.size, 0);
  const model = models.getModel(PROVIDER, "wire-m");
  assert.ok(model, "public id unchanged");
  assert.equal(model?.name, "External Display Name", "the default chain puts the source ahead of @self");
  assert.equal(model?.contextWindow, 555000, "capability fields still merge");
  assert.equal(models.getModel(PROVIDER, "acme/wire-m"), undefined, "no new public model");
  const out = await provider.streamSimple(model!, {
    systemPrompt: "s", messages: [{ role: "user", content: "hi", timestamp: 1 }],
  }, { transport: "sse", sessionId: "wire-m-session", apiKey: "test-key", maxRetries: 0,
    signal: AbortSignal.timeout(5_000) }).result();
  assert.equal(out.stopReason, "stop", out.errorMessage);
  assert.equal(bodies[0]?.model, "wire-m", "request model is the original public id");
});

test("catalog notes notify the live UI context and never append session entries", async () => {
  metadataEnv(undefined);
  const gatewayServer = await gateway("totally-unmatched-xyz", "test-key", false);
  const { handlers, provider, appends } = await loadExtension();
  const ui: { message: string; type?: string }[] = [];
  handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, notifyContext(true, ui));
  const stderr: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => stderr.push(args.join(" "));
  try {
    await provider.refreshModels?.(refreshContext({ key: "test-key", baseUrl: gatewayServer.baseUrl }) as never);
  } finally {
    console.error = originalError;
  }
  assert.equal(appends(), 0, "no session entries may be appended");
  assert.ok(ui.some((n) => n.type === "info" && /unmatched/.test(n.message)), JSON.stringify(ui));
  assert.ok(ui.every((notice) => notice.message.startsWith(`${OUTPUT_PREFIX} `)));
  assert.deepEqual(stderr, [], "with UI nothing goes to stderr");
  const categories = ui.find((n) => /metadata match:/.test(n.message))?.message ?? "";
  assert.match(categories, /0 complete, 0 partial-source-missing, 1 unmatched of 1 enabled/);
});

test("without UI or context diagnostics go to stderr only, stdout stays clean", async () => {
  metadataEnv(undefined);
  const gatewayServer = await gateway("totally-unmatched-stderr", "test-key", false);
  const { handlers, provider, appends } = await loadExtension();
  const ui: { message: string; type?: string }[] = [];
  handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, notifyContext(false, ui));
  const stderr: string[] = [];
  const stdout: string[] = [];
  const originalError = console.error;
  const originalLog = console.log;
  console.error = (...args: unknown[]) => stderr.push(args.join(" "));
  console.log = (...args: unknown[]) => stdout.push(args.join(" "));
  try {
    await provider.refreshModels?.(refreshContext({ key: "test-key", baseUrl: gatewayServer.baseUrl }) as never);
  } finally {
    console.error = originalError;
    console.log = originalLog;
  }
  assert.equal(appends(), 0);
  assert.deepEqual(ui, [], "non-UI context never calls ui.notify");
  assert.deepEqual(stdout, [], "stdout stays clean");
  assert.ok(stderr.some((line) => line.startsWith(`${OUTPUT_PREFIX} `) && /unmatched/.test(line)), JSON.stringify(stderr));
});

test("session_shutdown clears the context: later diagnostics use stderr", async () => {
  metadataEnv(undefined);
  const gatewayServer = await gateway("totally-unmatched-shutdown", "test-key", false);
  const { handlers, provider } = await loadExtension();
  const ui: { message: string; type?: string }[] = [];
  handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, notifyContext(true, ui));
  await handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, undefined);
  const stderr: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => stderr.push(args.join(" "));
  try {
    await provider.refreshModels?.(refreshContext({ key: "test-key", baseUrl: gatewayServer.baseUrl }) as never);
  } finally {
    console.error = originalError;
  }
  assert.deepEqual(ui, [], "stale UI context must not be reused");
  assert.ok(stderr.some((line) => /unmatched/.test(line)));
});

test("superseded publish reports no stale notes; empty report resets dedupe", async () => {
  metadataEnv(undefined);
  const gatewayServer = await gateway("totally-unmatched-stale", "test-key", false);
  const { handlers, provider } = await loadExtension();
  const ui: { message: string; type?: string }[] = [];
  handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, notifyContext(true, ui));

  // A publish that returns false (superseded/aborted) must not notify.
  const rejected = {
    ...refreshContext({ key: "test-key", baseUrl: gatewayServer.baseUrl }),
    publish: async () => false,
  };
  await provider.refreshModels?.(rejected as never);
  assert.deepEqual(ui, [], "unpublished refresh must not report notes");

  // Two identical reports: only the first notifies; a clean refresh resets.
  await provider.refreshModels?.(refreshContext({ key: "test-key", baseUrl: gatewayServer.baseUrl }) as never);
  const firstCount = ui.length;
  await provider.refreshModels?.(refreshContext({ key: "test-key", baseUrl: gatewayServer.baseUrl }) as never);
  assert.equal(ui.length, firstCount, "identical consecutive report is suppressed");
});

test("a throwing notifier falls back to stderr without hiding the refresh result", async () => {
  metadataEnv(undefined);
  const gatewayServer = await gateway("totally-unmatched-throw", "test-key", false);
  const { handlers, provider } = await loadExtension();
  handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, {
    hasUI: true,
    ui: { notify: () => { throw new Error("notify boom"); } },
    sessionManager: { getSessionId: () => "test" },
    cwd: process.cwd(),
    isProjectTrusted: () => true,
  });
  const stderr: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => stderr.push(args.join(" "));
  try {
    // The refresh itself succeeds; the broken notifier must not convert it
    // into an error and the diagnostic still lands on stderr.
    await provider.refreshModels?.(refreshContext({ key: "test-key", baseUrl: gatewayServer.baseUrl }) as never);
  } finally {
    console.error = originalError;
  }
  assert.ok(stderr.some((line) => /unmatched/.test(line)), JSON.stringify(stderr));
});

test("config error reports an error notification and keeps the old catalog", async () => {
  metadataEnv("fill_missing_only: maybe");
  const gatewayServer = await gateway("cfg-model", "test-key");
  const { handlers, provider, appends } = await loadExtension();
  const ui: { message: string; type?: string }[] = [];
  handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, notifyContext(true, ui));
  await assert.rejects(
    provider.refreshModels?.(refreshContext({ key: "test-key", baseUrl: gatewayServer.baseUrl }) as never),
    /fill_missing_only/,
  );
  assert.equal(appends(), 0);
  assert.ok(ui.some((n) => n.type === "error" && /fill_missing_only/.test(n.message)), JSON.stringify(ui));
  assert.doesNotMatch(ui.map((n) => n.message).join("\n"), /test-key/, "credential must be redacted");
});

test("matchCategories: mutually exclusive, conservative, name-only is not a hit", async () => {
  const { matchCategories, mapCompiledCatalog } = await import("../index.ts");
  const { compileCatalog } = await import("../model-metadata.ts");
  const { matchRules } = await import("../metadata-glob.ts");
  const { parseMetadataConfig } = await import("../metadata-config.ts");
  const t = {
    modelsDev: {
      providers: {
        acme: { models: { "full-m": { canonical_model_id: "acme/full-m", limit: { context: 64 } } } },
      },
      models: {},
    },
    modelparams: { catalog: [] },
    degraded: [],
  };
  const config = parseMetadataConfig(`models:
  - match: "full-m"
    chain: ["models.dev/@creator/api_key"]
  - match: "off-m"
    chain: ["@self"]
  - match: "name-m"
    chain: ["models.dev/acme/api_key/name-m"]
`);
  const ids = ["full-m", "partial-m", "none-m", "name-m", "off-m"];
  const compiled = compileCatalog(config, ids, {
    ...t,
    modelsDev: {
      providers: {
        acme: {
          models: {
            "full-m": { canonical_model_id: "acme/full-m", limit: { context: 64 } },
            "partial-m": { canonical_model_id: "acme/partial-m", limit: { context: 65 } },
            "name-m": { name: "Only A Name" },
          },
        },
      },
      models: {},
    },
  }, matchRules(config, ids));
  // partial-m: models.dev hits but the modelparams entry stays unresolved.
  const categories = matchCategories(compiled.models);
  assert.deepEqual(categories, { complete: 1, partial: 1, unmatched: 2, disabled: 1 });
  const total = categories.complete + categories.partial + categories.unmatched;
  assert.equal(total, 4, "enabled models conserve");
  // Name-only enrichment produces a note counting it as unmatched.
  const out = mapCompiledCatalog(
    ["full-m", "partial-m", "none-m", "name-m", "off-m"].map((id) => ({ id })),
    "http://127.0.0.1:1/v1",
    compiled,
  );
  const note = out.notes.find((n) => /metadata match:/.test(n));
  assert.match(note ?? "", /1 complete, 1 partial-source-missing, 2 unmatched of 4 enabled \(1 with external chain disabled\)/);
});
