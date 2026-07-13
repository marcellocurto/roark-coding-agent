import { describe, expect, test } from "bun:test";
import { validateReviewOutput } from "../review/contract.ts";
import { decidePrReview } from "./outcome.ts";

describe("decidePrReview", () => {
  test("separates required failures, external blockers, and non-blocking findings", () => {
    const approve = validateReviewOutput(review("approve", "suggestion"), "review-a");
    const required = validateReviewOutput(review("fixes-required", "must-fix-current"), "review-b");
    expect(decidePrReview({ reviewA: approve, reviewB: required }).outcome).toBe("changes-requested");

    const blocked = validateReviewOutput(review("blocked", "external-blocker"), "review-b");
    expect(decidePrReview({ reviewA: approve, reviewB: blocked }).outcome).toBe("blocked");

    const followUp = validateReviewOutput(review("approve", "follow-up"), "review-b");
    expect(decidePrReview({ reviewA: approve, reviewB: followUp }).outcome).toBe("no-blocking-findings");
  });

  test("treats a genuine failing check as changes requested and unavailable verification as blocked", () => {
    const cleanA = validateReviewOutput(cleanReview(), "review-a");
    const cleanB = validateReviewOutput(cleanReview(), "review-b");
    expect(decidePrReview({
      reviewA: cleanA,
      reviewB: cleanB,
      verification: { ok: false, command: "bun test", exitCode: 1, stdout: "failure", stderr: "" },
    }).outcome).toBe("changes-requested");
    expect(decidePrReview({ reviewA: cleanA, reviewB: cleanB, verificationUnavailable: "command not found" }).outcome).toBe("blocked");
  });

  test("preserves a usable verdict when finding normalization is incomplete", () => {
    const reviewA = validateReviewOutput("# Review\n\n## Verdict\nfixes-required\n\n## Findings Ledger\nA required fix described in prose.\n", "review-a");
    const reviewB = validateReviewOutput(cleanReview(), "review-b");
    const decision = decidePrReview({ reviewA, reviewB });

    expect(decision.outcome).toBe("changes-requested");
    expect(decision.reasons).toEqual([]);
  });

  test("prefers complete ledger classifications over conflicting broad verdicts", () => {
    const followUpOnly = validateReviewOutput(review("fixes-required", "follow-up"), "review-a");
    const suggestionOnly = validateReviewOutput(review("blocked", "suggestion"), "review-b");

    const decision = decidePrReview({ reviewA: followUpOnly, reviewB: suggestionOnly });

    expect(decision.outcome).toBe("no-blocking-findings");
    expect(decision.requiredFixes).toEqual([]);
    expect(decision.externalBlockers).toEqual([]);
  });

  test("uses the broad verdict when the findings ledger is missing", () => {
    const missingLedger = validateReviewOutput("# Review\n\n## Verdict\nfixes-required\n\n## Required Fixes\n- Fix the bug.\n", "review-a");
    const decision = decidePrReview({ reviewA: missingLedger, reviewB: validateReviewOutput(cleanReview(), "review-b") });

    expect(decision.outcome).toBe("changes-requested");
  });
});

function cleanReview(): string {
  return "# Review\n\n## Verdict\napprove\n\n## Findings Ledger\nNone\n";
}

function review(verdict: string, classification: string): string {
  return `# Review\n\n## Verdict\n${verdict}\n\n## Findings Ledger\n- Identifier: F1\n- Classification: ${classification}\n- Title: Finding\n- Severity: medium\n- Confidence: high\n- Evidence: lib/a.ts demonstrates it\n- Current-issue impact: impact\n- Recommended handling: handle it\n`;
}
