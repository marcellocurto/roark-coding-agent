import { artifactExists, artifactRelativePath, readArtifact, type WorkflowContext } from "../workflow/artifacts.ts";
import { parseVerdict } from "../workflow/verdicts.ts";
import { buildRoarkMarker, postOrUpdateIssueCommentByMarker } from "../github/comments.ts";
import { recordAttemptIssueComment, type AttemptMetadata } from "./attempts.ts";
import type { AutorunIssueCandidate } from "./selection.ts";

const reviewExcerptMaxChars = 24_000;

export type LedgerCommentPhase = "attempt-start" | "review-a" | "review-b" | "readiness" | "verification" | "triage" | "pr-created" | string;

export function formatAttemptStartComment(input: {
  issueNumber: number;
  attempt: number;
  branchName: string;
  assignee?: string;
  attemptMetadataPath?: string;
}): string {
  const marker = buildRoarkMarker({ issueNumber: input.issueNumber, attempt: input.attempt, phase: "attempt-start" });
  const actor = input.assignee ? `@${input.assignee}` : "Roark";
  const lines = [
    marker,
    `## Roark attempt ${input.attempt} started`,
    "",
    `${actor} is attempting this issue in branch \`${input.branchName}\`.`,
  ];
  if (input.attemptMetadataPath) lines.push("", `Attempt: \`${input.attemptMetadataPath}\``);
  return `${lines.join("\n")}\n`;
}

export type PublishIssueLedgerCommentFn = typeof publishIssueLedgerComment;

export async function publishReviewLedgerComments(input: {
  cwd: string;
  repo?: string;
  issue: AutorunIssueCandidate;
  workflowContext: WorkflowContext;
  attemptMetadata: AttemptMetadata;
}, injected: { publishIssueLedgerComment?: PublishIssueLedgerCommentFn } = {}): Promise<void> {
  const publishLedgerComment = injected.publishIssueLedgerComment ?? publishIssueLedgerComment;
  await publishReviewLedgerComment({ ...input, artifact: "reviewA", phase: "review-a", title: "Review A", publishLedgerComment });
  await publishReviewLedgerComment({ ...input, artifact: "reviewB", phase: "review-b", title: "Review B", publishLedgerComment });
}

export async function publishIssueLedgerComment(input: {
  cwd: string;
  repo?: string;
  issueNumber: number;
  attemptMetadata: AttemptMetadata;
  phase: LedgerCommentPhase;
  body: string;
}): Promise<void> {
  const marker = buildRoarkMarker({
    issueNumber: input.issueNumber,
    attempt: input.attemptMetadata.attempt,
    phase: input.phase,
  });
  try {
    const ref = await postOrUpdateIssueCommentByMarker({
      cwd: input.cwd,
      repo: input.repo,
      issueNumber: input.issueNumber,
      marker,
      body: input.body,
      existingCommentId: input.attemptMetadata.githubComments?.issue?.[input.phase]?.id,
    });
    recordAttemptIssueComment(input.attemptMetadata, input.phase, ref);
  } catch (error) {
    console.warn(`Failed to publish ${input.phase} issue ledger comment: ${formatError(error)}`);
  }
}

export function formatReviewLedgerComment(input: {
  issueNumber: number;
  attempt: number;
  phase: "review-a" | "review-b";
  title: string;
  artifactPath: string;
  artifactContent: string;
}): string {
  const marker = buildRoarkMarker({ issueNumber: input.issueNumber, attempt: input.attempt, phase: input.phase });
  const verdict = parseVerdict(input.artifactContent) ?? "unknown";
  const excerpt = truncateReviewContent(input.artifactContent);
  return [
    marker,
    `## Roark ${input.title} — attempt ${input.attempt}`,
    "",
    `Verdict: ${verdict}`,
    "",
    `Artifact: \`${input.artifactPath}\``,
    "",
    "## Artifact contents",
    formatFencedBlock(excerpt, "markdown"),
  ].join("\n") + "\n";
}

export function formatPrCreatedComment(input: {
  issueNumber: number;
  attempt: number;
  prUrl: string;
  attemptMetadataPath?: string;
}): string {
  const marker = buildRoarkMarker({ issueNumber: input.issueNumber, attempt: input.attempt, phase: "pr-created" });
  const lines = [
    marker,
    `## Roark PR created — attempt ${input.attempt}`,
    "",
    `PR: ${input.prUrl}`,
  ];
  if (input.attemptMetadataPath) lines.push(`Attempt: \`${input.attemptMetadataPath}\``);
  return `${lines.join("\n")}\n`;
}

async function publishReviewLedgerComment(input: {
  cwd: string;
  repo?: string;
  issue: AutorunIssueCandidate;
  workflowContext: WorkflowContext;
  attemptMetadata: AttemptMetadata;
  artifact: "reviewA" | "reviewB";
  phase: "review-a" | "review-b";
  title: string;
  publishLedgerComment: PublishIssueLedgerCommentFn;
}): Promise<void> {
  if (!artifactExists(input.workflowContext, input.artifact)) return;
  const artifactContent = await readArtifact(input.workflowContext, input.artifact);
  const body = formatReviewLedgerComment({
    issueNumber: input.issue.number,
    attempt: input.attemptMetadata.attempt,
    phase: input.phase,
    title: input.title,
    artifactPath: artifactRelativePath(input.workflowContext, input.artifact),
    artifactContent,
  });
  await input.publishLedgerComment({
    cwd: input.cwd,
    repo: input.repo,
    issueNumber: input.issue.number,
    attemptMetadata: input.attemptMetadata,
    phase: input.phase,
    body,
  });
}

function truncateReviewContent(value: string): string {
  if (value.length <= reviewExcerptMaxChars) return value;
  return `${value.slice(0, reviewExcerptMaxChars)}\n\n... (truncated ${value.length - reviewExcerptMaxChars} later characters) ...`;
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

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
