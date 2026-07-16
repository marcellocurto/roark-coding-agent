import { describe, expect, test } from "bun:test";
import { formatRevisionPlanMarkdown, validateRevisionPlanResult } from "./plan.ts";

describe("structured PR revision plans", () => {
  test("rejects a no-action status when the plan contains a required fix", () => {
    expect(() => validateRevisionPlanResult({
      status: "no-action-needed",
      classifiedFeedback: ["[must-fix-current] The response contract is incomplete."],
      mustFixCurrent: ["Restore the required response field."],
      humanNeeds: [],
    })).toThrow("expected 'revise'");
  });

  test("preserves freely named planning context without changing status routing", () => {
    const result = validateRevisionPlanResult({
      status: "no-action-needed",
      classifiedFeedback: [],
      mustFixCurrent: [],
      humanNeeds: [],
      additionalSections: [{
        heading: "Interaction between comments",
        items: ["The two comments describe the same already-addressed behavior from different call sites."],
      }],
    });

    expect(result.status).toBe("no-action-needed");
    expect(formatRevisionPlanMarkdown(result)).toContain("## Interaction between comments");
  });
});
