import {
  findingsByClassification,
  normalizeReviewFindings,
  reviewDisposition,
  type NormalizedReviewerFinding,
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
  externalBlockers: NormalizedReviewerFinding[];
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
  return reviews.some((review) => review.findings.some((finding) => finding.classification === "must-fix-current"));
}

export function hasBlockedReview(...reviews: ReviewResult[]): boolean {
  return reviews.some((review) => review.findings.some((finding) => finding.classification === "external-blocker"));
}

export function needsRestart(...reviews: ReviewResult[]): boolean {
  return reviews.some((review) => review.restartRationale !== undefined);
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
  const currentIssueBlockingFindings = findingsByClassification(allFindings, "must-fix-current");
  const externalBlockers = findingsByClassification(allFindings, "external-blocker");
  const followUpFindings = findingsByClassification(allFindings, "follow-up");
  const suggestions = findingsByClassification(allFindings, "suggestion");
  const restartRequired = [input.reviewA, input.reviewB].some((review) => review?.restartRationale !== undefined);
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
