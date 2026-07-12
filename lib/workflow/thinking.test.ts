import { describe, expect, test } from "bun:test";
import { getWorkflowThinkingConfig, workflowThinkingStages } from "./thinking.ts";

describe("getWorkflowThinkingConfig", () => {
  test("explicit thinking level uniformly overrides any profile", () => {
    const config = getWorkflowThinkingConfig({ profile: "fast", explicitThinkingLevel: "medium" });
    for (const stage of workflowThinkingStages) expect(config[stage]).toBe("medium");
  });
});
