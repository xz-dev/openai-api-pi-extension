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
  const provider = createOpenAIApiProvider();
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
  const gatewayServer = await gateway("login-model");
  const credentials = new InMemoryCredentialStore();
  const modelsStore = new InMemoryModelsStore();
  const models = createModels({ credentials, modelsStore, authContext: authContext() });
  models.setProvider(createOpenAIApiProvider());
  const prompts: AuthPrompt[] = [];
  const answers = [gatewayServer.baseUrl, "test-key"];

  const credential = await models.login(PROVIDER, "api_key", {
    prompt: async (prompt) => {
      prompts.push(prompt);
      return answers.shift() ?? "";
    },
    notify: () => undefined,
  });

  assert.deepEqual(
    prompts.map((prompt) => prompt.type),
    ["text", "secret"],
  );
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

test("host convergence persists factory-prefetched models without another network request", async () => {
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
  models.setProvider(createOpenAIApiProvider([prefetched]));

  const result = await models.refresh({ allowNetwork: false });
  assert.equal(result.errors.size, 0);
  assert.deepEqual((await modelsStore.read(PROVIDER))?.models, [prefetched]);
});

test("Pi persists dynamic models and restores them offline without network", async () => {
  const gatewayServer = await gateway("stored-model");
  const credentials = new InMemoryCredentialStore();
  const modelsStore = new InMemoryModelsStore();
  await credentials.modify(PROVIDER, async () => ({
    type: "api_key",
    key: "test-key",
    env: { [BASE_URL_ENV]: gatewayServer.baseUrl },
  }));

  const online = createModels({ credentials, modelsStore, authContext: authContext() });
  online.setProvider(createOpenAIApiProvider());
  const result = await online.refresh();
  assert.equal(result.errors.size, 0);
  assert.equal(online.getModel(PROVIDER, "stored-model")?.baseUrl, gatewayServer.baseUrl);
  assert.equal(gatewayServer.requests.length, 1);

  const offline = createModels({ credentials, modelsStore, authContext: authContext() });
  offline.setProvider(createOpenAIApiProvider());
  const restored = await offline.refresh({ allowNetwork: false });
  assert.equal(restored.errors.size, 0);
  assert.equal(offline.getModel(PROVIDER, "stored-model")?.baseUrl, gatewayServer.baseUrl);
  assert.equal(gatewayServer.requests.length, 1, "offline restore must not fetch");
});

test("environment fields override stored connection during refresh and request auth", async () => {
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
  models.setProvider(createOpenAIApiProvider());

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
  const apiKeyAuth = createOpenAIApiProvider().auth.apiKey;
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
  models.setProvider(createOpenAIApiProvider());

  const result = await models.refresh();
  assert.equal(result.errors.size, 0);
  assert.equal(storedGateway.requests.length, 0);
  assert.equal(await models.getAuth(PROVIDER), undefined);
});

test("login saves the API key; catalog without limits maps via defaults and refresh succeeds", async () => {
  const gatewayServer = await gateway("axis/codex-auto-review", "test-key", false);
  const credentials = new InMemoryCredentialStore();
  const modelsStore = new InMemoryModelsStore();
  const models = createModels({ credentials, modelsStore, authContext: authContext() });
  models.setProvider(createOpenAIApiProvider());
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
  models.setProvider(createOpenAIApiProvider());

  const result = await models.refresh();
  assert.equal(result.errors.size, 0, "missing limits must not fail refresh");
  assert.equal(models.getModel(PROVIDER, "untrusted-model")?.contextWindow, 128_000);
});

test("refresh without catalog errors reports nothing and publishes models", async () => {
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
  }));

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
  models.setProvider(createOpenAIApiProvider());
  const controller = new AbortController();
  const refresh = models.refresh({ signal: controller.signal });
  controller.abort();

  const result = await refresh;
  assert.equal(result.aborted, true);
  assert.equal(models.getModels(PROVIDER).length, 0);
});

// --- Metadata fallback chain lifecycle (tasks 4.1-4.4) ----------------------
// Loopback fixtures only; SOURCE_URLS/hooks inject the fake source endpoints.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MetadataHooks } from "../index.ts";

