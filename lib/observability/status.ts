import { Effect, FileSystem, Option, Schema } from "effect";

import path from "node:path";
import type { StatusCliOptions } from "../cli/args.ts";
import { parseIssueRef } from "../github/issue.ts";
import type { PhaseSummary, RunSummary } from "./summary.ts";
import { readRunSummary } from "./summary.ts";
export const renderStatus = Effect.fn("renderStatus")(function* (
  options: StatusCliOptions,
) {
  const cwd = path.resolve(options.cwd);
  const outDir = path.resolve(cwd, options.outDir);
  if (options.all) return renderAllStatus(yield* readAllSummaries(outDir));
  const issue = options.issue;
  if (!issue)
    return yield* Effect.fail(
      new StatusError({ message: "Missing issue for status command." }),
    );
  const parsed = yield* Effect.try({
    try: () => parseIssueRef(issue, options.repo),
    catch: (cause) =>
      new StatusError({
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  });
  const summary =
    options.attempt !== undefined
      ? yield* readAttemptSummary(outDir, parsed.issueNumber, options.attempt)
      : yield* readLatestIssueSummary(outDir, parsed.issueNumber);
  if (!summary)
    return `No observability summary found for issue #${parsed.issueNumber}.`;
  return renderOneStatus(summary);
});
export const readLatestIssueSummary = Effect.fn("readLatestIssueSummary")(
  function* (outDir: string, issueNumber: string) {
    return (yield* readIssueSummaries(outDir, issueNumber))
      .sort(compareSummaryRecency)
      .at(-1);
  },
);
export const readAttemptSummary = Effect.fn("readAttemptSummary")(function* (
  outDir: string,
  issueNumber: string,
  attempt: number,
) {
  return yield* readRunSummary(
    path.join(
      outDir,
      "issue",
      issueNumber,
      "attempts",
      String(attempt),
      "summary.json",
    ),
  );
});
export function renderOneStatus(summary: RunSummary): string {
  const lines = [
    `Issue #${summary.issueNumber}${summary.attempt !== undefined ? ` attempt ${summary.attempt}` : ""}`,
    `Status: ${summary.status}`,
    `Run directory: ${summary.runDir}`,
  ];
  if (summary.durationMs !== undefined)
    lines.push(`Duration: ${formatDuration(summary.durationMs)}`);
  lines.push(formatTotals(summary));
  if (summary.lastError) lines.push(`Last error: ${summary.lastError}`);
  if (summary.recoveryCommand && summary.status !== "completed")
    lines.push(`Recovery: ${summary.recoveryCommand}`);
  lines.push("", "Phases:");
  const phases = Object.values(summary.phases).sort(comparePhases);
  if (phases.length === 0) lines.push("- none");
  for (const phase of phases) lines.push(formatPhase(phase));
  return lines.join("\n");
}
function renderAllStatus(summaries: readonly RunSummary[]): string {
  if (summaries.length === 0) return "No observability summaries found.";
  const lines = ["Known Roark runs:"];
  for (const summary of [...summaries].sort(
    (a, b) => Number(a.issueNumber) - Number(b.issueNumber),
  )) {
    const attempt =
      summary.attempt !== undefined ? ` attempt ${summary.attempt}` : "";
    const error = summary.lastError ? ` last_error=${summary.lastError}` : "";
    lines.push(
      `- #${summary.issueNumber}${attempt}: ${summary.status}, ${formatDuration(summary.durationMs ?? 0)}, tokens=${summary.totals.totalTokens}, cost=${formatCost(summary.totals.cost)}${error}`,
    );
  }
  return lines.join("\n");
}
const directoryNames = Effect.fnUntraced(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(directory))) return [];
  const directories: string[] = [];
  for (const name of yield* fs.readDirectory(directory)) {
    const file = path.join(directory, name);
    if (Option.isSome(yield* fs.readLink(file).pipe(Effect.option))) continue;
    if ((yield* fs.stat(file)).type === "Directory") directories.push(name);
  }
  return directories;
});
const readAllSummaries = Effect.fnUntraced(function* (outDir: string) {
  const summaries: RunSummary[] = [];
  for (const issue of yield* directoryNames(path.join(outDir, "issue")))
    summaries.push(...(yield* readIssueSummaries(outDir, issue)));
  return summaries;
});
const readIssueSummaries = Effect.fnUntraced(function* (
  outDir: string,
  issueNumber: string,
) {
  const summaries: RunSummary[] = [];
  const directory = path.join(outDir, "issue", issueNumber);
  const direct = yield* readRunSummary(path.join(directory, "summary.json"));
  if (direct) summaries.push(direct);
  for (const attempt of yield* directoryNames(
    path.join(directory, "attempts"),
  )) {
    const summary = yield* readRunSummary(
      path.join(directory, "attempts", attempt, "summary.json"),
    );
    if (summary) summaries.push(summary);
  }
  return summaries;
});
export class StatusError extends Schema.TaggedError<StatusError>()(
  "StatusError",
  { message: Schema.String },
) {}

function compareSummaryRecency(a: RunSummary, b: RunSummary): number {
  const at = Date.parse(a.endedAt ?? a.startedAt ?? "");
  const bt = Date.parse(b.endedAt ?? b.startedAt ?? "");
  if (at !== bt) return at - bt;
  return (a.attempt ?? 0) - (b.attempt ?? 0);
}
function comparePhases(a: PhaseSummary, b: PhaseSummary): number {
  const at = Date.parse(a.startedAt ?? "");
  const bt = Date.parse(b.startedAt ?? "");
  if (at !== bt) return at - bt;
  return a.phase.localeCompare(b.phase);
}
function formatPhase(phase: PhaseSummary): string {
  const details = [
    phase.durationMs !== undefined
      ? formatDuration(phase.durationMs)
      : undefined,
    phase.artifactPath,
    phase.model ? `model=${phase.model}` : undefined,
    phase.thinkingLevel ? `thinking=${phase.thinkingLevel}` : undefined,
    phase.sessionId ? `session=${phase.sessionId}` : undefined,
    phase.totals ? `tokens=${phase.totals.totalTokens}` : undefined,
    phase.totals ? `cost=${formatCost(phase.totals.cost)}` : undefined,
    phase.errorMessage ? `error=${phase.errorMessage}` : undefined,
  ]
    .filter(Boolean)
    .join(", ");
  return `- ${phase.label ?? phase.phase}: ${phase.status}${details ? ` (${details})` : ""}`;
}
function formatTotals(summary: RunSummary): string {
  return `Totals: tokens=${summary.totals.totalTokens} input=${summary.totals.inputTokens} output=${summary.totals.outputTokens} tool_calls=${summary.totals.toolCalls} cost=${formatCost(summary.totals.cost)}`;
}
function formatCost(value: number): string {
  return `$${value.toFixed(6)}`;
}
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = Math.round(seconds % 60);
  return `${minutes}m ${remaining}s`;
}
