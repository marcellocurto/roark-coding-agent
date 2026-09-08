import { fromLegacyPromise } from "../runtime/application.ts";
import { runApplicationPromise } from "../runtime/application.ts";
import type { ApplicationExecution } from "../runtime/application.ts";
import { runProcessOrThrowPromise } from "../cli/process-promise.ts";
import {
  truncateGitHubIssueComment,
  type GitHubCommentRef,
} from "../github/comments.ts";
import {
  postIssueCommentPromise as postIssueComment,
  postOrUpdateIssueCommentByMarkerPromise as postOrUpdateIssueCommentByMarker,
} from "../github/promise.ts";
import { type WorkflowContext } from "../workflow/artifacts.ts";
import { readArtifactPromise as readArtifact } from "../workflow/artifacts-promise.ts";
import { parseTriageResultJson } from "../triage/result.ts";
import { sanitizePublicMarkdown } from "./public-output.ts";
import { presenter } from "../presentation/presenter.ts";

export type TriageStoppedVerdict = string;

export interface FormatTriageStoppedCommentInput {
  issueNumber: number;
  issueUrl?: string | undefined;
  triageVerdict: TriageStoppedVerdict;
  triageArtifactContent?: string | undefined;
}

export type MarkIssueTriageStoppedOptions = FormatTriageStoppedCommentInput & {
  cwd: string;
  repo?: string | undefined;
  removeLabels?: string[] | undefined;
  marker?: string | undefined;
  existingCommentId?: number | undefined;
};

export async function readTriageStoppedVerdict(
  context: WorkflowContext,
  application?: ApplicationExecution,
): Promise<TriageStoppedVerdict> {
  return parseTriageResultJson(
    await readArtifact(context, "triage", application),
  ).verdict;
}

export function mapTriageVerdictToLabel(
  verdict: TriageStoppedVerdict,
): "blocked" | "needs-human" | "triage-rejected" {
  if (verdict === "blocked") return "blocked";
  if (verdict === "reject") return "triage-rejected";
  return "needs-human";
}

export function formatTriageStoppedComment(
  input: FormatTriageStoppedCommentInput,
): string {
  if (!input.triageArtifactContent?.trim()) return "";
  return truncateGitHubIssueComment(
    `${sanitizePublicMarkdown(input.triageArtifactContent).trimEnd()}\n`,
  );
}

export function buildTriageStopAddLabelArgv(options: {
  repo?: string | undefined;
  issueNumber: number;
  label: string;
}): string[] {
  const repoArgs = options.repo ? ["--repo", options.repo] : [];
  return [
    "gh",
    "issue",
    "edit",
    String(options.issueNumber),
    "--add-label",
    options.label,
    ...repoArgs,
  ];
}

export function buildTriageStopRemoveLabelArgv(options: {
  repo?: string | undefined;
  issueNumber: number;
  label: string;
}): string[] {
  const repoArgs = options.repo ? ["--repo", options.repo] : [];
  return [
    "gh",
    "issue",
    "edit",
    String(options.issueNumber),
    "--remove-label",
    options.label,
    ...repoArgs,
  ];
}

export async function markIssueTriageStopped(
  options: MarkIssueTriageStoppedOptions,
  application?: ApplicationExecution,
): Promise<GitHubCommentRef | undefined> {
  if (!application)
    return runApplicationPromise(
      fromLegacyPromise((application) =>
        markIssueTriageStopped(options, application),
      ),
      application,
    );

  const label = mapTriageVerdictToLabel(options.triageVerdict);
  const comment = formatTriageStoppedComment(options);

  try {
    await runProcessOrThrowPromise(
      buildTriageStopAddLabelArgv({
        repo: options.repo,
        issueNumber: options.issueNumber,
        label,
      }),
      { cwd: options.cwd, label: "gh issue edit --add-label (triage stop)" },
      application,
    );
  } catch (error) {
    presenter(application).warning(
      `failed to apply triage-stop label '${label}': ${formatError(error)}`,
    );
  }

  for (const removeLabel of uniqueLabels(options.removeLabels ?? []).filter(
    (candidate) => candidate !== label,
  )) {
    try {
      await runProcessOrThrowPromise(
        buildTriageStopRemoveLabelArgv({
          repo: options.repo,
          issueNumber: options.issueNumber,
          label: removeLabel,
        }),
        {
          cwd: options.cwd,
          label: "gh issue edit --remove-label (triage stop cleanup)",
        },
        application,
      );
    } catch (error) {
      presenter(application).warning(
        `failed to remove label '${removeLabel}': ${formatError(error)}`,
      );
    }
  }

  try {
    if (options.marker) {
      return await postOrUpdateIssueCommentByMarker(
        {
          cwd: options.cwd,
          repo: options.repo,
          issueNumber: options.issueNumber,
          marker: options.marker,
          body: comment,
          existingCommentId: options.existingCommentId,
        },
        application,
      );
    }
    await postIssueComment(
      {
        cwd: options.cwd,
        repo: options.repo,
        issueNumber: options.issueNumber,
        body: comment,
      },
      application,
    );
  } catch (error) {
    presenter(application).warning(
      `failed to post triage-stop comment: ${formatError(error)}`,
    );
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
