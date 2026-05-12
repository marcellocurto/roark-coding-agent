import { createEventWriter, type EventWriter } from "./events.ts";
import type { ArtifactRef, WorkflowContext } from "../workflow/artifacts.ts";
import { artifactRelativePath, formatArtifactRef } from "../workflow/artifacts.ts";
import {
  addTotals,
  emptyTotals,
  formatErrorMessage,
  totalsFromSessionStats,
  updateRunSummary,
  type SessionStatsLike,
} from "./summary.ts";

export interface RunObserver {
  runStarted(input?: { command?: string; recoveryCommand?: string  | undefined}): Promise<void>;
  runCompleted(input?: { status?: string }): Promise<void>;
  runFailed(error: unknown): Promise<void>;
  phaseStarted(input: PhaseObservation): Promise<void>;
  phaseCompleted(input: PhaseObservation & { reused?: boolean }): Promise<void>;
  phaseFailed(input: PhaseObservation & { error: unknown }): Promise<void>;
  agentSessionStarted(input: AgentSessionObservation): Promise<void>;
  agentSessionStats(input: AgentSessionStatsObservation): Promise<void>;
  toolStarted(input: ToolObservation): Promise<void>;
  toolCompleted(input: ToolObservation & { durationMs?: number | undefined; isError?: boolean }): Promise<void>;
  autoRetryStarted(input: AutoRetryObservation): Promise<void>;
  autoRetryCompleted(input: AutoRetryObservation & { success?: boolean; finalError?: string  | undefined}): Promise<void>;
}

export interface PhaseObservation {
  phase: string;
  label?: string | undefined;
  artifact?: ArtifactRef | undefined;
  artifactPath?: string | undefined;
  model?: string | undefined  ;
  thinkingLevel?: string | undefined  ;
}

export interface AgentSessionObservation {
  phase: string;
  sessionId: string;
  model?: string | undefined  ;
  thinkingLevel?: string | undefined  ;
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
  const noop = () => Promise.resolve();
  return {
    runStarted: noop,
    runCompleted: noop,
    runFailed: noop,
    phaseStarted: noop,
    phaseCompleted: noop,
    phaseFailed: noop,
    agentSessionStarted: noop,
    agentSessionStats: noop,
    toolStarted: noop,
    toolCompleted: noop,
    autoRetryStarted: noop,
    autoRetryCompleted: noop,
  };
}

export function createFileRunObserver(context: WorkflowContext): RunObserver {
  const writer = createEventWriter(context.runDir);
  return createRunObserver(context, writer);
}

