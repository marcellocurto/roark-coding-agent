import { runProcessOrThrow } from "../cli/process.ts";
import type { WorkflowRunResult } from "../workflow/phases.ts";
import { buildFailureCommentArgv, buildFailureLabelArgv, buildRemoveLabelArgv } from "./failure.ts";
import type { AutorunIssueCandidate } from "./selection.ts";

export type TriageNoopVerdict = "blocked" | "reject" | "needs-human-decision";

export type TriageNoopCommentInput = {
  issueNumber: number;
  issueUrl?: string;
  verdict: string | undefined;
  triageArtifactPath: string;
  attemptMetadataPath: string;
};

export type MarkIssueTriageNoopOptions = {
  cwd: string;
  repo?: string;
  issue: AutorunIssueCandidate;
  verdict: string | undefined;
  inProgressLabel: string;
  failureLabel: string;
  triageArtifactPath: string;
  attemptMetadataPath: string;
};

export function isTriageNoopWorkflowResult(
  result: WorkflowRunResult,
): result is Extract<WorkflowRunResult, { status: "stopped"; phase: "triage" }> {
  return result.status === "stopped" && result.phase === "triage";
}

export function triageNoopLabelForVerdict(verdict: string | undefined): string | undefined {
  if (verdict === "blocked") return "blocked";
  if (verdict === "needs-human-decision") return "needs-human";
  if (verdict === "reject") return "wontfix";
  return undefined;
}

export function triageNoopOutcomeDetail(verdict: string | undefined): string {
  return `triage verdict is "${verdict ?? "unknown"}"`;
}

export function formatTriageNoopComment(input: TriageNoopCommentInput): string {
  const issueDisplay = input.issueUrl ?? `#${input.issueNumber}`;
  return [
    `Roark stopped after triage on issue ${issueDisplay}: verdict \`${input.verdict ?? "unknown"}\`, so no implementation will be attempted.`,
    "",
    `Triage: \`${input.triageArtifactPath}\``,
    `Attempt: \`${input.attemptMetadataPath}\``,
    "",
  ].join("\n");
}

export async function markIssueTriageNoop(options: MarkIssueTriageNoopOptions): Promise<void> {
  const terminalLabel = triageNoopLabelForVerdict(options.verdict);
  const comment = formatTriageNoopComment({
    issueNumber: options.issue.number,
    issueUrl: options.issue.url,
    verdict: options.verdict,
    triageArtifactPath: options.triageArtifactPath,
    attemptMetadataPath: options.attemptMetadataPath,
  });

  console.log(`\nNo implementation for #${options.issue.number}: ${triageNoopOutcomeDetail(options.verdict)}.`);
  console.log(`Triage: ${options.triageArtifactPath}`);
  console.log(`Attempt: ${options.attemptMetadataPath}`);
  if (terminalLabel) console.log(`Label: ${terminalLabel}`);

  if (terminalLabel) {
    try {
      await runProcessOrThrow(
        buildFailureLabelArgv({ repo: options.repo, issueNumber: options.issue.number, label: terminalLabel }),
        { cwd: options.cwd, label: "gh issue edit --add-label (triage no-op)" },
      );
    } catch (error) {
      console.warn(`Failed to apply triage no-op label '${terminalLabel}': ${formatError(error)}`);
    }
  }

  for (const label of uniqueLabels([options.inProgressLabel, options.failureLabel]).filter((label) => label !== terminalLabel)) {
    try {
      await runProcessOrThrow(
        buildRemoveLabelArgv({ repo: options.repo, issueNumber: options.issue.number, label }),
        { cwd: options.cwd, label: "gh issue edit --remove-label (triage no-op cleanup)" },
      );
    } catch (error) {
      console.warn(`Failed to remove label '${label}': ${formatError(error)}`);
    }
  }

  try {
    await runProcessOrThrow(
      buildFailureCommentArgv({ repo: options.repo, issueNumber: options.issue.number, comment }),
      { cwd: options.cwd, label: "gh issue comment (triage no-op)" },
    );
  } catch (error) {
    console.warn(`Failed to post triage no-op comment: ${formatError(error)}`);
  }
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
