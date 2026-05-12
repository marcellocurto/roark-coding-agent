import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { StatusCliOptions } from "../cli/args.ts";
import { parseIssueRef } from "../github/issue.ts";
import type { PhaseSummary, RunSummary } from "./summary.ts";

export async function renderStatus(options: StatusCliOptions): Promise<string> {
  const cwd = path.resolve(options.cwd);
  const outDir = path.resolve(cwd, options.outDir);
  if (options.all) return renderAllStatus(await readAllSummaries(outDir));
  if (!options.issue) throw new Error("Missing issue for status command.");

  const parsed = parseIssueRef(options.issue, options.repo);
  const summary = options.attempt !== undefined
    ? await readAttemptSummary(outDir, parsed.issueNumber, options.attempt)
    : await readLatestIssueSummary(outDir, parsed.issueNumber);
  if (!summary) return `No observability summary found for issue #${parsed.issueNumber}.`;
  return renderOneStatus(summary);
}

export async function readLatestIssueSummary(outDir: string, issueNumber: string): Promise<RunSummary | undefined> {
  return (await readIssueSummaries(outDir, issueNumber)).sort(compareSummaryRecency).at(-1);
}

export async function readAttemptSummary(outDir: string, issueNumber: string, attempt: number): Promise<RunSummary | undefined> {
  return readSummary(path.join(outDir, "issue", issueNumber, "attempts", String(attempt), "summary.json"));
}

export function renderOneStatus(summary: RunSummary): string {
  const lines = [
    `Issue #${summary.issueNumber}${summary.attempt !== undefined ? ` attempt ${summary.attempt}` : ""}`,
    `Status: ${summary.status}`,
    `Run directory: ${summary.runDir}`,
  ];
  if (summary.durationMs !== undefined) lines.push(`Duration: ${formatDuration(summary.durationMs)}`);
  lines.push(formatTotals(summary));
  if (summary.lastError) lines.push(`Last error: ${summary.lastError}`);
  if (summary.recoveryCommand && summary.status !== "completed") lines.push(`Recovery: ${summary.recoveryCommand}`);
  lines.push("", "Phases:");
  const phases = Object.values(summary.phases).sort(comparePhases);
  if (phases.length === 0) lines.push("- none");
  for (const phase of phases) lines.push(formatPhase(phase));
  return lines.join("\n");
}

function renderAllStatus(summaries: readonly RunSummary[]): string {
  if (summaries.length === 0) return "No observability summaries found.";
  const lines = ["Known Roark runs:"];
  for (const summary of [...summaries].sort((a, b) => Number(a.issueNumber) - Number(b.issueNumber))) {
    const attempt = summary.attempt !== undefined ? ` attempt ${summary.attempt}` : "";
    const error = summary.lastError ? ` last_error=${summary.lastError}` : "";
    lines.push(`- #${summary.issueNumber}${attempt}: ${summary.status}, ${formatDuration(summary.durationMs ?? 0)}, tokens=${summary.totals.totalTokens}, cost=${formatCost(summary.totals.cost)}${error}`);
  }
  return lines.join("\n");
}

async function readAllSummaries(outDir: string): Promise<RunSummary[]> {
  const issuesDir = path.join(outDir, "issue");
  if (!existsSync(issuesDir)) return [];
  const summaries: RunSummary[] = [];
  for (const entry of await readdir(issuesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    summaries.push(...await readIssueSummaries(outDir, entry.name));
  }
  return summaries;
}

async function readIssueSummaries(outDir: string, issueNumber: string): Promise<RunSummary[]> {
  const summaries: RunSummary[] = [];
  const direct = await readSummary(path.join(outDir, "issue", issueNumber, "summary.json"));
  if (direct) summaries.push(direct);
  const attemptsDir = path.join(outDir, "issue", issueNumber, "attempts");
  if (existsSync(attemptsDir)) {
    for (const entry of await readdir(attemptsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const summary = await readSummary(path.join(attemptsDir, entry.name, "summary.json"));
      if (summary) summaries.push(summary);
    }
  }
  return summaries;
}

async function readSummary(summaryPath: string): Promise<RunSummary | undefined> {
  try {
    return JSON.parse(await readFile(summaryPath, "utf8")) as RunSummary;
  } catch {
    return undefined;
  }
}

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
    phase.durationMs !== undefined ? formatDuration(phase.durationMs) : undefined,
    phase.artifactPath,
    phase.model ? `model=${phase.model}` : undefined,
    phase.thinkingLevel ? `thinking=${phase.thinkingLevel}` : undefined,
    phase.sessionId ? `session=${phase.sessionId}` : undefined,
    phase.totals ? `tokens=${phase.totals.totalTokens}` : undefined,
    phase.totals ? `cost=${formatCost(phase.totals.cost)}` : undefined,
    phase.errorMessage ? `error=${phase.errorMessage}` : undefined,
  ].filter(Boolean).join(", ");
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
