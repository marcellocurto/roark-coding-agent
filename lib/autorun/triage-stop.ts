import { runProcessOrThrow } from "../cli/process.ts";
import { readArtifact, type WorkflowContext } from "../workflow/artifacts.ts";
import { parseVerdict } from "../workflow/verdicts.ts";

export type TriageStoppedVerdict = "blocked" | "reject" | "needs-human-decision" | string;

export type FormatTriageStoppedCommentInput = {
  issueNumber: number;
  issueUrl?: string;
  triageVerdict: TriageStoppedVerdict;
  triageArtifactPath?: string;
  attemptMetadataPath?: string;
};

export type MarkIssueTriageStoppedOptions = FormatTriageStoppedCommentInput & {
  cwd: string;
  repo?: string;
  removeLabels?: string[];
};

export async function readTriageStoppedVerdict(context: WorkflowContext): Promise<TriageStoppedVerdict> {
  return parseTriageStoppedVerdict(await readArtifact(context, "triage"));
}

export function parseTriageStoppedVerdict(markdown: string): TriageStoppedVerdict {
  return parseVerdict(markdown) ?? "unknown";
}

export function mapTriageVerdictToLabel(verdict: TriageStoppedVerdict): "blocked" | "needs-human" {
  return verdict === "blocked" ? "blocked" : "needs-human";
}

export function formatTriageStoppedComment(input: FormatTriageStoppedCommentInput): string {
  const issueDisplay = input.issueUrl ?? `#${input.issueNumber}`;
  const lines = [
    `Roark stopped issue ${issueDisplay} during triage with verdict **${input.triageVerdict}**.`,
    "",
    "This is a clean terminal triage outcome, so Roark did not run verification, push the branch, or create a PR.",
  ];

  if (input.triageArtifactPath || input.attemptMetadataPath) {
    lines.push("");
    if (input.triageArtifactPath) lines.push(`Triage artifact: \`${input.triageArtifactPath}\``);
    if (input.attemptMetadataPath) lines.push(`Attempt: \`${input.attemptMetadataPath}\``);
  }

  return `${lines.join("\n")}\n`;
}

export function buildTriageStopAddLabelArgv(options: { repo?: string; issueNumber: number; label: string }): string[] {
  const repoArgs = options.repo ? ["--repo", options.repo] : [];
  return ["gh", "issue", "edit", String(options.issueNumber), "--add-label", options.label, ...repoArgs];
}

export function buildTriageStopRemoveLabelArgv(options: { repo?: string; issueNumber: number; label: string }): string[] {
  const repoArgs = options.repo ? ["--repo", options.repo] : [];
  return ["gh", "issue", "edit", String(options.issueNumber), "--remove-label", options.label, ...repoArgs];
}

export function buildTriageStopCommentArgv(options: { repo?: string; issueNumber: number; comment: string }): string[] {
  const repoArgs = options.repo ? ["--repo", options.repo] : [];
  return ["gh", "issue", "comment", String(options.issueNumber), "--body", options.comment, ...repoArgs];
}

export async function markIssueTriageStopped(options: MarkIssueTriageStoppedOptions): Promise<void> {
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
    await runProcessOrThrow(
      buildTriageStopCommentArgv({ repo: options.repo, issueNumber: options.issueNumber, comment }),
      { cwd: options.cwd, label: "gh issue comment (triage stop)" },
    );
  } catch (error) {
    console.warn(`Failed to post triage-stop comment: ${formatError(error)}`);
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
