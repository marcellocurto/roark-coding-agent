import type { VerificationResult } from "../autorun/verification.ts";
import type { NormalizedReviewerFinding, RejectedReviewerFinding } from "../workflow/findings.ts";
import type { ValidatedReviewOutput } from "../review/contract.ts";

export type PrReviewOutcome = "no-blocking-findings" | "changes-requested" | "blocked";

export interface PrReviewDecision {
  outcome: PrReviewOutcome;
  requiredFixes: NormalizedReviewerFinding[];
  externalBlockers: NormalizedReviewerFinding[];
  followUps: NormalizedReviewerFinding[];
  suggestions: NormalizedReviewerFinding[];
  rejectedFindings: RejectedReviewerFinding[];
  reasons: string[];
}

export function decidePrReview(input: {
  reviewA: ValidatedReviewOutput;
  reviewB: ValidatedReviewOutput;
  verification?: VerificationResult | undefined;
  verificationUnavailable?: string | undefined;
}): PrReviewDecision {
  const parsed = [input.reviewA.findings, input.reviewB.findings];
  const all = parsed.flatMap((review) => review.findings);
  const rejectedFindings = parsed.flatMap((review) => review.rejected);
  const requiredFixes = all.filter((finding) => finding.classification === "must-fix-current");
  const externalBlockers = all.filter((finding) => finding.classification === "external-blocker");
  const followUps = all.filter((finding) => finding.classification === "follow-up");
  const suggestions = all.filter((finding) => finding.classification === "suggestion");
  const reasons: string[] = [];

  if (rejectedFindings.length > 0) reasons.push("One or more reviewer findings could not be parsed safely.");
  if (input.reviewA.verdict === "blocked" || input.reviewB.verdict === "blocked") reasons.push("At least one reviewer reported an external blocker.");
  if (input.verificationUnavailable) reasons.push(input.verificationUnavailable);
  if (rejectedFindings.length > 0 || externalBlockers.length > 0 || input.reviewA.verdict === "blocked" || input.reviewB.verdict === "blocked" || input.verificationUnavailable) {
    return { outcome: "blocked", requiredFixes, externalBlockers, followUps, suggestions, rejectedFindings, reasons };
  }

  if (requiredFixes.length > 0 || input.reviewA.verdict === "fixes-required" || input.reviewB.verdict === "fixes-required" || input.verification?.ok === false) {
    if (input.verification?.ok === false) reasons.push(`Verification failed with exit code ${input.verification.exitCode}.`);
    return { outcome: "changes-requested", requiredFixes, externalBlockers, followUps, suggestions, rejectedFindings, reasons };
  }
  return { outcome: "no-blocking-findings", requiredFixes, externalBlockers, followUps, suggestions, rejectedFindings, reasons };
}

export function blockedPrReviewDecision(reason: string): PrReviewDecision {
  return {
    outcome: "blocked",
    requiredFixes: [],
    externalBlockers: [],
    followUps: [],
    suggestions: [],
    rejectedFindings: [],
    reasons: [reason],
  };
}
