import {
  findingsByClassification,
  normalizeReviewFindings,
  reviewDisposition,
  type NormalizedReviewerFinding,
  type ReviewResult,
} from "../review/result.ts";

export interface ReadinessDecisionInput {
  triage: string;
  plan: string;
  reviewA?: ReviewResult | undefined;
  reviewB?: ReviewResult | undefined;
}

export interface ReadinessDecision {
  status: "ready-for-pr" | "not-ready";
  triageVerdict: string;
  reviewAVerdict: string;
  reviewBVerdict: string;
  planReady: boolean;
  fixesWereNeeded: boolean;
  restartRequired: boolean;
  blockedByReview: boolean;
  currentIssueBlockingFindings: NormalizedReviewerFinding[];
  externalBlockers: NormalizedReviewerFinding[];
  followUpFindings: NormalizedReviewerFinding[];
  suggestions: NormalizedReviewerFinding[];
}

export function parseVerdict(markdown: string): string | undefined {
  const sectionMatch = /##\s*(?:Verdict|Status)\s*\n+([^\n]+)/i.exec(markdown);
  const candidate = sectionMatch?.[1] ?? (/(?:Verdict|Status):\s*([^\n]+)/i.exec(markdown))?.[1];
  if (!candidate) return undefined;

  const normalized = candidate
    .toLowerCase()
    .replace(/^[\s*\-:]+/, "")
    .replace(/[`*_]/g, "")
    .trim();

  const known = [
    "proceed",
    "blocked",
    "reject",
    "needs-human-decision",
    "approve",
    "fixes-required",
    "ready-for-pr",
    "restart-required",
    "not-ready",
  ];

  return known.find((verdict) => normalized.startsWith(verdict));
}

export function parseReadyForImplementationValue(markdown: string): "yes" | "no" | undefined {
  const match = /##\s*Ready For Implementation\s*\n+([^\n]+)/i.exec(markdown);
  const answer = match?.[1]?.replace(/[`*_]/g, "").trim().toLowerCase();
  if (!answer) return undefined;
  if (answer.startsWith("yes")) return "yes";
  if (answer.startsWith("no")) return "no";
  return undefined;
}

export function parseReadyForImplementation(markdown: string): boolean {
  return parseReadyForImplementationValue(markdown) === "yes";
}

export function shouldProceedAfterTriage(triage: string): boolean {
  return parseVerdict(triage) === "proceed";
}

export function shouldImplementPlan(plan: string): boolean {
  return parseReadyForImplementation(plan);
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
  const triageVerdict = parseVerdict(input.triage) ?? "missing";
  const reviewAVerdict = input.reviewA ? reviewDisposition(input.reviewA) : "missing";
  const reviewBVerdict = input.reviewB ? reviewDisposition(input.reviewB) : "missing";
  const planReady = input.plan ? parseReadyForImplementation(input.plan) : false;
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
