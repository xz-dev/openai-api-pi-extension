import assert from "node:assert/strict";
import { test } from "node:test";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { dropEmptyMessages } from "../index.ts";

function assistant(content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-responses",
    provider: "openai-api-extension",
    model: "mock-gpt",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

test("drops user messages with empty or whitespace-only content", () => {
  const messages: Message[] = [
    { role: "user", content: "", timestamp: Date.now() },
    { role: "user", content: "   \n\t ", timestamp: Date.now() },
    { role: "user", content: [], timestamp: Date.now() },
    { role: "user", content: [{ type: "text", text: "" }], timestamp: Date.now() },
    { role: "user", content: [{ type: "text", text: "  " }], timestamp: Date.now() },
    { role: "user", content: "hello", timestamp: Date.now() },
  ];

  const result = dropEmptyMessages(messages);

  assert.equal(result.length, 1);
  assert.equal(result[0].content, "hello");
});

for (const content of ["Be concise.", "", " \n\t "]) {
  test(`keeps system messages with content ${JSON.stringify(content)} and control metadata`, () => {
    // Newer Pi hosts supply system messages; the oldest supported peer types do not define them yet.
    const messages = [{
      role: "system",
      content,
      sections: { tools: "<tools>\n(none)\n" },
      tools: [],
      timestamp: 1,
    }] as unknown as Message[];

    const result = dropEmptyMessages(messages);

    assert.deepEqual(result, messages);
    assert.equal(result[0], messages[0]);
  });
}

test("keeps user messages that contain an image even with empty text", () => {
  const messages: Message[] = [
    {
      role: "user",
      content: [
        { type: "text", text: "" },
        { type: "image", mimeType: "image/png", data: "aGVsbG8=" },
      ],
      timestamp: Date.now(),
    },
  ];

  assert.equal(dropEmptyMessages(messages).length, 1);
});

test("drops empty assistant messages without tool calls", () => {
  const messages: Message[] = [
    { role: "user", content: "hi", timestamp: Date.now() },
    assistant([]),
    assistant([{ type: "text", text: "" }]),
    assistant([{ type: "thinking", thinking: "  " }]),
    assistant([{ type: "text", text: "answer" }]),
  ];

  const result = dropEmptyMessages(messages);

  assert.equal(result.length, 2);
  assert.deepEqual(result[1].content, [{ type: "text", text: "answer" }]);
});

test("keeps assistant messages with tool calls even when text is empty", () => {
  const messages: Message[] = [
    { role: "user", content: "hi", timestamp: Date.now() },
    assistant([
      { type: "text", text: "" },
      { type: "toolCall", id: "call_1", name: "web_search", arguments: {} },
    ]),
  ];

  const result = dropEmptyMessages(messages);

  assert.equal(result.length, 2);
  assert.equal(result[1].role, "assistant");
});

test("keeps empty-text assistant blocks that carry signatures", () => {
  const messages: Message[] = [
    { role: "user", content: "hi", timestamp: Date.now() },
    assistant([{ type: "thinking", thinking: "", thinkingSignature: "sig" }]),
    assistant([{ type: "text", text: "", textSignature: "sig" }]),
  ];

  const result = dropEmptyMessages(messages);

  assert.equal(result.length, 3);
});

test("keeps empty tool results and unknown block types", () => {
  const messages: Message[] = [
    { role: "user", content: "hi", timestamp: Date.now() },
    {
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "web_search",
      content: [],
      isError: false,
      timestamp: Date.now(),
    },
    assistant([{ type: "unknown", data: "foo" } as never]),
  ];

  const result = dropEmptyMessages(messages);

  assert.equal(result.length, 3);
  assert.equal(result[1].role, "toolResult");
});
