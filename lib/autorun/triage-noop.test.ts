import { describe, expect, test } from "bun:test";
import {
  formatTriageNoopComment,
  isTriageNoopWorkflowResult,
  triageNoopLabelForVerdict,
  triageNoopOutcomeDetail,
} from "./triage-noop.ts";

describe("triage no-op helpers", () => {
  test("maps non-proceed triage verdicts to existing terminal skip labels", () => {
    expect(triageNoopLabelForVerdict("blocked")).toBe("blocked");
    expect(triageNoopLabelForVerdict("needs-human-decision")).toBe("needs-human");
    expect(triageNoopLabelForVerdict("reject")).toBe("wontfix");
    expect(triageNoopLabelForVerdict("proceed")).toBeUndefined();
    expect(triageNoopLabelForVerdict(undefined)).toBeUndefined();
  });

  test("detects workflow results that stopped at triage", () => {
    expect(isTriageNoopWorkflowResult({ status: "stopped", phase: "triage", verdict: "blocked" })).toBe(true);
    expect(isTriageNoopWorkflowResult({ status: "stopped", phase: "planning" })).toBe(false);
    expect(isTriageNoopWorkflowResult({ status: "completed" })).toBe(false);
  });

  test("formats a concise terminal comment with artifact paths", () => {
    const comment = formatTriageNoopComment({
      issueNumber: 12,
      issueUrl: "https://github.com/owner/repo/issues/12",
      verdict: "needs-human-decision",
      triageArtifactPath: ".roark/runs/issue/12/attempts/1/triage.md",
      attemptMetadataPath: ".roark/runs/issue/12/attempts/1/attempt.json",
    });

    expect(comment).toContain("Roark stopped after triage on issue https://github.com/owner/repo/issues/12");
    expect(comment).toContain("verdict `needs-human-decision`");
    expect(comment).toContain("Triage: `.roark/runs/issue/12/attempts/1/triage.md`");
    expect(comment).toContain("Attempt: `.roark/runs/issue/12/attempts/1/attempt.json`");
  });

  test("formats deterministic attempt outcome detail", () => {
    expect(triageNoopOutcomeDetail("reject")).toBe('triage verdict is "reject"');
  });
});
