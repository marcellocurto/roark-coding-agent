import { runProcessOrThrow } from "../cli/process.ts";
import { postOrUpdateIssueCommentByMarker, type GitHubCommentRef } from "../github/comments.ts";
import { redactLocalPaths } from "./public-output.ts";

export const defaultAutorunFailureLabel = "roark-failed";

const failureArtifactExcerptMaxChars = 6_000;

export interface FailureCommentInput {
  issueNumber: number;
  issueUrl?: string | undefined  ;
  phase: string;
  reason: string;
  branchName?: string | undefined;
  worktreePath?: string | undefined;
  workspacePath?: string | undefined  ;
  artifactPath?: string | undefined;
  artifactContent?: string | undefined;
  attemptMetadataPath?: string | undefined;
  recoveryCommand?: string | undefined  ;
}

export interface MarkIssueFailedOptions {
  cwd: string;
  repo?: string | undefined  ;
  issueNumber: number;
  label: string;
  comment: string;
  removeLabels?: string[] | undefined;
  marker?: string | undefined;
  existingCommentId?: number | undefined  ;
}

export interface FailureLabelArgvOptions {
  repo?: string | undefined  ;
  issueNumber: number;
  label: string;
}

export interface FailureCommentArgvOptions {
  repo?: string | undefined  ;
  issueNumber: number;
  comment: string;
}

export function formatFailureComment(input: FailureCommentInput): string {
  const issueDisplay = input.issueUrl ?? `#${input.issueNumber}`;
  const lead = `Roark stopped on issue ${issueDisplay} at phase **${input.phase}**: ${redactLocalPaths(input.reason)}.`;
  const lines: string[] = [];

  lines.push(`Issue: #${input.issueNumber}`);
  if (input.branchName) lines.push(`Branch: \`${input.branchName}\``);
  if (input.artifactPath) lines.push(`Artifact: \`${input.artifactPath}\``);
  if (input.attemptMetadataPath) lines.push(`Attempt: \`${input.attemptMetadataPath}\``);

  if (input.artifactContent !== undefined) {
    if (lines.length > 0) lines.push("");
    lines.push("## Artifact contents");
    if (input.artifactPath) lines.push(`\`${input.artifactPath}\``);
    lines.push(formatFencedBlock(redactLocalPaths(truncateArtifactContent(input.artifactContent)), "markdown"));
  }

  if (input.recoveryCommand) {
    if (lines.length > 0) lines.push("");
    lines.push("## Recovery");
    lines.push("From the same checkout, run:");
    lines.push(formatFencedBlock(formatPublicRecoveryCommand(input.recoveryCommand), "bash"));
  }

  if (lines.length === 0) return `${lead}\n`;
  return `${lead}\n\n${lines.join("\n")}\n`;
}

export function buildFailureLabelArgv(options: FailureLabelArgvOptions): string[] {
  const repoArgs = options.repo ? ["--repo", options.repo] : [];
  return ["gh", "issue", "edit", String(options.issueNumber), "--add-label", options.label, ...repoArgs];
}

export function buildRemoveLabelArgv(options: FailureLabelArgvOptions): string[] {
  const repoArgs = options.repo ? ["--repo", options.repo] : [];
  return ["gh", "issue", "edit", String(options.issueNumber), "--remove-label", options.label, ...repoArgs];
}

export function buildFailureCommentArgv(options: FailureCommentArgvOptions): string[] {
  const repoArgs = options.repo ? ["--repo", options.repo] : [];
  return ["gh", "issue", "comment", String(options.issueNumber), "--body", options.comment, ...repoArgs];
}

export async function markIssueFailed(options: MarkIssueFailedOptions): Promise<GitHubCommentRef | undefined> {
  const labelArgv = buildFailureLabelArgv({
    repo: options.repo,
    issueNumber: options.issueNumber,
    label: options.label,
  });
  const commentArgv = buildFailureCommentArgv({
    repo: options.repo,
    issueNumber: options.issueNumber,
    comment: options.comment,
  });

  try {
    await runProcessOrThrow(labelArgv, { cwd: options.cwd, label: "gh issue edit --add-label (failure)" });
  } catch (error) {
    console.warn(`Failed to apply failure label '${options.label}': ${formatError(error)}`);
  }

  for (const label of uniqueLabels(options.removeLabels ?? []).filter((label) => label !== options.label)) {
    try {
      await runProcessOrThrow(
        buildRemoveLabelArgv({ repo: options.repo, issueNumber: options.issueNumber, label }),
        { cwd: options.cwd, label: "gh issue edit --remove-label (failure cleanup)" },
      );
    } catch (error) {
      console.warn(`Failed to remove label '${label}': ${formatError(error)}`);
    }
  }

  try {
    if (options.marker) {
      return await postOrUpdateIssueCommentByMarker({
        cwd: options.cwd,
        repo: options.repo,
        issueNumber: options.issueNumber,
        marker: options.marker,
        body: options.comment,
        existingCommentId: options.existingCommentId,
      });
    }
    await runProcessOrThrow(commentArgv, { cwd: options.cwd, label: "gh issue comment (failure)" });
  } catch (error) {
    console.warn(`Failed to post failure comment: ${formatError(error)}`);
  }
  return undefined;
}

function formatPublicRecoveryCommand(value: string): string {
  return redactLocalPaths(value.replace(/\s+--cwd\s+(?:'[^']*'|"[^"]*"|\S+)/g, ""));
}

function truncateArtifactContent(value: string): string {
  if (value.length <= failureArtifactExcerptMaxChars) return value;
  return `${value.slice(0, failureArtifactExcerptMaxChars)}\n\n... (truncated ${value.length - failureArtifactExcerptMaxChars} later characters) ...`;
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

function uniqueLabels(labels: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const label of labels) {
    const trimmed = label.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
