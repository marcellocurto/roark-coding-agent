import { describe, expect, test } from "bun:test";
import { githubIssueCommentMaxChars } from "../github/comments.ts";
import { getWorkflowThinkingConfig } from "../workflow/thinking.ts";
import type { NormalizedReviewerFinding } from "../workflow/findings.ts";
import type { PrReviewContext } from "./artifacts.ts";
import { formatPrReviewComment } from "./comments.ts";

describe("PR review public comment", () => {
  test("keeps one stable marker, orders blocking work first, and sanitizes public evidence", () => {
    const context = reviewContext();
    const required = finding("must-fix-current", "Required", "/Users/person/project/lib/a.ts TOKEN=secret");
    const suggestion = finding("suggestion", "Optional", "lib/b.ts:2");
    const body = formatPrReviewComment({
      context,
      headOid: "abc123",
      decision: { outcome: "changes-requested", requiredFixes: [required], externalBlockers: [], followUps: [], suggestions: [suggestion], reasons: [] },
      verificationStatus: "passed",
      reviewA: `review A at /mnt/agent/repo/private/file\n${"a".repeat(70_000)}`,
      reviewB: `review B\n${"b".repeat(70_000)}`,
    });

    expect(body.indexOf("Required")).toBeLessThan(body.indexOf("Optional"));
    expect(body).not.toContain("/Users/person");
    expect(body).not.toContain("/mnt/agent/repo");
    expect(body).not.toContain("TOKEN=secret");
    expect(body).toContain("[local path redacted]");
    expect(body).toContain("review A at [local path redacted]");
    expect(body).toContain("review B");
    expect(body.indexOf("## Roark PR review summary")).toBeLessThan(body.indexOf("review A at"));
    expect(body.indexOf("### Required fixes")).toBeLessThan(body.indexOf("review A at"));
    expect(body).toContain("details truncated");
    expect(Array.from(body).length).toBeLessThanOrEqual(githubIssueCommentMaxChars);
  });
});

function reviewContext(): PrReviewContext {
  return {
    controlCwd: "/repo",
    agentCwd: "/mnt/agent/repo",
    outDir: "/repo/.roark/runs",
    repo: "owner/repo",
    prNumber: 12,
    generation: 2,
    reviewDir: "/repo/.roark/runs/pr/12/review-2",
    reviewDirRelative: ".roark/runs/pr/12/review-2",
    agentReviewDir: "/mnt/agent/repo/.git/roark/pr-review/12/review-2",
    agentReviewDirRelative: ".git/roark/pr-review/12/review-2",
    thinkingConfig: getWorkflowThinkingConfig(),
    comment: true,
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
