import {
  findingsByClassification,
  parseReviewFindings,
  type NormalizedReviewerFinding,
  type ParsedReviewFindings,
  type RejectedReviewerFinding,
  type ReviewFindingSource,
} from "./findings.ts";

export type ReadinessDecisionInput = {
  triage: string;
  plan: string;
  reviewA: string;
  reviewB: string;
  finalReview: string;
};

export type ReadinessDecision = {
  status: "ready-for-pr" | "not-ready";
  triageVerdict: string;
  reviewAVerdict: string;
  reviewBVerdict: string;
  finalVerdict: string;
  planReady: boolean;
  fixesWereNeeded: boolean;
  blockedByReview: boolean;
  currentIssueBlockingFindings: NormalizedReviewerFinding[];
  externalBlockers: NormalizedReviewerFinding[];
  followUpFindings: NormalizedReviewerFinding[];
  suggestions: NormalizedReviewerFinding[];
  parserWarnings: string[];
  rejectedFindings: RejectedReviewerFinding[];
};

export function parseVerdict(markdown: string): string | undefined {
  const sectionMatch = markdown.match(/##\s*(?:Verdict|Status)\s*\n+([^\n]+)/i);
  const candidate = sectionMatch?.[1] ?? markdown.match(/(?:Verdict|Status):\s*([^\n]+)/i)?.[1];
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
    "not-ready",
  ];

  return known.find((verdict) => normalized.startsWith(verdict));
}

