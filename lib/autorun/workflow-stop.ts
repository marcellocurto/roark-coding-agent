import { GitHub } from "../github/service.ts";
import { Presentation } from "../runtime/services.ts";
import { Effect } from "effect";
import { truncateGitHubIssueComment } from "../github/comments.ts";
import { sanitizePublicMarkdown } from "./public-output.ts";
export type WorkflowStoppedVerdict =
  | "blocked"
  | "needs-human-decision"
  | "reject";
export interface FormatWorkflowStoppedCommentInput {
  issueNumber: number;
  issueUrl?: string | undefined;
  verdict: WorkflowStoppedVerdict;
  artifactContent?: string | undefined;
  recoveryCommand?: string | undefined;
}
export type MarkIssueWorkflowStoppedOptions =
  FormatWorkflowStoppedCommentInput & {
    cwd: string;
    repo?: string | undefined;
    removeLabels?: string[] | undefined;
    marker?: string | undefined;
    existingCommentId?: number | undefined;
  };
export function mapStopVerdictToLabel(
  verdict: WorkflowStoppedVerdict,
): "blocked" | "needs-human" | "triage-rejected" {
  if (verdict === "blocked") return "blocked";
  if (verdict === "reject") return "triage-rejected";
  return "needs-human";
}
export function formatWorkflowStoppedComment(
  input: FormatWorkflowStoppedCommentInput,
): string {
  if (!input.artifactContent?.trim()) return "";
  return truncateGitHubIssueComment(
    sanitizePublicMarkdown(
      `${input.artifactContent.trimEnd()}\n${input.recoveryCommand ? `\nAdd the missing information or decision to the issue, then run \`${input.recoveryCommand}\` to read the updated discussion and continue the saved work.\n` : ""}`,
    ),
  );
}
export const markIssueWorkflowStopped = Effect.fn("markIssueWorkflowStopped")(
  function* (options: MarkIssueWorkflowStoppedOptions) {
    const label = mapStopVerdictToLabel(options.verdict);
    const comment = formatWorkflowStoppedComment(options);
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
            `failed to apply workflow-stop label '${label}': ${error.message}`,
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
            `failed to post workflow-stop comment: ${error.message}`,
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
