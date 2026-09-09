import type { ArtifactStore } from "../workflow/artifact-store.ts";
import { Effect, type PlatformError } from "effect";
import { type WorkflowContext } from "../workflow/artifacts.ts";
import { inferNextFixPass } from "../workflow/artifacts.ts";
import { readArtifact } from "../workflow/artifacts.ts";
import { type WorkflowProgressionAction } from "../workflow/progression.ts";
import { planWorkflowProgression } from "../workflow/progression.ts";
import type { AttemptOutcome } from "./attempts.ts";
import {
  classifyVerificationFailure,
  parseVerificationArtifact,
} from "./verification.ts";
export type ContinuePlanStep = WorkflowProgressionAction;
export interface PlanContinuationOptions {
  attemptOutcome?: AttemptOutcome | undefined;
}
export const planContinuation = Effect.fn("planContinuation")(function* (
  context: WorkflowContext,
  options: PlanContinuationOptions = {},
) {
  const verificationRepair = yield* planFailedVerificationContinuation(
    context,
    options,
  );
  if (verificationRepair) return verificationRepair;
  const progression = yield* planWorkflowProgression(context, {
    includePublishGate: true,
    force: context.force,
  });
  return progression.actions;
});
const planFailedVerificationContinuation = Effect.fn(
  "planFailedVerificationContinuation",
)(function* (
  context: WorkflowContext,
  options: PlanContinuationOptions,
): Effect.fn.Return<
  ContinuePlanStep[] | undefined,
  PlatformError.PlatformError,
  ArtifactStore
> {
  if (context.force || options.attemptOutcome !== "failed-verification")
    return undefined;
  const failedVerification = yield* readFailedVerificationArtifact(context);
  if (!failedVerification) return undefined;
  const classification = classifyVerificationFailure(failedVerification);
  if (!classification.repairable) {
    return [
      {
        type: "noop",
        reason: classification.recoveryGuidance
          ? `${classification.reason}; ${classification.recoveryGuidance}`
          : classification.reason,
      },
    ];
  }
  const pass = yield* safeInferNextFixPass(context);
  if (pass === undefined) return undefined;
  if (pass > context.maxFixPasses) {
    return [
      {
        type: "noop",
        reason:
          "verification failed and maximum fix passes reached; human action required or pass --force to rerun gates",
      },
    ];
  }
  return [
    {
      type: "run",
      phase: "fix",
      pass,
      reason: "verification failed; repair within remaining fix budget",
    },
    {
      type: "run",
      phase: "refine-code",
      pass,
      reason: "refinement depends on verification repair",
    },
    {
      type: "run",
      phase: "review-a",
      pass,
      reason: "review A depends on refinement",
    },
    {
      type: "run",
      phase: "review-b",
      pass,
      reason: "review B depends on refinement",
    },
    {
      type: "write-readiness",
      reason: "workflow must recompute readiness after verification repair",
    },
    {
      type: "publish-gate",
      reason: "publish gate must rerun after verification repair",
    },
  ];
});
const safeInferNextFixPass = Effect.fn("safeInferNextFixPass")(function* (
  context: WorkflowContext,
) {
  return yield* Effect.gen(function* () {
    return yield* inferNextFixPass(context);
  }).pipe(
    Effect.catch(
      Effect.fnUntraced(function* () {
        return undefined;
      }),
    ),
  );
});
const readFailedVerificationArtifact = Effect.fn(
  "readFailedVerificationArtifact",
)(function* (context: WorkflowContext) {
  return yield* Effect.gen(function* () {
    const result = parseVerificationArtifact(
      yield* readArtifact(context, "verification"),
    );
    if (!result || result.ok) return undefined;
    return result;
  }).pipe(
    Effect.catch(
      Effect.fnUntraced(function* () {
        return undefined;
      }),
    ),
  );
});
export function formatContinuationPlan(
  steps: readonly ContinuePlanStep[],
): string[] {
  return steps.map((step) => {
    if (step.type === "run") {
      const suffix = step.pass === undefined ? "" : ` pass ${step.pass}`;
      return `- run ${step.phase}${suffix}: ${step.reason}`;
    }
    if (step.type === "write-readiness")
      return `- write readiness: ${step.reason}`;
    if (step.type === "publish-gate")
      return `- run publish gate: ${step.reason}`;
    return `- no-op: ${step.reason}`;
  });
}
