import { GitHub } from "../github/service.ts";
import { Presentation } from "../runtime/services.ts";
import { Effect } from "effect";
import {
  formatBoundedMarkdownDetails,
  truncateGitHubIssueComment,
} from "../github/comments.ts";
import { redactLocalPaths, sanitizePublicMarkdown } from "./public-output.ts";
export const defaultAutorunFailureLabel = "agent-failed";
export interface FailureCommentInput {
  issueNumber: number;
  issueUrl?: string | undefined;
  phase: string;
  reason: string;
  branchName?: string | undefined;
  worktreePath?: string | undefined;
  workspacePath?: string | undefined;
  artifactContent?: string | undefined;
  recoveryCommand?: string | undefined;
}
export interface MarkIssueFailedOptions {
  cwd: string;
  repo?: string | undefined;
  issueNumber: number;
  label: string;
  comment: string;
  removeLabels?: string[] | undefined;
  marker?: string | undefined;
  existingCommentId?: number | undefined;
}
export interface FailureLabelArgvOptions {
  repo?: string | undefined;
  issueNumber: number;
  label: string;
}
export function formatFailureComment(input: FailureCommentInput): string {
  const issueDisplay = input.issueUrl ?? `#${input.issueNumber}`;
  const lead = `Roark stopped on issue ${issueDisplay} at phase **${input.phase}**: ${sanitizePublicMarkdown(input.reason)}.`;
  const lines: string[] = [lead];
  if (input.branchName) lines.push(`Branch: \`${input.branchName}\``);
  if (input.recoveryCommand) {
    lines.push("", "## Recovery");
    lines.push("From the same checkout, run:");
    lines.push(
      formatFencedBlock(
        formatPublicRecoveryCommand(input.recoveryCommand),
        "bash",
      ),
    );
  }
  if (input.artifactContent !== undefined && input.phase !== "verification") {
    lines.push(
      "",
      formatBoundedMarkdownDetails(
        "Failure artifact excerpt",
        sanitizePublicMarkdown(input.artifactContent),
      ),
    );
  }
  return truncateGitHubIssueComment(`${lines.join("\n")}\n`);
}
export function buildFailureLabelArgv(
  options: FailureLabelArgvOptions,
): string[] {
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
export function buildRemoveLabelArgv(
  options: FailureLabelArgvOptions,
): string[] {
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
export const markIssueFailed = Effect.fn("markIssueFailed")(function* (
  options: MarkIssueFailedOptions,
) {
  yield* Effect.gen(function* () {
    yield* (yield* GitHub).addIssueLabel({
      cwd: options.cwd,
      repo: options.repo,
      issueNumber: options.issueNumber,
      label: options.label,
    });
  }).pipe(
    Effect.catch(
      Effect.fnUntraced(function* (error) {
        (yield* Presentation).warning(
          `failed to apply failure label '${options.label}': ${error.message}`,
        );
      }),
    ),
  );
  for (const label of uniqueLabels(options.removeLabels ?? []).filter(
    (label) => label !== options.label,
  )) {
    yield* Effect.gen(function* () {
      yield* (yield* GitHub).removeIssueLabel({
        cwd: options.cwd,
        repo: options.repo,
        issueNumber: options.issueNumber,
        label: label,
      });
    }).pipe(
      Effect.catch(
        Effect.fnUntraced(function* (error) {
          (yield* Presentation).warning(
            `failed to remove label '${label}': ${error.message}`,
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
        body: options.comment,
        existingCommentId: options.existingCommentId,
      });
    }
    return yield* (yield* GitHub).postIssueComment({
      cwd: options.cwd,
      repo: options.repo,
      issueNumber: options.issueNumber,
      body: options.comment,
    });
  }).pipe(
    Effect.catch(
      Effect.fnUntraced(function* (error) {
        (yield* Presentation).warning(
          `failed to post failure comment: ${error.message}`,
        );
      }),
    ),
  );
  return undefined;
});
function formatPublicRecoveryCommand(value: string): string {
  return redactLocalPaths(
    parseShellWords(value)
      .filter(shouldKeepPublicRecoveryToken)
      .map((token) => token.raw)
      .join(" "),
  );
}
interface ShellWord {
  raw: string;
  value: string;
}
function shouldKeepPublicRecoveryToken(
  token: ShellWord,
  index: number,
  tokens: ShellWord[],
): boolean {
  return (
    token.value !== "--cwd" &&
    tokens[index - 1]?.value !== "--cwd" &&
    !token.value.startsWith("--cwd=")
  );
}
function parseShellWords(value: string): ShellWord[] {
  const tokens: ShellWord[] = [];
  let index = 0;
  while (index < value.length) {
    while (index < value.length && /\s/.test(value[index] ?? "")) index += 1;
    if (index >= value.length) break;
    const start = index;
    let parsed = "";
    while (index < value.length && !/\s/.test(value[index] ?? "")) {
      const char = value[index] ?? "";
      if (char === "'") {
        index += 1;
        while (index < value.length && value[index] !== "'") {
          parsed += value[index] ?? "";
          index += 1;
        }
        if (value[index] === "'") index += 1;
        continue;
      }
      if (char === '"') {
        index += 1;
        while (index < value.length && value[index] !== '"') {
          if (value[index] === "\\" && index + 1 < value.length) index += 1;
          parsed += value[index] ?? "";
          index += 1;
        }
        if (value[index] === '"') index += 1;
        continue;
      }
      if (char === "\\" && index + 1 < value.length) {
        index += 1;
        parsed += value[index] ?? "";
        index += 1;
        continue;
      }
      parsed += char;
      index += 1;
    }
    tokens.push({ raw: value.slice(start, index), value: parsed });
  }
  return tokens;
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
