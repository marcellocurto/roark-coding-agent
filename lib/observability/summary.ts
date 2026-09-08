import { Effect, FileSystem, Schema } from "effect";
import path from "node:path";
import type { WorkflowContext } from "../workflow/artifacts.ts";

export type RunStatus = "running" | "completed" | "failed" | "stopped";
export type PhaseStatus = "running" | "completed" | "failed" | "skipped";

export interface ObservabilityTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  cost: number;
  toolCalls: number;
}

export interface PhaseSummary {
  phase: string;
  label?: string | undefined;
  status: PhaseStatus;
  startedAt?: string | undefined;
  endedAt?: string | undefined;
  durationMs?: number | undefined;
  artifactPath?: string | undefined;
  model?: string | undefined;
  thinkingLevel?: string | undefined;
  requestedThinkingLevel?: string | undefined;
  effectiveThinkingLevel?: string | undefined;
  sessionId?: string | undefined;
  reused?: boolean | undefined;
  errorMessage?: string | undefined;
  totals?: ObservabilityTotals | undefined;
}

export interface RunSummary {
  version: 1;
  issueNumber: string;
  attempt?: number | undefined;
  runDir: string;
  status: RunStatus;
  startedAt?: string | undefined;
  endedAt?: string | undefined;
  durationMs?: number | undefined;
  phases: Record<string, PhaseSummary>;
  totals: ObservabilityTotals;
  lastError?: string | undefined;
  recoveryCommand?: string | undefined;
}

export interface SessionStatsLike {
  sessionId?: string | undefined;
  toolCalls?: number | undefined;
  tokens?: {
    input?: number | undefined;
    output?: number | undefined;
    cacheRead?: number | undefined;
    cacheWrite?: number | undefined;
    total?: number | undefined;
  };
  cost?: number | undefined;
}

export interface SummaryOptions {
  warn?: ((message: string) => void) | undefined;
}

const totalsSchema = Schema.Struct({
  inputTokens: Schema.Number,
  outputTokens: Schema.Number,
  cacheReadTokens: Schema.Number,
  cacheWriteTokens: Schema.Number,
  totalTokens: Schema.Number,
  cost: Schema.Number,
  toolCalls: Schema.Number,
});
const phaseSummarySchema = Schema.Struct({
  phase: Schema.String,
  label: Schema.optional(Schema.String),
  status: Schema.Literals(["running", "completed", "failed", "skipped"]),
  startedAt: Schema.optional(Schema.String),
  endedAt: Schema.optional(Schema.String),
  durationMs: Schema.optional(Schema.Number),
  artifactPath: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  thinkingLevel: Schema.optional(Schema.String),
  requestedThinkingLevel: Schema.optional(Schema.String),
  effectiveThinkingLevel: Schema.optional(Schema.String),
  sessionId: Schema.optional(Schema.String),
  reused: Schema.optional(Schema.Boolean),
  errorMessage: Schema.optional(Schema.String),
  totals: Schema.optional(totalsSchema),
});
const runSummarySchema = Schema.Struct({
  version: Schema.Literal(1),
  issueNumber: Schema.String,
  attempt: Schema.optional(Schema.Number),
  runDir: Schema.String,
  status: Schema.Literals(["running", "completed", "failed", "stopped"]),
  startedAt: Schema.optional(Schema.String),
  endedAt: Schema.optional(Schema.String),
  durationMs: Schema.optional(Schema.Number),
  phases: Schema.Record(Schema.String, phaseSummarySchema),
  totals: totalsSchema,
  lastError: Schema.optional(Schema.String),
  recoveryCommand: Schema.optional(Schema.String),
});
const decodeRunSummary = Schema.decodeUnknownSync(
  Schema.fromJsonString(runSummarySchema),
);

export function parseRunSummary(raw: string): RunSummary {
  return decodeRunSummary(raw, { onExcessProperty: "preserve" });
}

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

export const readRunSummary = Effect.fn("readRunSummary")(
  function* (summaryPath: string) {
    const fs = yield* FileSystem.FileSystem;
    const raw = yield* fs.readFileString(summaryPath);
    return yield* Effect.try(() => parseRunSummary(raw));
  },
  Effect.catch(() => Effect.succeed(undefined)),
);

export const updateRunSummary = Effect.fn("updateRunSummary")(function* (
  context: WorkflowContext,
  update: (summary: RunSummary) => void,
  options: SummaryOptions = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const warn = options.warn ?? defaultWarn;
  return yield* Effect.gen(function* () {
    const summaryPath = path.join(context.runDir, "summary.json");
    yield* fs.makeDirectory(context.runDir, { recursive: true });
    const summary =
      (yield* readRunSummary(summaryPath)) ?? createInitialSummary(context);
    update(summary);
    recomputeSummary(summary);
    yield* fs.writeFileString(
      summaryPath,
      `${JSON.stringify(summary, null, 2)}\n`,
    );
  }).pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        warn(`observability summary write failed: ${error.message}`);
      }),
    ),
    Effect.uninterruptible,
  );
});

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

export function totalsFromSessionStats(
  stats: SessionStatsLike,
): ObservabilityTotals {
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

export function addTotals(
  left: ObservabilityTotals,
  right: ObservabilityTotals,
): ObservabilityTotals {
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
    summary.durationMs = Math.max(
      0,
      Date.parse(summary.endedAt) - Date.parse(summary.startedAt),
    );
  }
  for (const phase of Object.values(summary.phases)) {
    if (phase.startedAt && phase.endedAt) {
      phase.durationMs = Math.max(
        0,
        Date.parse(phase.endedAt) - Date.parse(phase.startedAt),
      );
    }
  }
}

function buildRecoveryCommand(context: WorkflowContext): string {
  const repo = context.repo ? ` --repo ${context.repo}` : "";
  if (context.attempt !== undefined)
    return `roark continue ${context.issueNumber}${repo} --attempt ${context.attempt}`;
  return `roark do ${context.issueNumber}${repo}`;
}

function defaultWarn(message: string): void {
  console.warn(`! ${message}`);
}
