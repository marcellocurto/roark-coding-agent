import { describe, expect, test } from "bun:test";
import {
  formatWorkflowStoppedComment,
  mapStopVerdictToLabel,
} from "./workflow-stop.ts";

describe("triage stop handling", () => {
  test("includes reassessment guidance after the actionable stop", () => {
    const comment = formatWorkflowStoppedComment({
      issueNumber: 12,
      verdict: "needs-human-decision",
      artifactContent:
        "# Plan\n\n## Blocking Questions\nMay existing data be deleted?",
      recoveryCommand: "roark continue 12 --attempt 1",
    });
    expect(comment).toContain("May existing data be deleted?");
    expect(comment).toContain("roark continue 12 --attempt 1");
  });
  test("maps verdicts to terminal labels", () => {
    expect(mapStopVerdictToLabel("blocked")).toBe("blocked");
    expect(mapStopVerdictToLabel("needs-human-decision")).toBe("needs-human");
    expect(mapStopVerdictToLabel("reject")).toBe("triage-rejected");
  });

  test("uses the complete sanitized triage artifact as the comment body", () => {
    const evidence = "x".repeat(10_001);
    const comment = formatWorkflowStoppedComment({
      issueNumber: 12,
      verdict: "reject",
      artifactContent: `# Triage\n\nTOKEN=secret\n/Users/alice/private\n${evidence}`,
    });

    expect(comment).toBe(
      `# Triage\n\nTOKEN=[redacted]\n[local path redacted]\n${evidence}\n`,
    );
  });
});
