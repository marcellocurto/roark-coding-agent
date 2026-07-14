import type { VerificationResult } from "../autorun/verification.ts";
import {
  findingsByClassification,
  normalizeReviewPair,
  normalizeReviewPairBlockers,
  type NormalizedReviewBlocker,
  type NormalizedReviewerFinding,
  type ReviewResult,
} from "../review/result.ts";

export type PrReviewOutcome = "no-blocking-findings" | "changes-requested" | "blocked";

export interface PrReviewDecision {
  outcome: PrReviewOutcome;
  requiredFixes: NormalizedReviewerFinding[];
  externalBlockers: NormalizedReviewBlocker[];
  followUps: NormalizedReviewerFinding[];
  suggestions: NormalizedReviewerFinding[];
  reasons: string[];
}

export function decidePrReview(input: {
  reviewA: ReviewResult;
  reviewB: ReviewResult;
  verification?: VerificationResult | undefined;
  verificationUnavailable?: string | undefined;
}): PrReviewDecision {
  const all = normalizeReviewPair(input);
  const blockers = normalizeReviewPairBlockers(input);
  const requiredFixes = findingsByClassification(all, "must-fix-current");
  const externalBlockers = findingsByClassification(blockers, "external-blocker");
  const followUps = findingsByClassification(all, "follow-up");
  const suggestions = findingsByClassification(all, "suggestion");
  const reasons: string[] = [];

  if (externalBlockers.length > 0) reasons.push("At least one reviewer reported an external blocker.");
  if (input.verificationUnavailable) reasons.push(input.verificationUnavailable);
  if (externalBlockers.length > 0 || input.verificationUnavailable) {
    return { outcome: "blocked", requiredFixes, externalBlockers, followUps, suggestions, reasons };
  }

  if (requiredFixes.length > 0 || input.verification?.ok === false) {
    if (input.verification?.ok === false) reasons.push(`Verification failed with exit code ${input.verification.exitCode}.`);
    return { outcome: "changes-requested", requiredFixes, externalBlockers, followUps, suggestions, reasons };
  }
  return { outcome: "no-blocking-findings", requiredFixes, externalBlockers, followUps, suggestions, reasons };
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
