import { describe, expect, test } from "bun:test";
import { effectiveModelForStage, models, workflowModelRoutes } from "./model-routing.ts";

describe("workflow model routing", () => {
  test("code refinement has an independent model route", () => {
    expect(workflowModelRoutes.codeRefinement).toBe(models.gpt56Sol);
    expect(effectiveModelForStage(undefined, "codeRefinement")).toBe(models.gpt56Sol);
  });

  test("an explicit model still overrides the code refinement route", () => {
    expect(effectiveModelForStage("provider/custom-model", "codeRefinement")).toBe("provider/custom-model");
  });
});
