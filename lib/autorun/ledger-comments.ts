import { artifactExists, artifactRelativePath, latestCompleteReviewCycle, readArtifact, reviewARef, reviewBRef, type ArtifactRef, type WorkflowContext } from "../workflow/artifacts.ts";
import { validateAgentArtifact } from "../workflow/artifact-validation.ts";
import { parseReadyForImplementationValue, parseVerdict } from "../workflow/verdicts.ts";
import { buildRoarkMarker, postOrUpdateIssueCommentByMarker } from "../github/comments.ts";
import { recordAttemptIssueComment, type AttemptMetadata } from "./attempts.ts";
import { sanitizePublicMarkdown, truncatePublicMarkdown } from "./public-output.ts";
import type { AutorunIssueCandidate } from "./selection.ts";

const reviewExcerptMaxChars = 24_000;
const artifactExcerptMaxChars = 8_000;

export type LedgerCommentPhase = string;

export interface LedgerCommentArtifactInput {
  issueNumber: number;
  attempt: number;
  artifactPath: string;
  artifactContent: string;
  attemptMetadataPath?: string | undefined;
}

export interface ReadinessLedgerCommentInput extends LedgerCommentArtifactInput {
  status?: string | undefined;
  outcome?: string | undefined;
  outcomeDetail?: string | null | undefined;
  verification?: { ok: boolean; command: string; exitCode: number } | undefined;
  prUrl?: string | undefined;
  recoveryCommand?: string | undefined;
}

