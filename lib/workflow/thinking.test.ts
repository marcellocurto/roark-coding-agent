import { describe, expect, test } from "bun:test";
import { getWorkflowThinkingConfig, workflowThinkingStages } from "./thinking.ts";

describe("getWorkflowThinkingConfig", () => {
  test("default profile preserves current workflow defaults", () => {
    expect(getWorkflowThinkingConfig()).toMatchObject({
      triage: "medium",
      plan: "high",
      implement: "high",
      reviewA: "high",
      reviewB: "high",
      fix: "high",
      finalReview: "high",
      issuePublishing: "high",
    });
  });

  test("fast profile lowers every issue workflow stage except Review A and B", () => {
    expect(getWorkflowThinkingConfig({ profile: "fast" })).toMatchObject({
      triage: "low",
      plan: "low",
      implement: "low",
      reviewA: "medium",
      reviewB: "medium",
      fix: "low",
      finalReview: "low",
      issuePublishing: "low",
    });
  });

  test("deep profile uses high for every stage", () => {
    const config = getWorkflowThinkingConfig({ profile: "deep" });
    for (const stage of workflowThinkingStages) expect(config[stage]).toBe("high");
  });

  test("explicit thinking level uniformly overrides any profile", () => {
    const config = getWorkflowThinkingConfig({ profile: "fast", explicitThinkingLevel: "medium" });
    for (const stage of workflowThinkingStages) expect(config[stage]).toBe("medium");
  });
});
