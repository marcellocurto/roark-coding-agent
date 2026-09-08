import { createEventWriter, type EventWriter } from "./events.ts";
import {
  Clock,
  Context,
  Effect,
  type FileSystem,
  Layer,
  Semaphore,
} from "effect";
import type { ArtifactRef, WorkflowContext } from "../workflow/artifacts.ts";
import {
  artifactRelativePath,
  formatArtifactRef,
} from "../workflow/artifacts.ts";
import {
  addTotals,
  emptyTotals,
  formatErrorMessage,
  totalsFromSessionStats,
  updateRunSummary,
  type SessionStatsLike,
} from "./summary.ts";

export interface RunObserver {
  runStarted(input?: {
    command?: string;
    recoveryCommand?: string | undefined;
  }): Effect.Effect<void>;
  runCompleted(input?: { status?: string }): Effect.Effect<void>;
  runFailed(error: unknown): Effect.Effect<void>;
  phaseStarted(input: PhaseObservation): Effect.Effect<void>;
  phaseCompleted(
    input: PhaseObservation & { reused?: boolean },
  ): Effect.Effect<void>;
  phaseFailed(
    input: PhaseObservation & { error: unknown },
  ): Effect.Effect<void>;
  agentSessionStarted(input: AgentSessionObservation): Effect.Effect<void>;
  agentSessionStats(input: AgentSessionStatsObservation): Effect.Effect<void>;
  toolStarted(input: ToolObservation): Effect.Effect<void>;
  toolCompleted(
    input: ToolObservation & {
      durationMs?: number | undefined;
      isError?: boolean;
    },
  ): Effect.Effect<void>;
  autoRetryStarted(input: AutoRetryObservation): Effect.Effect<void>;
  autoRetryCompleted(
    input: AutoRetryObservation & {
      success?: boolean;
      finalError?: string | undefined;
    },
  ): Effect.Effect<void>;
}

export interface PhaseObservation {
  phase: string;
  label?: string | undefined;
  artifact?: ArtifactRef | undefined;
  artifactPath?: string | undefined;
  model?: string | undefined;
  thinkingLevel?: string | undefined;
}

export interface AgentSessionObservation {
  phase: string;
  sessionId: string;
  model?: string | undefined;
  thinkingLevel?: string | undefined;
  requestedThinkingLevel?: string | undefined;
  effectiveThinkingLevel?: string | undefined;
}

export interface AgentSessionStatsObservation {
  phase: string;
  stats: SessionStatsLike;
}

export interface ToolObservation {
  phase?: string | undefined;
  sessionId?: string | undefined;
  toolCallId: string;
  toolName: string;
}

export interface AutoRetryObservation {
  phase?: string | undefined;
  sessionId?: string | undefined;
  attempt: number;
  maxAttempts?: number | undefined;
  delayMs?: number | undefined;
  errorMessage?: string | undefined;
}

export function createNoopRunObserver(): RunObserver {
  return {
    runStarted: () => Effect.void,
    runCompleted: () => Effect.void,
    runFailed: () => Effect.void,
    phaseStarted: () => Effect.void,
    phaseCompleted: () => Effect.void,
    phaseFailed: () => Effect.void,
    agentSessionStarted: () => Effect.void,
    agentSessionStats: () => Effect.void,
    toolStarted: () => Effect.void,
    toolCompleted: () => Effect.void,
    autoRetryStarted: () => Effect.void,
    autoRetryCompleted: () => Effect.void,
  };
}

