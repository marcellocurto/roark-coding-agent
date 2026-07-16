import { describe, expect, test } from "bun:test";
import { formatRevisionPlanMarkdown, validateRevisionPlanResult } from "./plan.ts";

describe("structured PR revision plans", () => {
  test("rejects a no-action status when the plan contains a required fix", () => {
    expect(() => validateRevisionPlanResult({
      status: "no-action-needed",
      feedbackItems: [{
        id: "comment:1",
        sourceIds: ["comment:1"],
        summary: "Restore the required response field.",
        classification: "must-fix-current",
        rationale: "The response contract is incomplete.",
      }],
    })).toThrow("expected 'revise'");
  });

  test("preserves freely named planning context without changing status routing", () => {
    const result = validateRevisionPlanResult({
      status: "no-action-needed",
      feedbackItems: [],
      additionalSections: [{
        heading: "Interaction between comments",
        items: ["The two comments describe the same already-addressed behavior from different call sites."],
      }],
    });

    expect(result.status).toBe("no-action-needed");
    expect(formatRevisionPlanMarkdown(result)).toContain("## Interaction between comments");
  });

  test("rejects duplicate feedback identities", () => {
    const item = {
      id: "comment:1",
      sourceIds: ["comment:1"],
      summary: "One concern.",
      classification: "non-blocking" as const,
      rationale: "Optional.",
    };
    expect(() => validateRevisionPlanResult({
      status: "no-action-needed",
      feedbackItems: [item, item],
    })).toThrow("ids must be unique");
  });

  test("rejects invented source identities and item ids not derived from a source", () => {
    const base = {
      status: "no-action-needed" as const,
      feedbackItems: [{
        id: "comment:2",
        sourceIds: ["comment:2"],
        summary: "One concern.",
        classification: "non-blocking" as const,
        rationale: "Optional.",
      }],
    };
    expect(() => validateRevisionPlanResult(base, new Set(["comment:1"]))).toThrow("unknown source ids");
    expect(() => validateRevisionPlanResult({
      ...base,
      feedbackItems: [{
        id: "invented",
        sourceIds: ["comment:1"],
        summary: "One concern.",
        classification: "non-blocking",
        rationale: "Optional.",
      }],
    }, new Set(["comment:1"]))).toThrow("must derive from one of its source ids");
  });
});
