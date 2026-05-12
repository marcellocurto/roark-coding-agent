import path from "node:path";
import { readFile } from "node:fs/promises";
import type { VerificationResult } from "../autorun/verification.ts";
import { postOrUpdateIssueCommentByMarker } from "../github/comments.ts";
import { sanitizePublicMarkdown, truncatePublicMarkdown } from "../autorun/public-output.ts";
import type { PrRevisionContext } from "./artifacts.ts";

export interface RevisionSummaryInput {
  context: PrRevisionContext;
  outcome: string;
  planStatus?: string | undefined;
  reviewVerdict?: string | undefined;
  verification?: VerificationResult | undefined;
  feedbackConsidered?: string[] | undefined;
  addressed?: string[] | undefined;
  skipped?: string[] | undefined;
  changedFiles?: string[] | undefined;
  commitSha?: string | undefined;
  artifactPaths: string[];
  artifactExcerpts?: { title: string; content: string }[] | undefined;
}

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
    lines.push(`- Verification: ${input.verification.ok ? "passed" : "failed"} (\`${sanitizePublicMarkdown(input.verification.command)}\`, exit ${input.verification.exitCode})`);
  }
  if (input.commitSha) lines.push(`- Commit: ${input.commitSha}`);
  lines.push("");
  lines.push("### Feedback considered");
  pushList(lines, input.feedbackConsidered);
  lines.push("");
  lines.push("### Addressed feedback");
  pushList(lines, input.addressed);
  lines.push("");
  lines.push("### Skipped feedback");
  pushList(lines, input.skipped);
  lines.push("");
  lines.push("### Changed files");
  pushList(lines, input.changedFiles);
  lines.push("");
  lines.push("### Artifacts");
  pushList(lines, input.artifactPaths.map((artifactPath) => `\`${artifactPath}\``));
  const excerpts = input.artifactExcerpts ?? [];
  if (excerpts.length > 0) {
    lines.push("");
    for (const excerpt of excerpts) {
      lines.push(formatDetails(excerpt.title, excerpt.content), "");
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export async function postPrRevisionSummaryComment(input: RevisionSummaryInput): Promise<void> {
  if (!input.context.comment) return;
  const marker = buildPrRevisionSummaryMarker({ prNumber: input.context.prNumber, revision: input.context.revision });
  await postOrUpdateIssueCommentByMarker({
    cwd: input.context.controlCwd,
    repo: input.context.repo,
    issueNumber: input.context.prNumber,
    marker,
    body: formatPrRevisionSummaryComment({
      ...input,
      artifactExcerpts: input.artifactExcerpts ?? await readRevisionExcerpts(input.context, input.artifactPaths),
    }),
  });
}

async function readRevisionExcerpts(context: PrRevisionContext, artifactPaths: string[]): Promise<{ title: string; content: string }[]> {
  const interesting = new Set(["pr-feedback.md", "revision-plan.md", "revision-log.md", "revision-review.md"]);
  const excerpts: { title: string; content: string }[] = [];
  for (const artifactPath of artifactPaths) {
    const filename = path.basename(artifactPath);
    if (!interesting.has(filename)) continue;
    try {
      excerpts.push({ title: filename, content: await readFile(path.join(context.revisionDir, filename), "utf8") });
    } catch {
      // Missing excerpts should not block the GitHub comment.
    }
  }
  return excerpts;
}

function formatDetails(summary: string, content: string): string {
  const excerpt = truncatePublicMarkdown(sanitizePublicMarkdown(content), 8_000);
  return [
    `<details><summary>${summary} excerpt</summary>`,
    "",
    formatFencedBlock(excerpt, "markdown"),
    "</details>",
  ].join("\n");
}

function formatFencedBlock(value: string, language: string): string {
  const fence = longestBacktickRun(value) >= 4 ? "`````" : "````";
  return `${fence}${language}\n${value}\n${fence}`;
}

function longestBacktickRun(value: string): number {
  let longest = 0;
  let current = 0;
  for (const char of value) {
    if (char === "`") {
      current += 1;
      longest = Math.max(longest, current);
    } else {
      current = 0;
    }
  }
  return longest;
}

function pushList(lines: string[], items: string[] | undefined): void {
  if (!items || items.length === 0) {
    lines.push("- None.");
    return;
  }
  for (const item of items) lines.push(`- ${sanitizePublicMarkdown(item)}`);
}