export const createFileRunObserver = Effect.fn("createFileRunObserver")(
  function* (context: WorkflowContext) {
    const services = yield* Effect.context<FileSystem.FileSystem>();
    const writer = yield* createEventWriter(context.runDir);
    const semaphore = yield* Semaphore.make(1);
    const observer = createRunObserver(context, writer);
    return {
      runStarted: (input) =>
        semaphore.withPermit(
          observer.runStarted(input).pipe(Effect.provide(services)),
        ),
      runCompleted: (input) =>
        semaphore.withPermit(
          observer.runCompleted(input).pipe(Effect.provide(services)),
        ),
      runFailed: (input) =>
        semaphore.withPermit(
          observer.runFailed(input).pipe(Effect.provide(services)),
        ),
      phaseStarted: (input) =>
        semaphore.withPermit(
          observer.phaseStarted(input).pipe(Effect.provide(services)),
        ),
      phaseCompleted: (input) =>
        semaphore.withPermit(
          observer.phaseCompleted(input).pipe(Effect.provide(services)),
        ),
      phaseFailed: (input) =>
        semaphore.withPermit(
          observer.phaseFailed(input).pipe(Effect.provide(services)),
        ),
      agentSessionStarted: (input) =>
        semaphore.withPermit(
          observer.agentSessionStarted(input).pipe(Effect.provide(services)),
        ),
      agentSessionStats: (input) =>
        semaphore.withPermit(
          observer.agentSessionStats(input).pipe(Effect.provide(services)),
        ),
      toolStarted: (input) =>
        semaphore.withPermit(
          observer.toolStarted(input).pipe(Effect.provide(services)),
        ),
      toolCompleted: (input) =>
        semaphore.withPermit(
          observer.toolCompleted(input).pipe(Effect.provide(services)),
        ),
      autoRetryStarted: (input) =>
        semaphore.withPermit(
          observer.autoRetryStarted(input).pipe(Effect.provide(services)),
        ),
      autoRetryCompleted: (input) =>
        semaphore.withPermit(
          observer.autoRetryCompleted(input).pipe(Effect.provide(services)),
        ),
    } satisfies RunObserver;
  },
);