export function formatAttemptStartComment(input: {
  issueNumber: number;
  attempt: number;
  branchName: string;
  assignee?: string | undefined  ;
  attemptMetadataPath?: string | undefined;
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

export async function publishPlanningLedgerComments(input: {
  cwd: string;
  repo?: string | undefined  ;
  issue: AutorunIssueCandidate;
  workflowContext: WorkflowContext;
  attemptMetadata: AttemptMetadata;
  attemptMetadataPath?: string | undefined;
}, injected: { publishIssueLedgerComment?: PublishIssueLedgerCommentFn } = {}): Promise<void> {
  const publishLedgerComment = injected.publishIssueLedgerComment ?? publishIssueLedgerComment;
  await publishArtifactLedgerComment({
    ...input,
    artifact: "triage",
    phase: "triage",
    formatBody: (artifactPath, artifactContent) => formatTriageLedgerComment({
      issueNumber: input.issue.number,
      attempt: input.attemptMetadata.attempt,
      artifactPath,
      artifactContent,
      attemptMetadataPath: input.attemptMetadataPath,
    }),
    publishLedgerComment,
  });
  await publishArtifactLedgerComment({
    ...input,
    artifact: "implementationPlan",
    phase: "implementation-plan",
    formatBody: (artifactPath, artifactContent) => formatImplementationPlanLedgerComment({
      issueNumber: input.issue.number,
      attempt: input.attemptMetadata.attempt,
      artifactPath,
      artifactContent,
      attemptMetadataPath: input.attemptMetadataPath,
    }),
    publishLedgerComment,
  });
}

export async function publishReviewLedgerComments(input: {
  cwd: string;
  repo?: string | undefined  ;
  issue: AutorunIssueCandidate;
  workflowContext: WorkflowContext;
  attemptMetadata: AttemptMetadata;
}, injected: { publishIssueLedgerComment?: PublishIssueLedgerCommentFn } = {}): Promise<void> {
  const publishLedgerComment = injected.publishIssueLedgerComment ?? publishIssueLedgerComment;
  const latestCycle = latestCompleteReviewCycle(input.workflowContext);
  await publishReviewLedgerComment({
    ...input,
    artifact: latestCycle === undefined ? "reviewA" : reviewARef(latestCycle),
    phase: latestCycle === undefined ? "review-a" : `review-a-${latestCycle}`,
    title: latestCycle === undefined ? "Review A" : `Review A pass ${latestCycle}`,
    markerPhase: "review-a",
    publishLedgerComment,
  });
  await publishReviewLedgerComment({
    ...input,
    artifact: latestCycle === undefined ? "reviewB" : reviewBRef(latestCycle),
    phase: latestCycle === undefined ? "review-b" : `review-b-${latestCycle}`,
    title: latestCycle === undefined ? "Review B" : `Review B pass ${latestCycle}`,
    markerPhase: "review-b",
    publishLedgerComment,
  });
}

export async function publishIssueLedgerComment(input: {
  cwd: string;
  repo?: string | undefined  ;
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

export function formatTriageLedgerComment(input: LedgerCommentArtifactInput): string {
  const marker = buildRoarkMarker({ issueNumber: input.issueNumber, attempt: input.attempt, phase: "triage" });
  const verdict = parseVerdict(input.artifactContent) ?? "unknown";
  const lines = [
    marker,
    `## Roark triage — attempt ${input.attempt}`,
    "",
    `Verdict: ${verdict}`,
    "",
    `Artifact: \`${input.artifactPath}\``,
  ];
  if (input.attemptMetadataPath) lines.push(`Attempt: \`${input.attemptMetadataPath}\``);
  lines.push("", formatDetails("Triage artifact excerpt", input.artifactContent));
  return `${lines.join("\n")}\n`;
}

export function formatImplementationPlanLedgerComment(input: LedgerCommentArtifactInput): string {
  const marker = buildRoarkMarker({ issueNumber: input.issueNumber, attempt: input.attempt, phase: "implementation-plan" });
  const ready = parseReadyForImplementationValue(input.artifactContent) ?? "unknown";
  const lines = [
    marker,
    `## Roark implementation plan — attempt ${input.attempt}`,
    "",
    `Ready for implementation: ${ready}`,
    "",
    `Artifact: \`${input.artifactPath}\``,
  ];
  if (input.attemptMetadataPath) lines.push(`Attempt: \`${input.attemptMetadataPath}\``);
  lines.push("", formatDetails("Implementation plan excerpt", input.artifactContent));
  return `${lines.join("\n")}\n`;
}

export function formatReadinessLedgerComment(input: ReadinessLedgerCommentInput): string {
  const marker = buildRoarkMarker({ issueNumber: input.issueNumber, attempt: input.attempt, phase: "readiness" });
  const status = input.status ?? parseVerdict(input.artifactContent) ?? "unknown";
  const lines = [
    marker,
    `## Roark readiness — attempt ${input.attempt}`,
    "",
    `Status: ${status}`,
  ];
  if (input.outcome) lines.push(`Outcome: ${input.outcome}`);
  if (input.outcomeDetail) lines.push(`Detail: ${sanitizePublicMarkdown(input.outcomeDetail)}`);
  if (input.verification) {
    lines.push(`Verification: ${input.verification.ok ? "passed" : "failed"} (\`${sanitizePublicMarkdown(input.verification.command)}\`, exit ${input.verification.exitCode})`);
  }
  if (input.prUrl) lines.push(`PR: ${input.prUrl}`);
  lines.push("", `Artifact: \`${input.artifactPath}\``);
  if (input.attemptMetadataPath) lines.push(`Attempt: \`${input.attemptMetadataPath}\``);
  if (input.recoveryCommand) {
    lines.push("", "Recovery:", formatFencedBlock(sanitizePublicMarkdown(input.recoveryCommand), "bash"));
  }
  lines.push("", formatDetails("Readiness artifact excerpt", input.artifactContent));
  return `${lines.join("\n")}\n`;
}

export function formatReviewLedgerComment(input: {
  issueNumber: number;
  attempt: number;
  phase: string;
  markerPhase?: "review-a" | "review-b" | undefined;
  title: string;
  artifactPath: string;
  artifactContent: string;
}): string {
  const marker = buildRoarkMarker({ issueNumber: input.issueNumber, attempt: input.attempt, phase: input.markerPhase ?? input.phase });
  const verdict = parseVerdict(input.artifactContent) ?? "unknown";
  const excerpt = truncatePublicMarkdown(sanitizePublicMarkdown(input.artifactContent), reviewExcerptMaxChars);
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
  attemptMetadataPath?: string | undefined;
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

async function publishArtifactLedgerComment(input: {
  cwd: string;
  repo?: string | undefined  ;
  issue: AutorunIssueCandidate;
  workflowContext: WorkflowContext;
  attemptMetadata: AttemptMetadata;
  artifact: ArtifactRef;
  phase: string;
  attemptMetadataPath?: string | undefined;
  formatBody: (artifactPath: string, artifactContent: string) => string;
  publishLedgerComment: PublishIssueLedgerCommentFn;
}): Promise<void> {
  if (!artifactExists(input.workflowContext, input.artifact)) return;
  const artifactContent = await readArtifact(input.workflowContext, input.artifact);
  const validation = validateAgentArtifact(input.artifact, artifactContent);
  if (!validation.ok) return;
  await input.publishLedgerComment({
    cwd: input.cwd,
    repo: input.repo,
    issueNumber: input.issue.number,
    attemptMetadata: input.attemptMetadata,
    phase: input.phase,
    body: input.formatBody(artifactRelativePath(input.workflowContext, input.artifact), artifactContent),
  });
}

async function publishReviewLedgerComment(input: {
  cwd: string;
  repo?: string | undefined  ;
  issue: AutorunIssueCandidate;
  workflowContext: WorkflowContext;
  attemptMetadata: AttemptMetadata;
  artifact: ArtifactRef;
  phase: string;
  markerPhase?: "review-a" | "review-b" | undefined;
  title: string;
  publishLedgerComment: PublishIssueLedgerCommentFn;
}): Promise<void> {
  if (!artifactExists(input.workflowContext, input.artifact)) return;
  const artifactContent = await readArtifact(input.workflowContext, input.artifact);
  const body = formatReviewLedgerComment({
    issueNumber: input.issue.number,
    attempt: input.attemptMetadata.attempt,
    phase: input.phase,
    markerPhase: input.markerPhase,
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

function formatDetails(summary: string, content: string): string {
  const excerpt = truncatePublicMarkdown(sanitizePublicMarkdown(content), artifactExcerptMaxChars);
  return [
    `<details><summary>${summary}</summary>`,
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

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
