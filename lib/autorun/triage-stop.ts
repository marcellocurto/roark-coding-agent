import { GitHub } from "../github/service.ts";
import { Presentation } from "../runtime/services.ts";
import { Effect } from "effect";
import { truncateGitHubIssueComment } from "../github/comments.ts";
import { type WorkflowContext } from "../workflow/artifacts.ts";
import { readArtifact } from "../workflow/artifacts.ts";
import { parseTriageResultJson } from "../triage/result.ts";
import { sanitizePublicMarkdown } from "./public-output.ts";
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
export const readTriageStoppedVerdict = Effect.fn("readTriageStoppedVerdict")(
  function* (context: WorkflowContext) {
    return (yield* parseTriageResultJson(
      yield* readArtifact(context, "triage"),
    )).verdict;
  },
);
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
export const markIssueTriageStopped = Effect.fn("markIssueTriageStopped")(
  function* (options: MarkIssueTriageStoppedOptions) {
    const label = mapTriageVerdictToLabel(options.triageVerdict);
    const comment = formatTriageStoppedComment(options);
    yield* Effect.gen(function* () {
      yield* (yield* GitHub).addIssueLabel({
        cwd: options.cwd,
        repo: options.repo,
        issueNumber: options.issueNumber,
        label: label,
      });
    }).pipe(
      Effect.catch(
        Effect.fnUntraced(function* (error) {
          (yield* Presentation).warning(
            `failed to apply triage-stop label '${label}': ${error.message}`,
          );
        }),
      ),
    );
    for (const removeLabel of uniqueLabels(options.removeLabels ?? []).filter(
      (candidate) => candidate !== label,
    )) {
      yield* Effect.gen(function* () {
        yield* (yield* GitHub).removeIssueLabel({
          cwd: options.cwd,
          repo: options.repo,
          issueNumber: options.issueNumber,
          label: removeLabel,
        });
      }).pipe(
        Effect.catch(
          Effect.fnUntraced(function* (error) {
            (yield* Presentation).warning(
              `failed to remove label '${removeLabel}': ${error.message}`,
            );
          }),
        ),
      );
    }
    return yield* Effect.gen(function* () {
      if (options.marker) {
        return yield* (yield* GitHub).postOrUpdateIssueCommentByMarker({
          cwd: options.cwd,
          repo: options.repo,
          issueNumber: options.issueNumber,
          marker: options.marker,
          body: comment,
          existingCommentId: options.existingCommentId,
        });
      }
      yield* (yield* GitHub).postIssueComment({
        cwd: options.cwd,
        repo: options.repo,
        issueNumber: options.issueNumber,
        body: comment,
      });
    }).pipe(
      Effect.catch(
        Effect.fnUntraced(function* (error) {
          (yield* Presentation).warning(
            `failed to post triage-stop comment: ${error.message}`,
          );
        }),
      ),
    );
    return undefined;
  },
);
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
