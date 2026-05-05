import { describe, expect, test } from "bun:test";
import { defaultRoarkModel, extractAgentErrorMessage, requestedModelSpec } from "./agent.ts";

describe("Pi agent model selection", () => {
  test("hard defaults to GPT 5.5 when no model override is provided", () => {
    expect(defaultRoarkModel).toBe("openai-codex/gpt-5.5");
    expect(requestedModelSpec()).toBe("openai-codex/gpt-5.5");
  });

  test("still honors an explicit model override", () => {
    expect(requestedModelSpec("openrouter/deepseek/deepseek-v4-pro")).toBe("openrouter/deepseek/deepseek-v4-pro");
  });
});

describe("extractAgentErrorMessage", () => {
  test("surfaces provider errors instead of letting them become empty artifacts", () => {
    const error = extractAgentErrorMessage([
      {
        role: "assistant",
        provider: "anthropic",
        model: "claude-opus-4-7",
        stopReason: "error",
        errorMessage: "quota exhausted",
        content: [],
      },
    ]);

    expect(error).toBe("anthropic/claude-opus-4-7 failed: quota exhausted");
  });

  test("returns undefined when the last assistant message did not error", () => {
    expect(extractAgentErrorMessage([{ role: "assistant", stopReason: "end_turn", content: "ok" }])).toBeUndefined();
  });
});
