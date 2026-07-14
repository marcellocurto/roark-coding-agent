import { sanitizePublicMarkdown } from "../autorun/public-output.ts";
import { formatBoundedMarkdownDetails, postOrUpdateIssueCommentByMarker, truncateGitHubIssueComment } from "../github/comments.ts";
import { formatReviewResultMarkdown, type NormalizedReviewerFinding, type ReviewResult } from "../review/result.ts";
import type { PrReviewContext } from "./artifacts.ts";
import type { PrReviewDecision } from "./outcome.ts";

const blockingFindingSectionMaxChars = 10_000;
const nonBlockingFindingSectionMaxChars = 5_000;
const findingMaxChars = 3_000;

export function buildPrReviewMarker(prNumber: number): string {
  return `<!-- roark:pr=${prNumber} phase=pr-review -->`;
}

export function formatPrReviewComment(input: {
  context: PrReviewContext;
  headOid: string;
  decision: PrReviewDecision;
  verificationStatus: string;
  reviewA: ReviewResult;
  reviewB: ReviewResult;
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
    ...renderFindings(input.decision.requiredFixes, sanitize, blockingFindingSectionMaxChars),
    "",
    "### External blockers",
    ...renderFindings(input.decision.externalBlockers, sanitize, blockingFindingSectionMaxChars),
    "",
    "### Outcome notes",
    ...(input.decision.reasons.length > 0 ? input.decision.reasons.map((reason) => `- ${sanitize(reason)}`) : ["- None."]),
    "",
    "### Follow-ups",
    ...renderFindings(input.decision.followUps, sanitize, nonBlockingFindingSectionMaxChars),
    "",
    "### Suggestions",
    ...renderFindings(input.decision.suggestions, sanitize, nonBlockingFindingSectionMaxChars),
    "",
    formatBoundedMarkdownDetails("Correctness review details", sanitize(formatReviewResultMarkdown(input.reviewA, {
      title: "Review A: Spec and Correctness",
      source: "review-a",
    }))),
    "",
    formatBoundedMarkdownDetails("Maintainability review details", sanitize(formatReviewResultMarkdown(input.reviewB, {
      title: "Review B: Standards and Maintainability",
      source: "review-b",
    }))),
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

function renderFindings(findings: readonly NormalizedReviewerFinding[], sanitize: (value: string) => string, sectionMaxChars: number): string[] {
  if (findings.length === 0) return ["- None."];
  const maxChars = Math.min(findingMaxChars, Math.max(1, Math.floor(sectionMaxChars / findings.length)));
  return findings.map((finding) => {
    const evidence = finding.evidence.map(sanitize).join(" ");
    const handling = sanitize(finding.recommendedHandling);
    const rendered = `- **${sanitize(finding.title)}** (${sanitize(finding.severity)}, ${sanitize(finding.confidence)}) — ${evidence} Recommended handling: ${handling}`;
    return truncateFinding(rendered, maxChars);
  });
}

function truncateFinding(value: string, maxChars: number): string {
  const characters = Array.from(value);
  if (characters.length <= maxChars) return value;
  const notice = " … (finding truncated; full review retained in run artifacts)";
  const noticeCharacters = Array.from(notice);
  if (noticeCharacters.length >= maxChars) return noticeCharacters.slice(0, maxChars).join("");
  return `${characters.slice(0, maxChars - noticeCharacters.length).join("").trimEnd()}${notice}`;
}