function createRunObserver(context: WorkflowContext, writer: EventWriter) {
  return {
    runStarted: Effect.fn("RunObserver.runStarted")(function* (
      input: Parameters<RunObserver["runStarted"]>[0] = {},
    ) {
      const timestamp = new Date(yield* Clock.currentTimeMillis).toISOString();
      yield* writer.write({
        type: "run_started",
        timestamp,
        issueNumber: context.issueNumber,
        attempt: context.attempt,
        command: input.command,
        runDir: context.runDirRelative,
        recoveryCommand: input.recoveryCommand,
      });
      yield* updateRunSummary(context, (summary) => {
        summary.status = "running";
        summary.startedAt = timestamp;
        summary.endedAt = undefined;
        summary.durationMs = undefined;
        summary.phases = {};
        summary.totals = emptyTotals();
        if (input.recoveryCommand)
          summary.recoveryCommand = input.recoveryCommand;
        summary.lastError = undefined;
      });
    }),
    runCompleted: Effect.fn("RunObserver.runCompleted")(function* (
      input: Parameters<RunObserver["runCompleted"]>[0] = {},
    ) {
      const timestamp = new Date(yield* Clock.currentTimeMillis).toISOString();
      const status = input.status ?? "completed";
      yield* writer.write({
        type: "run_completed",
        timestamp,
        issueNumber: context.issueNumber,
        attempt: context.attempt,
        status,
      });
      yield* updateRunSummary(context, (summary) => {
        summary.status = status === "completed" ? "completed" : "stopped";
        summary.endedAt = timestamp;
      });
    }),
    runFailed: Effect.fn("RunObserver.runFailed")(function* (
      error: Parameters<RunObserver["runFailed"]>[0],
    ) {
      const timestamp = new Date(yield* Clock.currentTimeMillis).toISOString();
      const errorMessage = formatErrorMessage(error);
      yield* writer.write({
        type: "run_failed",
        timestamp,
        issueNumber: context.issueNumber,
        attempt: context.attempt,
        errorMessage,
      });
      yield* updateRunSummary(context, (summary) => {
        summary.status = "failed";
        summary.endedAt = timestamp;
        summary.lastError = errorMessage;
      });
    }),
    phaseStarted: Effect.fn("RunObserver.phaseStarted")(function* (
      input: Parameters<RunObserver["phaseStarted"]>[0],
    ) {
      const timestamp = new Date(yield* Clock.currentTimeMillis).toISOString();
      const artifactPath = observationArtifactPath(context, input);
      yield* writer.write({
        type: "phase_started",
        timestamp,
        issueNumber: context.issueNumber,
        attempt: context.attempt,
        phase: input.phase,
        label: input.label,
        artifactPath,
        model: input.model,
        thinkingLevel: input.thinkingLevel,
      });
      yield* updateRunSummary(context, (summary) => {
        const existing = summary.phases[input.phase];
        summary.phases[input.phase] = {
          ...existing,
          phase: input.phase,
          label: input.label ?? existing?.label,
          status: "running",
          startedAt: timestamp,
          endedAt: undefined,
          durationMs: undefined,
          artifactPath: artifactPath ?? existing?.artifactPath,
          model: input.model ?? existing?.model,
          thinkingLevel: input.thinkingLevel ?? existing?.thinkingLevel,
          requestedThinkingLevel:
            input.thinkingLevel ?? existing?.requestedThinkingLevel,
          totals: existing?.totals ?? emptyTotals(),
        };
      });
    }),
    phaseCompleted: Effect.fn("RunObserver.phaseCompleted")(function* (
      input: Parameters<RunObserver["phaseCompleted"]>[0],
    ) {
      const timestamp = new Date(yield* Clock.currentTimeMillis).toISOString();
      const artifactPath = observationArtifactPath(context, input);
      yield* writer.write({
        type: input.reused === true ? "phase_skipped" : "phase_completed",
        timestamp,
        issueNumber: context.issueNumber,
        attempt: context.attempt,
        phase: input.phase,
        label: input.label,
        artifactPath,
        model: input.model,
        thinkingLevel: input.thinkingLevel,
        reused: input.reused,
      });
      yield* updateRunSummary(context, (summary) => {
        const existing = summary.phases[input.phase];
        summary.phases[input.phase] = {
          ...existing,
          phase: input.phase,
          label: input.label ?? existing?.label,
          status: input.reused === true ? "skipped" : "completed",
          startedAt: existing?.startedAt ?? timestamp,
          endedAt: timestamp,
          artifactPath: artifactPath ?? existing?.artifactPath,
          model: input.model ?? existing?.model,
          thinkingLevel:
            existing?.effectiveThinkingLevel ??
            input.thinkingLevel ??
            existing?.thinkingLevel,
          requestedThinkingLevel:
            existing?.requestedThinkingLevel ?? input.thinkingLevel,
          reused: input.reused,
          totals: existing?.totals ?? emptyTotals(),
        };
      });
    }),
    phaseFailed: Effect.fn("RunObserver.phaseFailed")(function* (
      input: Parameters<RunObserver["phaseFailed"]>[0],
    ) {
      const timestamp = new Date(yield* Clock.currentTimeMillis).toISOString();
      const errorMessage = formatErrorMessage(input.error);
      const artifactPath = observationArtifactPath(context, input);
      yield* writer.write({
        type: "phase_failed",
        timestamp,
        issueNumber: context.issueNumber,
        attempt: context.attempt,
        phase: input.phase,
        label: input.label,
        artifactPath,
        model: input.model,
        thinkingLevel: input.thinkingLevel,
        errorMessage,
      });
      yield* updateRunSummary(context, (summary) => {
        const existing = summary.phases[input.phase];
        summary.phases[input.phase] = {
          ...existing,
          phase: input.phase,
          label: input.label ?? existing?.label,
          status: "failed",
          startedAt: existing?.startedAt ?? timestamp,
          endedAt: timestamp,
          artifactPath: artifactPath ?? existing?.artifactPath,
          model: input.model ?? existing?.model,
          thinkingLevel:
            existing?.effectiveThinkingLevel ??
            input.thinkingLevel ??
            existing?.thinkingLevel,
          requestedThinkingLevel:
            existing?.requestedThinkingLevel ?? input.thinkingLevel,
          errorMessage,
          totals: existing?.totals ?? emptyTotals(),
        };
        summary.lastError = errorMessage;
      });
    }),
    agentSessionStarted: Effect.fn("RunObserver.agentSessionStarted")(
      function* (input: Parameters<RunObserver["agentSessionStarted"]>[0]) {
        const effectiveThinkingLevel =
          input.effectiveThinkingLevel ?? input.thinkingLevel;
        yield* writer.write({
          type: "agent_session_started",
          issueNumber: context.issueNumber,
          attempt: context.attempt,
          phase: input.phase,
          sessionId: input.sessionId,
          model: input.model,
          thinkingLevel: effectiveThinkingLevel,
          requestedThinkingLevel: input.requestedThinkingLevel,
          effectiveThinkingLevel,
        });
        yield* updateRunSummary(context, (summary) => {
          const existing = summary.phases[input.phase];
          summary.phases[input.phase] = {
            phase: input.phase,
            status: existing?.status ?? "running",
            ...existing,
            sessionId: input.sessionId,
            model: input.model ?? existing?.model,
            thinkingLevel: effectiveThinkingLevel ?? existing?.thinkingLevel,
            requestedThinkingLevel:
              input.requestedThinkingLevel ?? existing?.requestedThinkingLevel,
            effectiveThinkingLevel:
              effectiveThinkingLevel ?? existing?.effectiveThinkingLevel,
          };
        });
      },
    ),
    agentSessionStats: Effect.fn("RunObserver.agentSessionStats")(function* (
      input: Parameters<RunObserver["agentSessionStats"]>[0],
    ) {
      const totals = totalsFromSessionStats(input.stats);
      yield* writer.write({
        type: "agent_session_stats",
        issueNumber: context.issueNumber,
        attempt: context.attempt,
        phase: input.phase,
        sessionId: input.stats.sessionId,
        totals,
      });
      yield* updateRunSummary(context, (summary) => {
        const existing = summary.phases[input.phase];
        summary.phases[input.phase] = {
          phase: input.phase,
          status: existing?.status ?? "running",
          ...existing,
          sessionId: input.stats.sessionId ?? existing?.sessionId,
          totals: addTotals(existing?.totals ?? emptyTotals(), totals),
        };
      });
    }),
    toolStarted: Effect.fn("RunObserver.toolStarted")(function* (
      input: Parameters<RunObserver["toolStarted"]>[0],
    ) {
      yield* writer.write({
        type: "tool_started",
        issueNumber: context.issueNumber,
        attempt: context.attempt,
        phase: input.phase,
        sessionId: input.sessionId,
        toolCallId: input.toolCallId,
        toolName: input.toolName,
      });
    }),
    toolCompleted: Effect.fn("RunObserver.toolCompleted")(function* (
      input: Parameters<RunObserver["toolCompleted"]>[0],
    ) {
      yield* writer.write({
        type: "tool_completed",
        issueNumber: context.issueNumber,
        attempt: context.attempt,
        phase: input.phase,
        sessionId: input.sessionId,
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        durationMs: input.durationMs,
        isError: input.isError,
      });
    }),
    autoRetryStarted: Effect.fn("RunObserver.autoRetryStarted")(function* (
      input: Parameters<RunObserver["autoRetryStarted"]>[0],
    ) {
      yield* writer.write({
        type: "auto_retry_started",
        issueNumber: context.issueNumber,
        attempt: context.attempt,
        phase: input.phase,
        sessionId: input.sessionId,
        retryAttempt: input.attempt,
        maxAttempts: input.maxAttempts,
        delayMs: input.delayMs,
        errorMessage: input.errorMessage,
      });
    }),
    autoRetryCompleted: Effect.fn("RunObserver.autoRetryCompleted")(function* (
      input: Parameters<RunObserver["autoRetryCompleted"]>[0],
    ) {
      yield* writer.write({
        type: "auto_retry_completed",
        issueNumber: context.issueNumber,
        attempt: context.attempt,
        phase: input.phase,
        sessionId: input.sessionId,
        retryAttempt: input.attempt,
        success: input.success,
        finalError: input.finalError,
      });
    }),
  };
}

function observationArtifactPath(
  context: WorkflowContext,
  input: PhaseObservation,
): string | undefined {
  if (input.artifactPath !== undefined) return input.artifactPath;
  if (input.artifact === undefined) return undefined;
  return artifactRelativePath(context, input.artifact);
}

export function phaseNameForArtifact(artifact: ArtifactRef): string {
  return formatArtifactRef(artifact);
}

export class RunObservation extends Context.Service<
  RunObservation,
  RunObserver
>()("roark/observability/RunObservation") {}
export const runObservationLayer = Layer.succeed(
  RunObservation,
  createNoopRunObserver(),
);
