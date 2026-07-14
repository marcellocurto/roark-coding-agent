import type { AgentRunRequest } from "../workflow/agent-runner.ts";
import type { FindingClassification, ReviewFinding, ReviewResult } from "../review/result.ts";

export function reviewFinding(
  classification: FindingClassification,
  title = "Finding",
  overrides: Partial<ReviewFinding> = {},
): ReviewFinding {
  return {
    classification,
    title,
    severity: "medium",
    confidence: "high",
    evidence: ["lib/example.ts:1 demonstrates the behavior."],
    currentIssueImpact: "The current issue is not complete.",
    recommendedHandling: "Fix the behavior at the cited seam.",
    ...overrides,
  };
}

export function reviewResult(
  findings: ReviewFinding[] = [],
  overrides: Partial<ReviewResult> = {},
): ReviewResult {
  return {
    summary: findings.length === 0 ? "No findings." : "The review found actionable concerns.",
    evidenceReviewed: ["Pinned diff and relevant tests."],
    findings,
    ...overrides,
  };
}

export async function submitReview(request: AgentRunRequest, result: ReviewResult): Promise<string> {
  const tool = request.customTools?.find((candidate) => candidate.name === "submit_review");
  if (!tool) throw new Error("Review request did not expose submit_review.");
  await tool.execute("test-submit-review", result, undefined, undefined, {} as never);
  return "";
}
