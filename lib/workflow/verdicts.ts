import {
  findingsByClassification,
  isUnblockedCurrentFix,
  normalizeReviewBlockers,
  normalizeReviewFindings,
  reviewDisposition,
  reviewHasBlockingConstraint,
  type NormalizedReviewerFinding,
  type NormalizedReviewBlocker,
  type ReviewDisposition,
  type ReviewResult,
} from "../review/result.ts";
import type { TriageResult, TriageVerdict } from "../triage/result.ts";
import type { ImplementationPlanResult } from "../implementation-plan/result.ts";

export interface ReadinessDecisionInput {
  triage?: TriageResult | undefined;
  plan?: ImplementationPlanResult | undefined;
  reviewA?: ReviewResult | undefined;
  reviewB?: ReviewResult | undefined;
}

export interface ReadinessDecision {
  status: "ready-for-pr" | "not-ready";
  triageVerdict: TriageVerdict | "missing";
  reviewAVerdict: ReviewDisposition | "missing";
  reviewBVerdict: ReviewDisposition | "missing";
  planReady: boolean;
  fixesWereNeeded: boolean;
  restartRequired: boolean;
  blockedByReview: boolean;
  currentIssueBlockingFindings: NormalizedReviewerFinding[];
  externalBlockers: NormalizedReviewBlocker[];
  followUpFindings: NormalizedReviewerFinding[];
  suggestions: NormalizedReviewerFinding[];
}

export function shouldProceedAfterTriage(triage: TriageResult): boolean {
  return triage.verdict === "proceed";
}

export function shouldImplementPlan(plan: ImplementationPlanResult): boolean {
  return plan.readyForImplementation;
}

export function needsFix(...reviews: ReviewResult[]): boolean {
  return reviews.some((review) => review.findings.some(isUnblockedCurrentFix));
}

export function hasBlockedReview(...reviews: ReviewResult[]): boolean {
  return reviews.some(reviewHasBlockingConstraint);
}

export function needsRestart(...reviews: ReviewResult[]): boolean {
  return reviews.some((review) => review.restartRecommendation !== undefined);
}

export function decideReadiness(input: ReadinessDecisionInput): ReadinessDecision {
  const triageVerdict = input.triage?.verdict ?? "missing";
  const reviewAVerdict = input.reviewA ? reviewDisposition(input.reviewA) : "missing";
  const reviewBVerdict = input.reviewB ? reviewDisposition(input.reviewB) : "missing";
  const planReady = input.plan?.readyForImplementation ?? false;
  const allFindings = [
    ...(input.reviewA ? normalizeReviewFindings(input.reviewA, "review-a") : []),
    ...(input.reviewB ? normalizeReviewFindings(input.reviewB, "review-b") : []),
  ];
  const allBlockers = [
    ...(input.reviewA ? normalizeReviewBlockers(input.reviewA, "review-a") : []),
    ...(input.reviewB ? normalizeReviewBlockers(input.reviewB, "review-b") : []),
  ];
  const currentIssueBlockingFindings = findingsByClassification(allFindings, "must-fix-current");
  const externalBlockers = findingsByClassification(allBlockers, "external-blocker");
  const followUpFindings = findingsByClassification(allFindings, "follow-up");
  const suggestions = findingsByClassification(allFindings, "suggestion");
  const restartRequired = [input.reviewA, input.reviewB].some((review) => review?.restartRecommendation !== undefined);
  const fixesWereNeeded = currentIssueBlockingFindings.length > 0;
  const blockedByReview = externalBlockers.length > 0;
  const readyFromLatestReviews =
    triageVerdict === "proceed" &&
    planReady &&
    reviewAVerdict === "approve" &&
    reviewBVerdict === "approve";

  return {
    status: readyFromLatestReviews ? "ready-for-pr" : "not-ready",
    triageVerdict,
    reviewAVerdict,
    reviewBVerdict,
    planReady,
    fixesWereNeeded,
    restartRequired,
    blockedByReview,
    currentIssueBlockingFindings,
    externalBlockers,
    followUpFindings,
    suggestions,
  };
}
