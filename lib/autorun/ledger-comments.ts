import { artifactExists, artifactRelativePath, latestCompleteReviewCycle, readArtifact, reviewARef, reviewBRef, type ArtifactRef, type WorkflowContext } from "../workflow/artifacts.ts";
import { validateAgentArtifact } from "../workflow/artifact-validation.ts";
import { buildRoarkMarker, formatArtifactDetails, formatBoundedMarkdownDetails, postOrUpdateIssueCommentByMarker } from "../github/comments.ts";
import { recordAttemptIssueComment, type AttemptMetadata } from "./attempts.ts";
import { sanitizePublicMarkdown } from "./public-output.ts";
import type { AutorunIssueCandidate } from "./selection.ts";
import { formatReviewResultMarkdown, parseReviewResultJson, type ReviewFindingSource } from "../review/result.ts";

export type LedgerCommentPhase = string;

export interface LedgerCommentArtifactInput {
  issueNumber: number;
  attempt: number;
  artifactPath: string;
  artifactContent: string;
  attemptMetadataPath?: string | undefined;
}

export interface ReadinessLedgerCommentInput extends LedgerCommentArtifactInput {
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
  if (input.attemptMetadataPath) lines.push("", formatArtifactDetails([`Attempt: \`${input.attemptMetadataPath}\``]));
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
  if (latestCycle === undefined) return;
  await publishReviewLedgerComment({
    ...input,
    artifact: reviewARef(latestCycle),
    phase: `review-a-${latestCycle}`,
    title: `Review A pass ${latestCycle}`,
    markerPhase: "review-a",
    publishLedgerComment,
  });
  await publishReviewLedgerComment({
    ...input,
    artifact: reviewBRef(latestCycle),
    phase: `review-b-${latestCycle}`,
    title: `Review B pass ${latestCycle}`,
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
  const lines = [
    marker,
    "",
    sanitizePublicMarkdown(input.artifactContent).trimEnd(),
    "",
    formatArtifactDetails([
      `Triage artifact: \`${input.artifactPath}\``,
      ...(input.attemptMetadataPath ? [`Attempt: \`${input.attemptMetadataPath}\``] : []),
    ]),
  ];
  return `${lines.join("\n")}\n`;
}

export function formatImplementationPlanLedgerComment(input: LedgerCommentArtifactInput): string {
  const marker = buildRoarkMarker({ issueNumber: input.issueNumber, attempt: input.attempt, phase: "implementation-plan" });
  const content = sanitizePublicMarkdown(input.artifactContent);
  const lines = [
    marker,
    "",
    content.trimEnd(),
    "",
    formatArtifactDetails([
      `Implementation plan: \`${input.artifactPath}\``,
      ...(input.attemptMetadataPath ? [`Attempt: \`${input.attemptMetadataPath}\``] : []),
    ]),
  ];
  return `${lines.join("\n")}\n`;
}

export function formatReadinessLedgerComment(input: ReadinessLedgerCommentInput): string {
  const marker = buildRoarkMarker({ issueNumber: input.issueNumber, attempt: input.attempt, phase: "readiness" });
  const lines = [marker];
  const outcome: string[] = [];
  if (input.outcome) outcome.push(`Outcome: ${input.outcome}`);
  if (input.outcomeDetail) outcome.push(`Detail: ${sanitizePublicMarkdown(input.outcomeDetail)}`);
  if (input.verification) {
    outcome.push(`Verification: ${input.verification.ok ? "passed" : "failed"} (\`${sanitizePublicMarkdown(input.verification.command)}\`, exit ${input.verification.exitCode})`);
  }
  if (input.prUrl) outcome.push(`PR: ${input.prUrl}`);
  if (outcome.length > 0) lines.push("", "## Run outcome", "", ...outcome);
  if (input.recoveryCommand) {
    lines.push("", "## Recovery", "", formatFencedBlock(sanitizePublicMarkdown(input.recoveryCommand), "bash"));
  }
  lines.push("", formatArtifactDetails([
    `Readiness artifact: \`${input.artifactPath}\``,
    ...(input.attemptMetadataPath ? [`Attempt: \`${input.attemptMetadataPath}\``] : []),
  ]));
  const readiness = sanitizePublicMarkdown(input.artifactContent).trimEnd();
  if (readiness) lines.push("", formatBoundedMarkdownDetails("Readiness details", readiness));
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
  const source: ReviewFindingSource = (input.markerPhase ?? input.phase).startsWith("review-a") ? "review-a" : "review-b";
  const review = parseReviewResultJson(input.artifactContent, { allowRestart: true });
  const content = sanitizePublicMarkdown(formatReviewResultMarkdown(review, { title: input.title, source }));
  return [
    marker,
    "",
    content.trimEnd(),
    "",
    formatArtifactDetails([`${input.title}: \`${input.artifactPath}\``]),
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
  if (input.attemptMetadataPath) lines.push("", formatArtifactDetails([`Attempt: \`${input.attemptMetadataPath}\``]));
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
  const validation = validateAgentArtifact(input.artifact, artifactContent);
  if (!validation.ok) return;
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
