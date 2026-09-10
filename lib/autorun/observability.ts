import { DateTime, Effect } from "effect";
import { createEventWriter } from "../observability/events.ts";
import { updateRunSummary, type RunStatus } from "../observability/summary.ts";
import type { WorkflowContext } from "../workflow/artifacts.ts";
import type { AttemptOutcome } from "./attempts.ts";

export interface FinalizeAttemptObservabilityInput {
  context: WorkflowContext;
  outcome: AttemptOutcome;
  outcomeDetail: string | null;
  endedAt?: Date | string | undefined;
}

export const finalizeAttemptObservability = Effect.fn(
  "finalizeAttemptObservability",
)(function* (input: FinalizeAttemptObservabilityInput) {
  const { context, outcome, outcomeDetail } = input;
  const timestamp =
    input.endedAt === undefined
      ? DateTime.formatIso(yield* DateTime.now)
      : toIsoString(input.endedAt);
  const status = runStatusForAttemptOutcome(outcome);
  const writer = yield* createEventWriter(context.runDir);

  yield* writer.write({
    type: eventTypeForRunStatus(status),
    timestamp,
    issueNumber: context.issueNumber,
    attempt: context.attempt,
    runDir: context.runDirRelative,
    outcome,
    status,
    outcomeDetail,
  });

  yield* updateRunSummary(context, (summary) => {
    summary.status = status;
    if (status === "running") {
      summary.endedAt = undefined;
      summary.durationMs = undefined;
    } else {
      summary.endedAt = timestamp;
    }

    if (status === "failed" && outcomeDetail) summary.lastError = outcomeDetail;
    else if (status !== "failed") summary.lastError = undefined;
  });
});

export function runStatusForAttemptOutcome(outcome: AttemptOutcome): RunStatus {
  if (outcome === "in-progress") return "running";
  if (outcome === "published") return "completed";
  if (
    outcome === "continuation-stopped" ||
    outcome === "triage-stopped" ||
    outcome === "planning-stopped" ||
    outcome === "execution-stopped"
  )
    return "stopped";
  return "failed";
}

function eventTypeForRunStatus(status: RunStatus): string {
  if (status === "completed") return "attempt_completed";
  if (status === "stopped") return "attempt_stopped";
  if (status === "failed") return "attempt_failed";
  return "attempt_updated";
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}
