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

export function parseReadyForImplementation(markdown: string): boolean {
  const match = markdown.match(/##\s*Ready For Implementation\s*\n+([^\n]+)/i);
  const answer = match?.[1];
  if (!answer) return true;
  return answer.toLowerCase().trim().startsWith("yes");
}

export function shouldProceedAfterTriage(triage: string): boolean {
  return parseVerdict(triage) === "proceed";
}

export function shouldImplementPlan(plan: string): boolean {
  return parseReadyForImplementation(plan);
}

export function needsFix(...reviews: string[]): boolean {
  return reviews.some((review) => parseVerdict(review) === "fixes-required");
}

export function hasBlockedReview(...reviews: string[]): boolean {
  return reviews.some((review) => parseVerdict(review) === "blocked");
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
  const fixesWereNeeded = needsFix(input.reviewA, input.reviewB);

  const readyWithoutFixes =
    triageVerdict === "proceed" &&
    planReady &&
    reviewAVerdict === "approve" &&
    reviewBVerdict === "approve" &&
    !fixesWereNeeded;

  const readyAfterFix =
    triageVerdict === "proceed" &&
    planReady &&
    fixesWereNeeded &&
    finalVerdict === "ready-for-pr";

  return {
    status: readyWithoutFixes || readyAfterFix ? "ready-for-pr" : "not-ready",
    triageVerdict,
    reviewAVerdict,
    reviewBVerdict,
    finalVerdict,
    planReady,
    fixesWereNeeded,
  };
}
