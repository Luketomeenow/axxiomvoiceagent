import { describe, expect, test } from "bun:test";

import { toFoundryRequest } from "./llmRelay.ts";

// What Foundry's GPT deployments reject (HTTP 400 = a dead turn mid-call):
// max_tokens, a custom temperature, parallel_tool_calls without tools, and any
// field outside the chat-completions API (Vapi adds call/metadata objects).
describe("toFoundryRequest", () => {
  test("renames max_tokens, drops temperature and Vapi-only fields", () => {
    const out = toFoundryRequest({
      model: "gpt-5.6-terra",
      stream: true,
      temperature: 0.3,
      max_tokens: 250,
      call: { id: "c1" },
      metadata: { a: 1 },
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "optOut" } }],
      parallel_tool_calls: false,
    });
    expect(out).toEqual({
      model: "gpt-5.6-terra",
      stream: true,
      max_completion_tokens: 250,
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "optOut" } }],
      parallel_tool_calls: false,
    });
  });

  test("keeps an explicit max_completion_tokens; strips tool settings when there are no tools", () => {
    const out = toFoundryRequest({ model: "m", max_tokens: 1, max_completion_tokens: 99, tools: [], tool_choice: "auto", parallel_tool_calls: true, messages: [] });
    expect(out).toEqual({ model: "m", max_completion_tokens: 99, messages: [] });
  });

  test("falls back to VOICE_MODEL when Vapi sends no model", () => {
    expect(typeof toFoundryRequest({ messages: [] }).model).toBe("string");
  });
});
