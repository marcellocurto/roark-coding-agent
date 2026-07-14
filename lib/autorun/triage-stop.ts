import { runProcessOrThrow } from "../cli/process.ts";
import { formatArtifactDetails, formatBoundedMarkdownDetails, postIssueComment, postOrUpdateIssueCommentByMarker, truncateGitHubIssueComment, type GitHubCommentRef } from "../github/comments.ts";
import { readArtifact, type WorkflowContext } from "../workflow/artifacts.ts";
import { parseTriageResultJson } from "../triage/result.ts";
import { sanitizePublicMarkdown } from "./public-output.ts";

export type TriageStoppedVerdict = string;

export interface FormatTriageStoppedCommentInput {
  issueNumber: number;
  issueUrl?: string | undefined  ;
  triageVerdict: TriageStoppedVerdict;
  triageArtifactPath?: string | undefined;
  triageArtifactContent?: string | undefined;
  attemptMetadataPath?: string | undefined;
}

export type MarkIssueTriageStoppedOptions = FormatTriageStoppedCommentInput & {
  cwd: string;
  repo?: string | undefined  ;
  removeLabels?: string[] | undefined;
  marker?: string | undefined;
  existingCommentId?: number | undefined  ;
};

export async function readTriageStoppedVerdict(context: WorkflowContext): Promise<TriageStoppedVerdict> {
  return parseTriageResultJson(await readArtifact(context, "triage")).verdict;
}

export function mapTriageVerdictToLabel(verdict: TriageStoppedVerdict): "blocked" | "needs-human" {
  if (verdict === "blocked") return "blocked";
  return "needs-human";
}

export function formatTriageStoppedComment(input: FormatTriageStoppedCommentInput): string {
  const issueDisplay = input.issueUrl ?? `#${input.issueNumber}`;
  const lines: string[] = [];
  lines.push(
    `Roark stopped issue ${issueDisplay} during triage with verdict **${input.triageVerdict}**.`,
    "",
    "This is a clean terminal triage outcome, so Roark did not run verification, push the branch, or create a PR.",
  );

  const artifacts: string[] = [];
  if (input.triageArtifactPath) artifacts.push(`Triage artifact: \`${input.triageArtifactPath}\``);
  if (input.attemptMetadataPath) artifacts.push(`Attempt: \`${input.attemptMetadataPath}\``);
  if (artifacts.length > 0) lines.push("", formatArtifactDetails(artifacts));
  if (input.triageArtifactContent) {
    lines.push("", formatBoundedMarkdownDetails("Triage artifact excerpt", sanitizePublicMarkdown(input.triageArtifactContent)));
  }

  return truncateGitHubIssueComment(`${lines.join("\n")}\n`);
}

export function buildTriageStopAddLabelArgv(options: { repo?: string | undefined; issueNumber: number; label: string }): string[] {
  const repoArgs = options.repo ? ["--repo", options.repo] : [];
  return ["gh", "issue", "edit", String(options.issueNumber), "--add-label", options.label, ...repoArgs];
}

export function buildTriageStopRemoveLabelArgv(options: { repo?: string | undefined; issueNumber: number; label: string }): string[] {
  const repoArgs = options.repo ? ["--repo", options.repo] : [];
  return ["gh", "issue", "edit", String(options.issueNumber), "--remove-label", options.label, ...repoArgs];
}

export async function markIssueTriageStopped(options: MarkIssueTriageStoppedOptions): Promise<GitHubCommentRef | undefined> {
  const label = mapTriageVerdictToLabel(options.triageVerdict);
  const comment = formatTriageStoppedComment(options);

  try {
    await runProcessOrThrow(
      buildTriageStopAddLabelArgv({ repo: options.repo, issueNumber: options.issueNumber, label }),
      { cwd: options.cwd, label: "gh issue edit --add-label (triage stop)" },
    );
  } catch (error) {
    console.warn(`Failed to apply triage-stop label '${label}': ${formatError(error)}`);
  }

  for (const removeLabel of uniqueLabels(options.removeLabels ?? []).filter((candidate) => candidate !== label)) {
    try {
      await runProcessOrThrow(
        buildTriageStopRemoveLabelArgv({ repo: options.repo, issueNumber: options.issueNumber, label: removeLabel }),
        { cwd: options.cwd, label: "gh issue edit --remove-label (triage stop cleanup)" },
      );
    } catch (error) {
      console.warn(`Failed to remove label '${removeLabel}': ${formatError(error)}`);
    }
  }

  try {
    if (options.marker) {
      return await postOrUpdateIssueCommentByMarker({
        cwd: options.cwd,
        repo: options.repo,
        issueNumber: options.issueNumber,
        marker: options.marker,
        body: comment,
        existingCommentId: options.existingCommentId,
      });
    }
    await postIssueComment({ cwd: options.cwd, repo: options.repo, issueNumber: options.issueNumber, body: comment });
  } catch (error) {
    console.warn(`Failed to post triage-stop comment: ${formatError(error)}`);
  }
  return undefined;
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
