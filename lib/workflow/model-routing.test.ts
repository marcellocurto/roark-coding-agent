import { describe, expect, test } from "bun:test";
import { effectiveModelForStage } from "./model-routing.ts";

describe("workflow model routing", () => {
  test("an explicit model still overrides the code refinement route", () => {
    expect(effectiveModelForStage("provider/custom-model", "codeRefinement")).toBe("provider/custom-model");
  });
});