export function parseReadyForImplementationValue(markdown: string): "yes" | "no" | undefined {
  const match = markdown.match(/##\s*Ready For Implementation\s*\n+([^\n]+)/i);
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

export function needsFix(...reviews: string[]): boolean {
  return parseDecisionReviews(reviews).some(({ markdown, parsed }) => {
    if (!parsed.hasLedger) return parseVerdict(markdown) === "fixes-required";
    return parsed.findings.some((finding) => finding.classification === "must-fix-current");
  });
}

export function hasBlockedReview(...reviews: string[]): boolean {
  return parseDecisionReviews(reviews).some(({ markdown, parsed }) => {
    if (!parsed.hasLedger) return parseVerdict(markdown) === "blocked";
    return parsed.findings.some((finding) => finding.classification === "external-blocker");
  });
}

export function shouldRunAnotherFixPass(finalReview: string): boolean {
  return parseVerdict(finalReview) === "fixes-required";
}

export function decideReadiness(input: ReadinessDecisionInput): ReadinessDecision {
  const triageVerdict = parseVerdict(input.triage) ?? "missing";
  const reviewAVerdict = parseVerdict(input.reviewA) ?? "missing";
  const reviewBVerdict = parseVerdict(input.reviewB) ?? "missing";
  const finalVerdict = parseVerdict(input.finalReview) ?? "not-run";
  const planReady = input.plan ? parseReadyForImplementation(input.plan) : false;

  const reviewAFindings = parseReviewFindings(input.reviewA, "review-a");
  const reviewBFindings = parseReviewFindings(input.reviewB, "review-b");
  const parsedReviews = [
    { markdown: input.reviewA, parsed: reviewAFindings, verdict: reviewAVerdict },
    { markdown: input.reviewB, parsed: reviewBFindings, verdict: reviewBVerdict },
  ];

  const allFindings = parsedReviews.flatMap(({ parsed }) => parsed.findings);
  const currentIssueBlockingFindings = findingsByClassification(allFindings, "must-fix-current");
  const externalBlockers = findingsByClassification(allFindings, "external-blocker");
  const followUpFindings = findingsByClassification(allFindings, "follow-up");
  const suggestions = findingsByClassification(allFindings, "suggestion");
  const rejectedFindings = parsedReviews.flatMap(({ parsed }) => parsed.rejected);
  const parserWarnings = [
    ...parsedReviews.flatMap(({ parsed }) => parsed.warnings),
    ...parsedReviews.flatMap(({ parsed, verdict }) => verdictLedgerConflictWarnings(parsed, verdict)),
  ];

  const fallbackFixNeeded = parsedReviews.some(({ markdown, parsed }) => !parsed.hasLedger && parseVerdict(markdown) === "fixes-required");
  const fallbackBlocked = parsedReviews.some(({ markdown, parsed }) => !parsed.hasLedger && parseVerdict(markdown) === "blocked");
  const fixesWereNeeded = currentIssueBlockingFindings.length > 0 || fallbackFixNeeded;
  const blockedByReview = externalBlockers.length > 0 || fallbackBlocked;
  const hasRejectedFindings = rejectedFindings.length > 0;

  const finalReviewWasRun = input.finalReview.trim().length > 0;

  const readyWithoutFixes =
    triageVerdict === "proceed" &&
    planReady &&
    reviewsApproveCurrentIssue(parsedReviews) &&
    !fixesWereNeeded &&
    !blockedByReview &&
    !hasRejectedFindings &&
    !finalReviewWasRun;

  const readyAfterFix =
    triageVerdict === "proceed" &&
    planReady &&
    (fixesWereNeeded || finalReviewWasRun) &&
    !blockedByReview &&
    !hasRejectedFindings &&
    finalVerdict === "ready-for-pr";

  return {
    status: readyWithoutFixes || readyAfterFix ? "ready-for-pr" : "not-ready",
    triageVerdict,
    reviewAVerdict,
    reviewBVerdict,
    finalVerdict,
    planReady,
    fixesWereNeeded,
    blockedByReview,
    currentIssueBlockingFindings,
    externalBlockers,
    followUpFindings,
    suggestions,
    parserWarnings,
    rejectedFindings,
  };
}

function parseDecisionReviews(reviews: readonly string[]): { markdown: string; parsed: ParsedReviewFindings }[] {
  return reviews.map((markdown, index) => ({
    markdown,
    parsed: parseReviewFindings(markdown, sourceForReviewIndex(index)),
  }));
}

function sourceForReviewIndex(index: number): ReviewFindingSource {
  return index === 1 ? "review-b" : "review-a";
}

function reviewsApproveCurrentIssue(
  reviews: readonly { markdown: string; parsed: ParsedReviewFindings; verdict: string }[],
): boolean {
  return reviews.every(({ parsed, verdict }) => {
    if (!parsed.hasLedger) return verdict === "approve";
    return parsed.rejected.length === 0 &&
      !parsed.findings.some((finding) => finding.classification === "must-fix-current" || finding.classification === "external-blocker");
  });
}

function verdictLedgerConflictWarnings(parsed: ParsedReviewFindings, verdict: string): string[] {
  if (!parsed.hasLedger) return [];

  const hasCurrentFix = parsed.findings.some((finding) => finding.classification === "must-fix-current");
  const hasExternalBlocker = parsed.findings.some((finding) => finding.classification === "external-blocker");
  const warnings: string[] = [];

  if (verdict === "fixes-required" && !hasCurrentFix) {
    warnings.push(`${parsed.source}: verdict is fixes-required but parsed ledger has no must-fix-current findings; ledger classifications were preferred.`);
  }
  if (verdict !== "fixes-required" && hasCurrentFix) {
    warnings.push(`${parsed.source}: verdict is ${verdict} but parsed ledger has must-fix-current findings; ledger classifications were preferred.`);
  }
  if (verdict === "blocked" && !hasExternalBlocker) {
    warnings.push(`${parsed.source}: verdict is blocked but parsed ledger has no external-blocker findings; ledger classifications were preferred.`);
  }
  if (verdict !== "blocked" && hasExternalBlocker) {
    warnings.push(`${parsed.source}: verdict is ${verdict} but parsed ledger has external-blocker findings; ledger classifications were preferred.`);
  }

  return warnings;
}
