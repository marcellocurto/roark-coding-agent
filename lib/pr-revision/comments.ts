import path from "node:path";
import { readFile } from "node:fs/promises";
import type { VerificationResult } from "../autorun/verification.ts";
import { postOrUpdateIssueCommentByMarker } from "../github/comments.ts";
import { formatArtifactDetails, sanitizePublicMarkdown } from "../autorun/public-output.ts";
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
  artifactExcerpts?: { content: string }[] | undefined;
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
  const excerpts = input.artifactExcerpts ?? [];
  if (excerpts.length > 0) {
    lines.push("");
    for (const [index, excerpt] of excerpts.entries()) {
      if (index > 0) lines.push("---", "");
      lines.push(sanitizePublicMarkdown(excerpt.content).trimEnd(), "");
    }
  }
  if (input.artifactPaths.length > 0) {
    lines.push(formatArtifactDetails(input.artifactPaths.map((artifactPath) => `- \`${artifactPath}\``)));
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

export async function readRevisionExcerpts(context: PrRevisionContext, artifactPaths: string[]): Promise<{ content: string }[]> {
  const excerpts: { content: string }[] = [];
  for (const filename of selectRevisionExcerptFilenames(artifactPaths)) {
    try {
      excerpts.push({ content: await readFile(path.join(context.revisionDir, filename), "utf8") });
    } catch {
      // Missing excerpts should not block the GitHub comment.
    }
  }
  return excerpts;
}

export function selectRevisionExcerptFilenames(artifactPaths: string[]): string[] {
  const filenames = [...new Set(artifactPaths.map((artifactPath) => path.basename(artifactPath)))];
  const selected: string[] = [];
  for (const filename of ["pr-feedback.md", "revision-plan.md"]) {
    if (filenames.includes(filename)) selected.push(filename);
  }
  const latestLog = latestPassArtifactFilename(filenames, "revision-log.md", /^revision-log-fix-pass-(\d+)\.md$/);
  if (latestLog) selected.push(latestLog);
  const latestReview = latestPassArtifactFilename(filenames, "revision-review.md", /^revision-review-pass-(\d+)\.md$/);
  if (latestReview) selected.push(latestReview);
  return selected;
}

function latestPassArtifactFilename(filenames: string[], baseFilename: string, passPattern: RegExp): string | undefined {
  let latestPass: { pass: number; filename: string } | undefined;
  for (const filename of filenames) {
    const match = passPattern.exec(filename);
    if (!match?.[1]) continue;
    const pass = Number(match[1]);
    if (!Number.isInteger(pass)) continue;
    if (!latestPass || pass > latestPass.pass) latestPass = { pass, filename };
  }
  return latestPass?.filename ?? (filenames.includes(baseFilename) ? baseFilename : undefined);
}

function pushList(lines: string[], items: string[] | undefined): void {
  if (!items || items.length === 0) {
    lines.push("- None.");
    return;
  }
  for (const item of items) lines.push(`- ${sanitizePublicMarkdown(item)}`);
}
