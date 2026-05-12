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

export async function finalizeAttemptObservability(input: FinalizeAttemptObservabilityInput): Promise<void> {
  const { context, outcome, outcomeDetail } = input;
  const timestamp = toIsoString(input.endedAt ?? new Date());
  const status = runStatusForAttemptOutcome(outcome);
  const writer = createEventWriter(context.runDir);

  await writer.write({
    type: eventTypeForRunStatus(status),
    timestamp,
    issueNumber: context.issueNumber,
    attempt: context.attempt,
    runDir: context.runDirRelative,
    outcome,
    status,
    outcomeDetail,
  });

  await updateRunSummary(context, (summary) => {
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
}

export function runStatusForAttemptOutcome(outcome: AttemptOutcome): RunStatus {
  if (outcome === "in-progress") return "running";
  if (outcome === "published") return "completed";
  if (outcome === "triage-stopped") return "stopped";
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
