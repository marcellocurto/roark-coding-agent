import { sanitizePublicMarkdown } from "../autorun/public-output.ts";
import { formatBoundedMarkdownDetails, postOrUpdateIssueCommentByMarker, truncateGitHubIssueComment } from "../github/comments.ts";
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
  verificationStatus: string;
  reviewA: string;
  reviewB: string;
}): string {
  const localRoots = [input.context.controlCwd, input.context.agentCwd, input.context.outDir, input.context.reviewDir];
  const sanitize = (value: string) => sanitizePublicMarkdown(value, { localRoots });
  const lines = [
    buildPrReviewMarker(input.context.prNumber),
    "",
    "## Roark PR review summary",
    "",
    `- Outcome: **${input.decision.outcome}**`,
    `- Reviewed commit: \`${input.headOid}\``,
    `- Verification: ${sanitize(input.verificationStatus)}`,
    "",
    "### Required fixes",
    ...renderFindings(input.decision.requiredFixes, sanitize),
    "",
    "### External blockers",
    ...renderFindings(input.decision.externalBlockers, sanitize),
    "",
    "### Outcome notes",
    ...(input.decision.reasons.length > 0 ? input.decision.reasons.map((reason) => `- ${sanitize(reason)}`) : ["- None."]),
    "",
    "### Follow-ups",
    ...renderFindings(input.decision.followUps, sanitize),
    "",
    "### Suggestions",
    ...renderFindings(input.decision.suggestions, sanitize),
    "",
    formatBoundedMarkdownDetails("Correctness review details", sanitize(input.reviewA)),
    "",
    formatBoundedMarkdownDetails("Maintainability review details", sanitize(input.reviewB)),
  ];
  return truncateGitHubIssueComment(`${lines.join("\n").trimEnd()}\n`);
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

function renderFindings(findings: readonly NormalizedReviewerFinding[], sanitize: (value: string) => string): string[] {
  if (findings.length === 0) return ["- None."];
  return findings.map((finding) => {
    const evidence = sanitize(finding.evidence);
    const handling = sanitize(finding.recommendedHandling);
    return `- **${sanitize(finding.title)}** (${sanitize(finding.severity)}, ${sanitize(finding.confidence)}) — ${evidence} Recommended handling: ${handling}`;
  });
}
