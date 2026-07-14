import { describe, expect, test } from "bun:test";
import type { AgentRunRequest } from "../workflow/agent-runner.ts";
import { runReviewAgent } from "./runner.ts";

const request: AgentRunRequest = {
  cwd: "/repo",
  thinkingLevel: "medium",
  systemPrompt: "Review the change.",
  prompt: "Inspect the diff.",
  fileEditingToolsEnabled: false,
};

describe("runReviewAgent", () => {
  test("fails closed when the agent returns prose instead of submitting", () => {
    expect(runReviewAgent(request, () => Promise.resolve("Looks good."), { allowRestart: false })).rejects.toThrow("without calling submit_review");
  });
});
