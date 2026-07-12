import { describe, expect, test } from "bun:test";
import { getWorkflowThinkingConfig } from "../workflow/thinking.ts";
import type { NormalizedReviewerFinding } from "../workflow/findings.ts";
import type { PrReviewContext } from "./artifacts.ts";
import { buildPrReviewMarker, formatPrReviewComment } from "./comments.ts";

describe("PR review public comment", () => {
  test("keeps one stable marker, orders blocking work first, and sanitizes public evidence", () => {
    const context = reviewContext();
    const required = finding("must-fix-current", "Required", "/Users/person/project/lib/a.ts TOKEN=secret");
    const suggestion = finding("suggestion", "Optional", "lib/b.ts:2");
    const body = formatPrReviewComment({
      context,
      headOid: "abc123",
      decision: { outcome: "changes-requested", requiredFixes: [required], externalBlockers: [], followUps: [], suggestions: [suggestion], rejectedFindings: [], reasons: [] },
      verificationStatus: "passed",
      reviewA: "review A at /tmp/private/file",
      reviewB: "review B",
    });

    expect(buildPrReviewMarker(12)).toBe(buildPrReviewMarker(context.prNumber));
    expect(body.indexOf("Required")).toBeLessThan(body.indexOf("Optional"));
    expect(body).not.toContain("/Users/person");
    expect(body).not.toContain("TOKEN=secret");
    expect(body).toContain("[local path redacted]");
  });
});

function reviewContext(): PrReviewContext {
  return {
    controlCwd: "/repo",
    agentCwd: "/workspace",
    outDir: "/repo/.roark/runs",
    repo: "owner/repo",
    prNumber: 12,
    generation: 2,
    reviewDir: "/repo/.roark/runs/pr/12/review-2",
    reviewDirRelative: ".roark/runs/pr/12/review-2",
    agentReviewDir: "/workspace/.roark/runs/pr/12/review-2",
    agentReviewDirRelative: ".roark/runs/pr/12/review-2",
    thinkingConfig: getWorkflowThinkingConfig(),
    comment: true,
    verificationSource: "not-configured",
  };
}

function finding(classification: NormalizedReviewerFinding["classification"], title: string, evidence: string): NormalizedReviewerFinding {
  return {
    source: "review-a",
    sourceLocalId: title,
    workflowId: `review-a:${title}`,
    title,
    classification,
    severity: "medium",
    confidence: "high",
    evidence,
    currentIssueImpact: "impact",
    recommendedHandling: "fix it",
    warnings: [],
    rawExcerpt: "",
  };
}
