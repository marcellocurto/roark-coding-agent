import type { VerificationResult } from "../autorun/verification.ts";
import type { NormalizedReviewerFinding } from "../workflow/findings.ts";
import type { ValidatedReviewOutput } from "../review/contract.ts";

export type PrReviewOutcome = "no-blocking-findings" | "changes-requested" | "blocked";

export interface PrReviewDecision {
  outcome: PrReviewOutcome;
  requiredFixes: NormalizedReviewerFinding[];
  externalBlockers: NormalizedReviewerFinding[];
  followUps: NormalizedReviewerFinding[];
  suggestions: NormalizedReviewerFinding[];
  reasons: string[];
}

export function decidePrReview(input: {
  reviewA: ValidatedReviewOutput;
  reviewB: ValidatedReviewOutput;
  verification?: VerificationResult | undefined;
  verificationUnavailable?: string | undefined;
}): PrReviewDecision {
  const reviews = [input.reviewA, input.reviewB];
  const parsed = reviews.map((review) => review.findings);
  const all = parsed.flatMap((review) => review.findings);
  const requiredFixes = all.filter((finding) => finding.classification === "must-fix-current");
  const externalBlockers = all.filter((finding) => finding.classification === "external-blocker");
  const followUps = all.filter((finding) => finding.classification === "follow-up");
  const suggestions = all.filter((finding) => finding.classification === "suggestion");
  const reasons: string[] = [];
  const fallbackBlocked = reviews.some((review) => shouldUseVerdictFallback(review) && review.verdict === "blocked");
  const fallbackFixesRequired = reviews.some((review) => shouldUseVerdictFallback(review) && review.verdict === "fixes-required");

  if (fallbackBlocked) reasons.push("At least one reviewer reported an external blocker.");
  if (input.verificationUnavailable) reasons.push(input.verificationUnavailable);
  if (externalBlockers.length > 0 || fallbackBlocked || input.verificationUnavailable) {
    return { outcome: "blocked", requiredFixes, externalBlockers, followUps, suggestions, reasons };
  }

  if (requiredFixes.length > 0 || fallbackFixesRequired || input.verification?.ok === false) {
    if (input.verification?.ok === false) reasons.push(`Verification failed with exit code ${input.verification.exitCode}.`);
    return { outcome: "changes-requested", requiredFixes, externalBlockers, followUps, suggestions, reasons };
  }
  return { outcome: "no-blocking-findings", requiredFixes, externalBlockers, followUps, suggestions, reasons };
}

function shouldUseVerdictFallback(review: ValidatedReviewOutput): boolean {
  return !review.findings.hasLedger || review.findings.rejected.length > 0;
}

export function blockedPrReviewDecision(reason: string): PrReviewDecision {
  return {
    outcome: "blocked",
    requiredFixes: [],
    externalBlockers: [],
    followUps: [],
    suggestions: [],
    reasons: [reason],
  };
}
