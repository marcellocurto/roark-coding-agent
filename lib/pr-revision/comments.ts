import type { VerificationResult } from "../autorun/verification.ts";
import { postIssueComment } from "../github/comments.ts";
import type { PrRevisionContext } from "./artifacts.ts";

export type RevisionSummaryInput = {
  context: PrRevisionContext;
  outcome: string;
  planStatus?: string;
  reviewVerdict?: string;
  verification?: VerificationResult;
  addressed?: string[];
  skipped?: string[];
  artifactPaths: string[];
};

export function buildPrRevisionSummaryMarker(input: { prNumber: number; revision: number }): string {
  return `<!-- roark:pr=${input.prNumber} revision=${input.revision} phase=revision-summary -->`;
}

export function formatPrRevisionSummaryComment(input: RevisionSummaryInput): string {
  const { context } = input;
  const lines: string[] = [];
  lines.push(buildPrRevisionSummaryMarker({ prNumber: context.prNumber, revision: context.revision }));
  lines.push(`## Roark PR revision ${context.revision}`);
  lines.push("");
  lines.push(`- Outcome: ${input.outcome}`);
  if (input.planStatus) lines.push(`- Plan status: ${input.planStatus}`);
  if (input.reviewVerdict) lines.push(`- Review verdict: ${input.reviewVerdict}`);
  if (input.verification) {
    lines.push(`- Verification: ${input.verification.ok ? "passed" : "failed"} (\`${input.verification.command}\`, exit ${input.verification.exitCode})`);
  }
  lines.push("");
  lines.push("### Addressed feedback");
  pushList(lines, input.addressed);
  lines.push("");
  lines.push("### Skipped feedback");
  pushList(lines, input.skipped);
  lines.push("");
  lines.push("### Artifacts");
  pushList(lines, input.artifactPaths.map((artifactPath) => `\`${artifactPath}\``));
  return `${lines.join("\n")}\n`;
}

export async function postPrRevisionSummaryComment(input: RevisionSummaryInput): Promise<void> {
  if (!input.context.comment) return;
  await postIssueComment({
    cwd: input.context.cwd,
    repo: input.context.repo,
    issueNumber: input.context.prNumber,
    body: formatPrRevisionSummaryComment(input),
  });
}

function pushList(lines: string[], items: string[] | undefined): void {
  if (!items || items.length === 0) {
    lines.push("- None.");
    return;
  }
  for (const item of items) lines.push(`- ${item}`);
}
