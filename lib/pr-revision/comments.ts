import type { VerificationResult } from "../autorun/verification.ts";
import { postIssueComment, truncateGitHubIssueComment } from "../github/comments.ts";
import { sanitizePublicMarkdown } from "../autorun/public-output.ts";
import type { PrRevisionContext } from "./artifacts.ts";
import type { RevisionFeedbackDisposition } from "./execution.ts";

export interface RevisionSummaryInput {
  context: PrRevisionContext;
  outcome: string;
  reviewVerdict?: string | undefined;
  verification?: VerificationResult | undefined;
  dispositions: RevisionFeedbackDisposition[];
  changedFiles?: string[] | undefined;
  commitSha?: string | undefined;
}

export function buildPrRevisionSummaryMarker(input: { prNumber: number; revision: number }): string {
  return `<!-- roark:pr=${input.prNumber} revision=${input.revision} phase=revision-summary -->`;
}

export function formatPrRevisionSummaryComment(input: RevisionSummaryInput): string {
  const { context } = input;
  const lines: string[] = [];
  lines.push(buildPrRevisionSummaryMarker({ prNumber: context.prNumber, revision: context.revision }));
  lines.push("", `## Roark PR revision ${context.revision} summary`);
  lines.push("");
  lines.push(`- Outcome: ${input.outcome}`);
  if (input.reviewVerdict) lines.push(`- Review verdict: ${input.reviewVerdict}`);
  if (input.verification) {
    lines.push(`- Verification: ${input.verification.ok ? "passed" : "failed"} (\`${sanitizePublicMarkdown(input.verification.command)}\`, exit ${input.verification.exitCode})`);
  }
  if (input.commitSha) lines.push(`- Commit: ${input.commitSha}`);
  lines.push("");
  lines.push("### Feedback disposition");
  pushDispositions(lines, input.dispositions);
  lines.push("");
  lines.push("### Changed files");
  pushList(lines, input.changedFiles);
  return truncateGitHubIssueComment(`${lines.join("\n").trimEnd()}\n`);
}

export async function postPrRevisionSummaryComment(input: RevisionSummaryInput): Promise<void> {
  if (!input.context.comment) return;
  await postIssueComment({
    cwd: input.context.controlCwd,
    repo: input.context.repo,
    issueNumber: input.context.prNumber,
    body: formatPrRevisionSummaryComment(input),
  });
}

function pushDispositions(lines: string[], dispositions: RevisionFeedbackDisposition[]): void {
  if (dispositions.length === 0) {
    lines.push("- None.");
    return;
  }
  for (const item of dispositions) {
    const sources = item.sourceIds.length === 1 && item.sourceIds[0] === item.feedbackId
      ? ""
      : ` (sources: ${item.sourceIds.map((source) => `\`${sanitizePublicMarkdown(source)}\``).join(", ")})`;
    lines.push(`- \`${sanitizePublicMarkdown(item.feedbackId)}\` **${item.status}** — ${sanitizePublicMarkdown(item.summary)}${sources}: ${sanitizePublicMarkdown(item.details)}`);
  }
}

function pushList(lines: string[], items: string[] | undefined): void {
  if (!items || items.length === 0) {
    lines.push("- None.");
    return;
  }
  for (const item of items) lines.push(`- ${sanitizePublicMarkdown(item)}`);
}
