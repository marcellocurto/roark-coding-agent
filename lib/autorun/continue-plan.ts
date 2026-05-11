import { inferNextFixPass, readArtifact, type WorkflowContext } from "../workflow/artifacts.ts";
import {
  planWorkflowProgression,
  type WorkflowProgressionAction,
} from "../workflow/progression.ts";
import type { AttemptOutcome } from "./attempts.ts";
import { classifyVerificationFailure, parseVerificationArtifact } from "./verification.ts";

export type ContinuePlanStep = WorkflowProgressionAction;

export type PlanContinuationOptions = {
  attemptOutcome?: AttemptOutcome;
};

export async function planContinuation(
  context: WorkflowContext,
  options: PlanContinuationOptions = {},
): Promise<ContinuePlanStep[]> {
  const verificationRepair = await planFailedVerificationContinuation(context, options);
  if (verificationRepair) return verificationRepair;

  const progression = await planWorkflowProgression(context, {
    includePublishGate: true,
    force: context.force,
  });
  return progression.actions;
}

async function planFailedVerificationContinuation(
  context: WorkflowContext,
  options: PlanContinuationOptions,
): Promise<ContinuePlanStep[] | undefined> {
  if (context.force || options.attemptOutcome !== "failed-verification") return undefined;
  const failedVerification = await readFailedVerificationArtifact(context);
  if (!failedVerification) return undefined;

  const classification = classifyVerificationFailure(failedVerification);
  if (!classification.repairable) {
    return [{
      type: "noop",
      reason: classification.recoveryGuidance
        ? `${classification.reason}; ${classification.recoveryGuidance}`
        : classification.reason,
    }];
  }

  const pass = safeInferNextFixPass(context);
  if (pass === undefined) return undefined;
  if (pass > context.maxFixPasses) {
    return [{
      type: "noop",
      reason: "verification failed and maximum fix passes reached; human action required or pass --force to rerun gates",
    }];
  }

  return [
    { type: "run", phase: "fix", pass, reason: "verification failed; repair within remaining fix budget" },
    { type: "run", phase: "final-review", pass, reason: "final review depends on verification repair" },
    { type: "write-readiness", reason: "workflow must recompute readiness after verification repair" },
    { type: "publish-gate", reason: "publish gate must rerun after verification repair" },
  ];
}

function safeInferNextFixPass(context: WorkflowContext): number | undefined {
  try {
    return inferNextFixPass(context);
  } catch {
    return undefined;
  }
}

async function readFailedVerificationArtifact(context: WorkflowContext) {
  try {
    const result = parseVerificationArtifact(await readArtifact(context, "verification"));
    if (!result || result.ok) return undefined;
    return result;
  } catch {
    return undefined;
  }
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
