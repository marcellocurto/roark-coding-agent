import type { WorkflowContext } from "../workflow/artifacts.ts";
import {
  planWorkflowProgression,
  type WorkflowProgressionAction,
} from "../workflow/progression.ts";

export type ContinuePlanStep = WorkflowProgressionAction;

export async function planContinuation(context: WorkflowContext): Promise<ContinuePlanStep[]> {
  const progression = await planWorkflowProgression(context, {
    includePublishGate: true,
    force: context.force,
  });
  return progression.actions;
}

export function formatContinuationPlan(steps: readonly ContinuePlanStep[]): string[] {
  return steps.map((step) => {
    if (step.type === "run") {
      const suffix = step.pass === undefined ? "" : ` pass ${step.pass}`;
      return `- run ${step.phase}${suffix}: ${step.reason}`;
    }
    if (step.type === "write-readiness") return `- write readiness: ${step.reason}`;
    if (step.type === "publish-gate") return `- run publish gate: ${step.reason}`;
    return `- no-op: ${step.reason}`;
  });
}
