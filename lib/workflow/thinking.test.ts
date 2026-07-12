import { describe, expect, test } from "bun:test";
import { getWorkflowThinkingConfig, workflowThinkingProfiles, workflowThinkingStages } from "./thinking.ts";

describe("getWorkflowThinkingConfig", () => {
  test("explicit thinking level uniformly overrides any profile", () => {
    const config = getWorkflowThinkingConfig({ profile: "fast", explicitThinkingLevel: "medium" });
    for (const stage of workflowThinkingStages) expect(config[stage]).toBe("medium");
  });

  test("code refinement has an independent profile stage", () => {
    expect(workflowThinkingProfiles.fast.codeRefinement).toBe("low");
    expect(workflowThinkingProfiles.default.codeRefinement).toBe("high");
    expect(workflowThinkingProfiles.deep.codeRefinement).toBe("high");
    expect(workflowThinkingStages).toContain("codeRefinement");
  });
});
