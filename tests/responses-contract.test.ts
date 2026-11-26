import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createModels, InMemoryCredentialStore, Type, type Tool } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createOpenAIApiProvider, enrichCatalog, mapModel } from "../index.ts";
import { readJsonBody } from "./fixtures/wire-decode.ts";

const PROVIDER = "openai-api-extension";
let server: Server;
let baseUrl: string;
let savedEnv: Record<string, string | undefined>;
let savedOffline: string | undefined;
let captured: { url?: string; authorization?: string; body?: Record<string, unknown> } = {};

const ENV_KEYS = ["OPENAI_API_EXTENSION_BASE_URL", "OPENAI_API_EXTENSION_API_KEY"] as const;

before(async () => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  savedOffline = process.env.PI_OFFLINE;
  for (const key of ENV_KEYS) delete process.env[key];
  delete process.env.PI_OFFLINE;
  server = createServer(async (request, response) => {
    captured.url = request.url;
    captured.authorization = request.headers.authorization;
    captured.body = (await readJsonBody(request)) as Record<string, unknown>;

    const message = {
      id: "msg_mock_1",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "gateway ok", annotations: [] }],
    };
    response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
    for (const event of [
      { type: "response.created", response: { id: "resp_mock_1" } },
      { type: "response.output_item.added", output_index: 0, item: message },
      { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "gateway ok" },
      { type: "response.output_item.done", output_index: 0, item: message },
      {
        type: "response.completed",
        response: {
          id: "resp_mock_1",
          status: "completed",
          output: [message],
          usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
        },
      },
    ]) {
      response.write(`data: ${JSON.stringify(event)}\n\n`);
    }
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  baseUrl = `http://127.0.0.1:${address.port}/v1`;
});

after(async () => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (savedOffline === undefined) delete process.env.PI_OFFLINE;
  else process.env.PI_OFFLINE = savedOffline;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

const search: Tool = {
  name: "search", description: "Search by query",
  parameters: Type.Object({ queries: Type.Array(Type.String()), offset: Type.Optional(Type.Integer()) }),
};

async function contractModels() {
  const credentials = new InMemoryCredentialStore();
  await credentials.modify(PROVIDER, async () => ({
    type: "api_key",
    key: "contract-key",
    env: { OPENAI_API_EXTENSION_BASE_URL: baseUrl },
  }));
  const models = createModels({ credentials });
  models.setProvider(createOpenAIApiProvider());
  return models;
}

test("complete provider sends Responses request through resolved auth and streams text", async () => {
  const models = await contractModels();
  const model = {
    id: "mock-gpt",
    name: "Mock GPT",
    provider: PROVIDER,
    api: "openai-responses" as const,
    baseUrl: "https://stale.invalid/v1",
    reasoning: true,
    input: ["text"] as Array<"text" | "image">,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 16384,
  };

  const output = await models.complete(
    model,
    { systemPrompt: "Be concise.", messages: [{ role: "user", content: "ping", timestamp: 1 }] },
    { transport: "sse", reasoningEffort: "high", maxRetries: 0 },
  );

  assert.equal(output.stopReason, "stop", output.errorMessage ?? "Responses request failed");
  assert.deepEqual(output.content, [{ type: "text", text: "gateway ok", textSignature: '{"v":1,"id":"msg_mock_1"}' }]);
  assert.equal(captured.url, "/v1/responses");
  assert.equal(captured.authorization, "Bearer contract-key");
  assert.deepEqual(captured.body?.reasoning, { effort: "high", summary: "auto" });
  assert.equal(captured.body?.model, "mock-gpt");
  assert.equal(captured.body?.stream, true);
});

test("ordinary and strict functions retain separate sampling policies in one request", async () => {
  const model = mapModel({ id: "new-chat-model" }, baseUrl);
  assert.ok(model);
  const classify: Tool = {
    name: "classify", description: "Classify a word",
    parameters: Type.Object({ label: Type.String({ enum: ["animal", "plant"] }) }, { additionalProperties: false }),
    constrainedSampling: { type: "json_schema", strict: "require" },
  };
  const models = await contractModels();
  const output = await models.complete(model, {
    messages: [{ role: "user", content: "classify oak", timestamp: 1 }], tools: [search, classify],
  }, { transport: "sse", maxRetries: 0 });
  assert.equal(output.stopReason, "stop", output.errorMessage);
  const tools = captured.body?.tools;
  assert.ok(Array.isArray(tools));
  assert.deepEqual(tools.map(({ name, strict, parameters }) => [name, strict, parameters.required]), [
    ["search", false, ["queries"]], ["classify", true, ["label"]],
  ]);
});

test("plugin and models.json overrides control strict field presence on the wire", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "strict-override-"));
  const saved = process.env.PI_CODING_AGENT_DIR;
  t.after(async () => {
    if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = saved;
    await rm(dir, { recursive: true, force: true });
  });
  process.env.PI_CODING_AGENT_DIR = dir;
  const authPath = join(dir, "auth.json"), modelsPath = join(dir, "models.json");
  await writeFile(authPath, JSON.stringify({ [PROVIDER]: {
    type: "api_key", key: "contract-key", env: { OPENAI_API_EXTENSION_BASE_URL: baseUrl },
  } }));
  await writeFile(join(dir, "openai-api-extension.yaml"),
    'chain: ["@self"]\nmodels:\n  - match: "legacy-*"\n    overrides:\n      compat: {supportsStrictMode: false, supportsDeveloperRole: false}\n');
  await writeFile(modelsPath, JSON.stringify({ providers: { [PROVIDER]: { modelOverrides: {
    "legacy-exception": { compat: { supportsStrictMode: true } },
  } } } }));
  const { models } = await enrichCatalog([{ id: "legacy-default" }, { id: "legacy-exception" }], baseUrl, undefined);
  const runtime = await ModelRuntime.create({ authPath, modelsPath, refreshOnCreate: false });
  runtime.registerNativeProvider(createOpenAIApiProvider(models));
  await runtime.refresh({ allowNetwork: false, providers: [PROVIDER] });
  for (const id of ["legacy-default", "legacy-exception"]) {
    const model = runtime.getModel(PROVIDER, id);
    assert.ok(model && model.api === "openai-responses");
    assert.equal(model.compat?.supportsDeveloperRole, false);
    const output = await runtime.complete(model, {
      messages: [{ role: "user", content: "search oak", timestamp: 1 }], tools: [search],
    }, { transport: "sse", maxRetries: 0 });
    assert.equal(output.stopReason, "stop", output.errorMessage);
    const tools = captured.body?.tools;
    assert.ok(Array.isArray(tools) && tools.length === 1);
    assert.equal(tools[0].name, "search");
    if (id === "legacy-exception") assert.equal(tools[0].strict, false);
    else assert.equal(Object.hasOwn(tools[0], "strict"), false);
  }
});
