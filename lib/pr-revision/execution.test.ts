import { describe, expect, test } from "bun:test";
import {
  formatRevisionExecutionMarkdown,
  parseRevisionExecutionResultJson,
  RevisionExecutionOutputContractError,
  revisionFeedbackDispositions,
  validateRevisionExecutionResult,
} from "./execution.ts";
import { revisionExecutionResult } from "../testing/revision-executions.ts";
import { revisionPlanResult } from "../testing/revision-plans.ts";

describe("structured PR revision execution", () => {
  test("rejects Markdown and repository-escaping changed-file paths", () => {
    expect(() => parseRevisionExecutionResultJson("# Revision Log\n")).toThrow(RevisionExecutionOutputContractError);
    expect(() => parseRevisionExecutionResultJson(JSON.stringify(revisionExecutionResult({
      changedFiles: [{ path: "../outside.ts", description: "Escapes the repository." }],
    })))).toThrow("must not escape the repository");
  });

  test("derives one linked disposition list and Markdown from validated fields", () => {
    const plan = revisionPlanResult("revise");
    const result = revisionExecutionResult({
      feedbackDispositions: [{ feedbackId: "pr:12", status: "addressed", details: "Corrected the public behavior." }],
      additionalSections: [{
        heading: "Discovery during validation",
        items: ["The same command also exercises the compatibility path."],
      }],
    });

    expect(revisionFeedbackDispositions(plan, result)).toEqual([{
      feedbackId: "pr:12",
      sourceIds: ["pr:12"],
      summary: "Address the current PR feedback.",
      classification: "must-fix-current",
      status: "addressed",
      details: "Corrected the public behavior.",
    }]);
    const markdown = formatRevisionExecutionMarkdown(result, "Revision Log");
    expect(markdown).toContain("`pr:12` [addressed] Corrected the public behavior.");
    expect(markdown).toContain("## Discovery during validation");
  });

  test("requires every planned feedback id exactly once and rejects unknown ids", () => {
    const plan = revisionPlanResult("revise");
    expect(() => validateRevisionExecutionResult(revisionExecutionResult({ feedbackDispositions: [] }), plan)).toThrow("missing: pr:12");
    expect(() => validateRevisionExecutionResult(revisionExecutionResult({
      feedbackDispositions: [{ feedbackId: "other", status: "addressed", details: "Wrong item." }],
    }), plan)).toThrow("unknown: other");
    expect(() => validateRevisionExecutionResult(revisionExecutionResult({
      feedbackDispositions: [
        { feedbackId: "pr:12", status: "addressed", details: "First." },
        { feedbackId: "pr:12", status: "addressed", details: "Second." },
      ],
    }), plan)).toThrow("ids must be unique");
  });
});
