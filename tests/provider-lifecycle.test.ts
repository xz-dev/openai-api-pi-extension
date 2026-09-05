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