const metadataDirs: string[] = [];
async function metadataHooks(yaml: string | undefined, sourcePayloads: Record<string, unknown> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "openai-api-metadata-"));
  metadataDirs.push(dir);
  const configPath = join(dir, "openai-api-extension.yaml");
  if (yaml !== undefined) await writeFile(configPath, yaml);
  const hits: Record<string, number> = {};
  const make = async (key: string, payload: unknown) => {
    const server = createServer((request, response) => {
      hits[key] = (hits[key] ?? 0) + 1;
      assert.equal(request.headers.authorization, undefined, "metadata sources must never see gateway credentials");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(payload));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    return `http://127.0.0.1:${address.port}`;
  };
  const hooks: MetadataHooks = {
    configPath: () => configPath,
    sourceUrls: {
      modelsDevApi: await make("modelsDevApi", sourcePayloads.modelsDevApi ?? {}),
      modelsDevFlat: await make("modelsDevFlat", sourcePayloads.modelsDevFlat ?? {}),
      modelparams: await make("modelparams", sourcePayloads.modelparams ?? { models: [] }),
    },
  };
  return { hooks, hits };
}

afterEach(async () => {
  await Promise.all(metadataDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const MODELS_DEV_API = {
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
};

test("refresh enriches models through the shared metadata path", async () => {
  const gatewayServer = await gateway("gpt-meta", "test-key", false);
  const { hooks, hits } = await metadataHooks(undefined, { modelsDevApi: MODELS_DEV_API });
  const credentials = new InMemoryCredentialStore();
  await credentials.modify(PROVIDER, async () => ({
    type: "api_key", key: "test-key", env: { [BASE_URL_ENV]: gatewayServer.baseUrl },
  }));
  const models = createModels({ credentials, authContext: authContext() });
  models.setProvider(createOpenAIApiProvider([], undefined, undefined, undefined, hooks));

  const result = await models.refresh();
  assert.equal(result.errors.size, 0);
  const model = models.getModel(PROVIDER, "gpt-meta");
  assert.equal(model?.contextWindow, 200_000, "metadata chain overwrites upstream default");
  assert.equal(model?.maxTokens, 32_768);
  assert.equal(hits.modelsDevApi, 1, "one shared read per endpoint per refresh");
  assert.equal(hits.modelsDevFlat, 1);
  assert.equal(hits.modelparams, 1);
});

test("offline restore reads no config and hits no metadata source", async () => {
  const { hooks, hits } = await metadataHooks("source_priority: [\"models.dev/*/subscription\"]");
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
  models.setProvider(createOpenAIApiProvider([], undefined, undefined, undefined, hooks));

  const result = await models.refresh({ allowNetwork: false });
  assert.equal(result.errors.size, 0);
  assert.equal(models.getModel(PROVIDER, "stored-model")?.contextWindow, 64000);
  assert.deepEqual(hits, {}, "offline must not fetch metadata");
});

test("invalid metadata config blocks the new catalog, keeps the old one, and is not an auth error", async () => {
  const gatewayServer = await gateway("fresh-model", "test-key");
  const { hooks, hits } = await metadataHooks("fill_missing_only: maybe");
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
  models.setProvider(createOpenAIApiProvider([], (message) => reported.push(message), undefined, undefined, hooks));

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
  const dir = await mkdtemp(join(tmpdir(), "openai-api-metadata-"));
  metadataDirs.push(dir);
  const dead = createServer((_request, response) => { response.writeHead(500).end(); });
  servers.push(dead);
  await new Promise<void>((resolve) => dead.listen(0, "127.0.0.1", resolve));
  const deadAddress = dead.address();
  assert.ok(deadAddress && typeof deadAddress === "object");
  const deadUrl = `http://127.0.0.1:${deadAddress.port}`;
  const hooks: MetadataHooks = {
    configPath: () => join(dir, "openai-api-extension.yaml"),
    sourceUrls: { modelsDevApi: deadUrl, modelsDevFlat: deadUrl, modelparams: deadUrl },
  };
  const credentials = new InMemoryCredentialStore();
  await credentials.modify(PROVIDER, async () => ({
    type: "api_key", key: "test-key", env: { [BASE_URL_ENV]: gatewayServer.baseUrl },
  }));
  const reported: string[] = [];
  const models = createModels({ credentials, authContext: authContext() });
  models.setProvider(createOpenAIApiProvider([], (message) => reported.push(message), undefined, undefined, hooks));

  const result = await models.refresh();
  assert.equal(result.errors.size, 0, "degraded enrichment is not a refresh error");
  assert.equal(models.getModel(PROVIDER, "degraded-model")?.contextWindow, 128_000, "upstream defaults apply");
  assert.ok(reported.some((message) => /metadata source .* unavailable/i.test(message)));
});

test("login saves the validated key and reports a metadata config error, not an auth failure", async () => {
  const gatewayServer = await gateway("login-meta-model", "test-key");
  const { hooks } = await metadataHooks("source_priority: not-a-list");
  const credentials = new InMemoryCredentialStore();
  const models = createModels({ credentials, authContext: authContext() });
  models.setProvider(createOpenAIApiProvider([], undefined, undefined, undefined, hooks));
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

  // Metadata sources hang until the caller signal aborts.
  const dir = await mkdtemp(join(tmpdir(), "openai-api-metadata-"));
  metadataDirs.push(dir);
  const hanging = createServer((request, _response) => {
    request.socket.on("close", () => undefined); // never respond
  });
  servers.push(hanging);
  await new Promise<void>((resolve) => hanging.listen(0, "127.0.0.1", resolve));
  const address = hanging.address();
  assert.ok(address && typeof address === "object");
  const deadUrl = `http://127.0.0.1:${address.port}`;
  const hooks: MetadataHooks = {
    configPath: () => join(dir, "openai-api-extension.yaml"),
    sourceUrls: { modelsDevApi: deadUrl, modelsDevFlat: deadUrl, modelparams: deadUrl },
  };

  const models = createModels({ credentials, modelsStore, authContext: authContext() });
  models.setProvider(createOpenAIApiProvider([], undefined, undefined, undefined, hooks));

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

test("source_priority: [] opts out of all metadata network reads", async () => {
  const gatewayServer = await gateway("optout-model", "test-key", false);
  const { hooks, hits } = await metadataHooks("source_priority: []");
  const credentials = new InMemoryCredentialStore();
  await credentials.modify(PROVIDER, async () => ({
    type: "api_key", key: "test-key", env: { [BASE_URL_ENV]: gatewayServer.baseUrl },
  }));
  const models = createModels({ credentials, authContext: authContext() });
  models.setProvider(createOpenAIApiProvider([], undefined, undefined, undefined, hooks));

  const result = await models.refresh();
  assert.equal(result.errors.size, 0);
  assert.equal(models.getModel(PROVIDER, "optout-model")?.contextWindow, 128_000);
  assert.deepEqual(hits, {}, "explicit empty chain must not fetch");
});

test("unknown config fields warn once and the rest of the config still applies", async () => {
  const gatewayServer = await gateway("warn-model", "test-key", false);
  const { hooks } = await metadataHooks(
    "unsupported_gateway_field: true\nchannels:\n  chan:\n    metadata_from: cpa\n",
  );
  const credentials = new InMemoryCredentialStore();
  await credentials.modify(PROVIDER, async () => ({
    type: "api_key", key: "test-key", env: { [BASE_URL_ENV]: gatewayServer.baseUrl },
  }));
  const reported: string[] = [];
  const models = createModels({ credentials, authContext: authContext() });
  models.setProvider(createOpenAIApiProvider([], (message) => reported.push(message), undefined, undefined, hooks));

  const result = await models.refresh();
  assert.equal(result.errors.size, 0);
  assert.ok(models.getModel(PROVIDER, "warn-model"));
  const warnings = reported.filter((message) => /ignored unsupported fields/.test(message));
  assert.equal(warnings.length, 1, "one aggregated note line per refresh");
  assert.match(warnings[0] ?? "", /unsupported_gateway_field/);
  assert.match(warnings[0] ?? "", /channels\.chan\.metadata_from/);
});
