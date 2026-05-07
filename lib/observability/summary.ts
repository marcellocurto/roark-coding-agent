import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { WorkflowContext } from "../workflow/artifacts.ts";

export type RunStatus = "running" | "completed" | "failed" | "stopped";
export type PhaseStatus = "running" | "completed" | "failed" | "skipped";

export type ObservabilityTotals = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  cost: number;
  toolCalls: number;
};

export type PhaseSummary = {
  phase: string;
  label?: string;
  status: PhaseStatus;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  artifactPath?: string;
  model?: string;
  thinkingLevel?: string;
  sessionId?: string;
  reused?: boolean;
  errorMessage?: string;
  totals?: ObservabilityTotals;
};

export type RunSummary = {
  version: 1;
  issueNumber: string;
  attempt?: number;
  runDir: string;
  status: RunStatus;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  phases: Record<string, PhaseSummary>;
  totals: ObservabilityTotals;
  lastError?: string;
  recoveryCommand?: string;
};

export type SessionStatsLike = {
  sessionId?: string;
  toolCalls?: number;
  tokens?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
  cost?: number;
};

export type SummaryOptions = {
  warn?: (message: string) => void;
};

export function emptyTotals(): ObservabilityTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    cost: 0,
    toolCalls: 0,
  };
}

export async function readRunSummary(summaryPath: string): Promise<RunSummary | undefined> {
  try {
    return JSON.parse(await readFile(summaryPath, "utf8")) as RunSummary;
  } catch {
    return undefined;
  }
}

export async function updateRunSummary(
  context: WorkflowContext,
  update: (summary: RunSummary) => void,
  options: SummaryOptions = {},
): Promise<void> {
  const warn = options.warn ?? defaultWarn;
  const summaryPath = path.join(context.runDir, "summary.json");
  try {
    await mkdir(context.runDir, { recursive: true });
    const summary = await readRunSummary(summaryPath) ?? createInitialSummary(context);
    update(summary);
    recomputeSummary(summary);
    await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  } catch (error) {
    warn(`observability summary write failed: ${formatError(error)}`);
  }
}

export function createInitialSummary(context: WorkflowContext): RunSummary {
  return {
    version: 1,
    issueNumber: context.issueNumber,
    attempt: context.attempt,
    runDir: context.runDirRelative,
    status: "running",
    phases: {},
    totals: emptyTotals(),
    recoveryCommand: buildRecoveryCommand(context),
  };
}

export function totalsFromSessionStats(stats: SessionStatsLike): ObservabilityTotals {
  return {
    inputTokens: stats.tokens?.input ?? 0,
    outputTokens: stats.tokens?.output ?? 0,
    cacheReadTokens: stats.tokens?.cacheRead ?? 0,
    cacheWriteTokens: stats.tokens?.cacheWrite ?? 0,
    totalTokens: stats.tokens?.total ?? 0,
    cost: stats.cost ?? 0,
    toolCalls: stats.toolCalls ?? 0,
  };
}

export function addTotals(left: ObservabilityTotals, right: ObservabilityTotals): ObservabilityTotals {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
    cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
    totalTokens: left.totalTokens + right.totalTokens,
    cost: left.cost + right.cost,
    toolCalls: left.toolCalls + right.toolCalls,
  };
}

export function formatErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 1000 ? `${message.slice(0, 1000)}…` : message;
}

function recomputeSummary(summary: RunSummary): void {
  summary.totals = Object.values(summary.phases).reduce(
    (totals, phase) => addTotals(totals, phase.totals ?? emptyTotals()),
    emptyTotals(),
  );
  if (summary.startedAt && summary.endedAt) {
    summary.durationMs = Math.max(0, Date.parse(summary.endedAt) - Date.parse(summary.startedAt));
  }
  for (const phase of Object.values(summary.phases)) {
    if (phase.startedAt && phase.endedAt) {
      phase.durationMs = Math.max(0, Date.parse(phase.endedAt) - Date.parse(phase.startedAt));
    }
  }
}

function buildRecoveryCommand(context: WorkflowContext): string {
  const repo = context.repo ? ` --repo ${context.repo}` : "";
  if (context.attempt !== undefined) return `roark continue ${context.issueNumber}${repo} --attempt ${context.attempt}`;
  return `roark do ${context.issueNumber}${repo}`;
}

function defaultWarn(message: string): void {
  console.warn(`! ${message}`);
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