function createRunObserver(context: WorkflowContext, writer: EventWriter): RunObserver {
  return {
    async runStarted(input = {}) {
      const timestamp = new Date().toISOString();
      await writer.write({
        type: "run_started",
        timestamp,
        issueNumber: context.issueNumber,
        attempt: context.attempt,
        command: input.command,
        runDir: context.runDirRelative,
        recoveryCommand: input.recoveryCommand,
      });
      await updateRunSummary(context, (summary) => {
        summary.status = "running";
        summary.startedAt = timestamp;
        summary.endedAt = undefined;
        summary.durationMs = undefined;
        summary.phases = {};
        summary.totals = emptyTotals();
        if (input.recoveryCommand) summary.recoveryCommand = input.recoveryCommand;
        summary.lastError = undefined;
      });
    },
    async runCompleted(input = {}) {
      const timestamp = new Date().toISOString();
      const status = input.status ?? "completed";
      await writer.write({ type: "run_completed", timestamp, issueNumber: context.issueNumber, attempt: context.attempt, status });
      await updateRunSummary(context, (summary) => {
        summary.status = status === "completed" ? "completed" : "stopped";
        summary.endedAt = timestamp;
      });
    },
    async runFailed(error) {
      const timestamp = new Date().toISOString();
      const errorMessage = formatErrorMessage(error);
      await writer.write({ type: "run_failed", timestamp, issueNumber: context.issueNumber, attempt: context.attempt, errorMessage });
      await updateRunSummary(context, (summary) => {
        summary.status = "failed";
        summary.endedAt = timestamp;
        summary.lastError = errorMessage;
      });
    },
    async phaseStarted(input) {
      const timestamp = new Date().toISOString();
      const artifactPath = observationArtifactPath(context, input);
      await writer.write({
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
      await updateRunSummary(context, (summary) => {
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
          totals: existing?.totals ?? emptyTotals(),
        };
      });
    },
    async phaseCompleted(input) {
      const timestamp = new Date().toISOString();
      const artifactPath = observationArtifactPath(context, input);
      await writer.write({
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
      await updateRunSummary(context, (summary) => {
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
          thinkingLevel: input.thinkingLevel ?? existing?.thinkingLevel,
          reused: input.reused,
          totals: existing?.totals ?? emptyTotals(),
        };
      });
    },
    async phaseFailed(input) {
      const timestamp = new Date().toISOString();
      const errorMessage = formatErrorMessage(input.error);
      const artifactPath = observationArtifactPath(context, input);
      await writer.write({
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
      await updateRunSummary(context, (summary) => {
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
          thinkingLevel: input.thinkingLevel ?? existing?.thinkingLevel,
          errorMessage,
          totals: existing?.totals ?? emptyTotals(),
        };
        summary.lastError = errorMessage;
      });
    },
    async agentSessionStarted(input) {
      await writer.write({
        type: "agent_session_started",
        issueNumber: context.issueNumber,
        attempt: context.attempt,
        phase: input.phase,
        sessionId: input.sessionId,
        model: input.model,
        thinkingLevel: input.thinkingLevel,
      });
      await updateRunSummary(context, (summary) => {
        const existing = summary.phases[input.phase];
        summary.phases[input.phase] = {
          phase: input.phase,
          status: existing?.status ?? "running",
          ...existing,
          sessionId: input.sessionId,
          model: input.model ?? existing?.model,
          thinkingLevel: input.thinkingLevel ?? existing?.thinkingLevel,
        };
      });
    },
    async agentSessionStats(input) {
      const totals = totalsFromSessionStats(input.stats);
      await writer.write({
        type: "agent_session_stats",
        issueNumber: context.issueNumber,
        attempt: context.attempt,
        phase: input.phase,
        sessionId: input.stats.sessionId,
        totals,
      });
      await updateRunSummary(context, (summary) => {
        const existing = summary.phases[input.phase];
        summary.phases[input.phase] = {
          phase: input.phase,
          status: existing?.status ?? "running",
          ...existing,
          sessionId: input.stats.sessionId ?? existing?.sessionId,
          totals: addTotals(existing?.totals ?? emptyTotals(), totals),
        };
      });
    },
    async toolStarted(input) {
      await writer.write({
        type: "tool_started",
        issueNumber: context.issueNumber,
        attempt: context.attempt,
        phase: input.phase,
        sessionId: input.sessionId,
        toolCallId: input.toolCallId,
        toolName: input.toolName,
      });
    },
    async toolCompleted(input) {
      await writer.write({
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
    },
    async autoRetryStarted(input) {
      await writer.write({
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
    },
    async autoRetryCompleted(input) {
      await writer.write({
        type: "auto_retry_completed",
        issueNumber: context.issueNumber,
        attempt: context.attempt,
        phase: input.phase,
        sessionId: input.sessionId,
        retryAttempt: input.attempt,
        success: input.success,
        finalError: input.finalError,
      });
    },
  };
}

function observationArtifactPath(context: WorkflowContext, input: PhaseObservation): string | undefined {
  if (input.artifactPath !== undefined) return input.artifactPath;
  if (input.artifact === undefined) return undefined;
  return artifactRelativePath(context, input.artifact);
}

export function phaseNameForArtifact(artifact: ArtifactRef): string {
  return formatArtifactRef(artifact);
}
