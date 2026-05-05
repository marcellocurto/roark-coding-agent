import { runProcessOrThrow } from "../cli/process.ts";

export const defaultAutorunFailureLabel = "roark-failed";

export type FailureCommentInput = {
  issueNumber: number;
  phase: string;
  reason: string;
  artifactPath?: string;
  attemptMetadataPath?: string;
};

export type MarkIssueFailedOptions = {
  cwd: string;
  repo?: string;
  issueNumber: number;
  label: string;
  comment: string;
};

export type FailureLabelArgvOptions = {
  repo?: string;
  issueNumber: number;
  label: string;
};

export type FailureCommentArgvOptions = {
  repo?: string;
  issueNumber: number;
  comment: string;
};

export function formatFailureComment(input: FailureCommentInput): string {
  const lead = `Roark stopped on issue #${input.issueNumber} at phase **${input.phase}**: ${input.reason}.`;
  const lines: string[] = [];
  if (input.artifactPath) lines.push(`Artifact: \`${input.artifactPath}\``);
  if (input.attemptMetadataPath) lines.push(`Attempt: \`${input.attemptMetadataPath}\``);
  if (lines.length === 0) return `${lead}\n`;
  return `${lead}\n\n${lines.join("\n")}\n`;
}

export function buildFailureLabelArgv(options: FailureLabelArgvOptions): string[] {
  const repoArgs = options.repo ? ["--repo", options.repo] : [];
  return ["gh", "issue", "edit", String(options.issueNumber), "--add-label", options.label, ...repoArgs];
}

export function buildFailureCommentArgv(options: FailureCommentArgvOptions): string[] {
  const repoArgs = options.repo ? ["--repo", options.repo] : [];
  return ["gh", "issue", "comment", String(options.issueNumber), "--body", options.comment, ...repoArgs];
}

export async function markIssueFailed(options: MarkIssueFailedOptions): Promise<void> {
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

  try {
    await runProcessOrThrow(commentArgv, { cwd: options.cwd, label: "gh issue comment (failure)" });
  } catch (error) {
    console.warn(`Failed to post failure comment: ${formatError(error)}`);
  }
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
