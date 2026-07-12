import { sanitizePublicMarkdown, truncatePublicMarkdown } from "../autorun/public-output.ts";
import type { VerificationResult } from "../autorun/verification.ts";
import { postOrUpdateIssueCommentByMarker } from "../github/comments.ts";
import type { NormalizedReviewerFinding } from "../workflow/findings.ts";
import type { PrReviewContext } from "./artifacts.ts";
import type { PrReviewDecision } from "./outcome.ts";

export function buildPrReviewMarker(prNumber: number): string {
  return `<!-- roark:pr=${prNumber} phase=pr-review -->`;
}

export function formatPrReviewComment(input: {
  context: PrReviewContext;
  headOid: string;
  decision: PrReviewDecision;
  verification?: VerificationResult | undefined;
  verificationStatus: string;
  reviewA: string;
  reviewB: string;
}): string {
  const lines = [
    buildPrReviewMarker(input.context.prNumber),
    "## Roark PR review",
    "",
    `- Outcome: **${input.decision.outcome}**`,
    `- Reviewed commit: \`${input.headOid}\``,
    `- Verification: ${sanitizePublicMarkdown(input.verificationStatus)}`,
    "",
    "### Outcome notes",
    ...(input.decision.reasons.length > 0 ? input.decision.reasons.map((reason) => `- ${sanitizePublicMarkdown(reason)}`) : ["- None."]),
    "",
    "### Required fixes",
    ...renderFindings(input.decision.requiredFixes),
    "",
    "### External blockers",
    ...renderFindings(input.decision.externalBlockers),
    "",
    "### Follow-ups",
    ...renderFindings(input.decision.followUps),
    "",
    "### Suggestions",
    ...renderFindings(input.decision.suggestions),
    "",
    reviewerDetails("Review A — correctness", input.reviewA),
    "",
    reviewerDetails("Review B — maintainability", input.reviewB),
  ];
  return `${lines.join("\n").trimEnd()}\n`;
}

export async function publishPrReviewComment(input: Parameters<typeof formatPrReviewComment>[0]): Promise<void> {
  if (!input.context.comment) return;
  const marker = buildPrReviewMarker(input.context.prNumber);
  await postOrUpdateIssueCommentByMarker({
    cwd: input.context.controlCwd,
    repo: input.context.repo,
    issueNumber: input.context.prNumber,
    marker,
    body: formatPrReviewComment(input),
  });
}

function renderFindings(findings: readonly NormalizedReviewerFinding[]): string[] {
  if (findings.length === 0) return ["- None."];
  return findings.map((finding) => {
    const evidence = sanitizePublicMarkdown(finding.evidence);
    const handling = sanitizePublicMarkdown(finding.recommendedHandling);
    return `- **${sanitizePublicMarkdown(finding.title)}** (${sanitizePublicMarkdown(finding.severity)}, ${sanitizePublicMarkdown(finding.confidence)}) — ${evidence} Recommended handling: ${handling}`;
  });
}

function reviewerDetails(title: string, content: string): string {
  const safe = truncatePublicMarkdown(sanitizePublicMarkdown(content), 8_000);
  const fence = safe.includes("````") ? "`````" : "````";
  return `<details><summary>${title}</summary>\n\n${fence}markdown\n${safe}\n${fence}\n</details>`;
}
