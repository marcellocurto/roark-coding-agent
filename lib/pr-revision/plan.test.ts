import { describe, expect, test } from "bun:test";
import { validateRevisionPlanResult } from "./plan.ts";

describe("structured PR revision plans", () => {
  test("rejects a no-action status when the plan contains a required fix", () => {
    expect(() => validateRevisionPlanResult({
      status: "no-action-needed",
      classifiedFeedback: ["[must-fix-current] The response contract is incomplete."],
      mustFixCurrent: ["Restore the required response field."],
      humanNeeds: [],
    })).toThrow("expected 'revise'");
  });
});
