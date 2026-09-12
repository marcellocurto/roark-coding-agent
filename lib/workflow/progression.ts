import { Effect } from "effect";
import {
  baselineResetLogRef,
  fixLogRef,
  implementationRestartLogRef,
  refinementLogRef,
  reviewARef,
  reviewBRef,
  type ArtifactRef,
  type WorkflowContext,
} from "./artifacts.ts";
import { artifactExists } from "./artifacts.ts";
import { readArtifact } from "./artifacts.ts";
import { validateAgentArtifact } from "./artifact-validation.ts";
import type { WorkflowRunPhase } from "./phase-vocabulary.ts";
import {
  hasBlockedReview,
  needsFix,
  needsRestart,
  shouldImplementPlan,
} from "./verdicts.ts";
import { parseReviewResultJson } from "../review/result.ts";
import { parseTriageResultJson, type TriageVerdict } from "../triage/result.ts";
import {
  parseImplementationPlanResultJson,
  requireImplementationPlanSource,
} from "../implementation-plan/result.ts";
import { parseChangeReportJson } from "../change-report/result.ts";
import { ArtifactContractError } from "../structured-output/contract.ts";
import { readContinuationState } from "../issue-continuation/checkpoint.ts";
import {
  readExecutionStop,
  type ExecutionStopArtifact,
} from "./execution-stop.ts";
export type WorkflowProgressionAction =
  | {
      type: "run";
      phase: WorkflowRunPhase;
      pass?: number | undefined;
      reason: string;
    }
  | {
      type: "write-readiness";
      reason: string;
    }
  | {
      type: "publish-gate";
      reason: string;
    }
  | {
      type: "noop";
      reason: string;
    };
export type WorkflowTerminalStatus =
  | { status: "continuation-stopped" }
  | {
      status: "triage-stopped";
      triageVerdict: Exclude<TriageVerdict, "proceed">;
    }
  | {
      status: "planning-stopped";
      planningArtifact?: "implementationPlanDraft" | "implementationPlan";
    }
  | {
      status: "execution-stopped";
      artifact: ExecutionStopArtifact;
    }
  | {
      status: "review-blocked";
    }
  | {
      status: "fix-budget-exhausted";
    }
  | {
      status: "completed";
    };
export interface WorkflowProgressionPlan {
  actions: WorkflowProgressionAction[];
  terminalStatus?: WorkflowTerminalStatus | undefined;
}
export interface WorkflowProgressionOptions {
  includePublishGate?: boolean | undefined;
  force?: boolean | undefined;
  completedActions?: readonly WorkflowProgressionAction[] | undefined;
}
export function issueArtifactHasRelationshipSnapshot(content: string): boolean {
  return /<github_issue_relationships\b/.test(content);
}
export const planWorkflowProgression = Effect.fn("planWorkflowProgression")(
  function* (
    context: WorkflowContext,
    options: WorkflowProgressionOptions = {},
  ) {
    const continuation = yield* readContinuationState(context);
    if (continuation && continuation.status !== "ready")
      return terminal(
        [
          readiness(
            "continuation is waiting for an answer or must finish checking new feedback",
          ),
          noop("run continue to check the latest issue discussion"),
        ],
        { status: "continuation-stopped" },
      );
    if (options.force !== true) {
      const stoppedArtifact = yield* readExecutionStop(context);
      if (stoppedArtifact !== undefined)
        return stoppedExecution(stoppedArtifact);
    }
    const issue = yield* inspect(context, "issue", options);
    if (!issue.valid) return issuePrerequisitePlan(issue.reason, options);
    if (!issueArtifactHasRelationshipSnapshot(issue.content ?? "")) {
      return issuePrerequisitePlan(
        "issue artifact lacks GitHub relationship snapshot",
        options,
      );
    }
    const triage = yield* inspect(context, "triage", options);
    if (!triage.valid) {
      return pending([
        run("triage", triage.reason),
        run("plan-draft", "plan draft depends on triage"),
        run("plan", "plan refinement depends on plan draft"),
        run("capture-baseline", "baseline capture depends on refined plan"),
        run("implement", "implementation depends on plan"),
        run("refine-code", "refinement depends on implementation", 0),
        run("review-a", "review A depends on refinement", 0),
        run("review-b", "review B depends on refinement", 0),
        readiness("workflow must recompute readiness"),
        ...publishGate(options, "publish gate must run after readiness"),
      ]);
    }
    const triageResult = yield* parseTriageResultJson(triage.content ?? "");
    if (triageResult.verdict !== "proceed") {
      const verdict = triageResult.verdict;
      return terminal(
        [
          readiness(
            `triage verdict is "${verdict}"; readiness records the stop`,
          ),
          noop("terminal triage outcome; no plan/implementation/publish gate"),
        ],
        { status: "triage-stopped", triageVerdict: verdict },
      );
    }
    if (triageResult.planAction === "draft") {
      const planDraft = yield* inspect(
        context,
        "implementationPlanDraft",
        options,
      );
      if (!planDraft.valid) {
        return pending([
          run("plan-draft", planDraft.reason),
          run("plan", "plan refinement depends on plan draft"),
          run("capture-baseline", "baseline capture depends on refined plan"),
          run("implement", "implementation depends on plan"),
          run("refine-code", "refinement depends on implementation", 0),
          run("review-a", "review A depends on refinement", 0),
          run("review-b", "review B depends on refinement", 0),
          readiness("workflow must recompute readiness"),
          ...publishGate(options, "publish gate must run after readiness"),
        ]);
      }
      if (
        !(yield* parseImplementationPlanResultJson(planDraft.content ?? ""))
          .readyForImplementation
      ) {
        return terminal(
          [
            readiness(
              "draft planning stopped; resolve its questions or external blockers",
            ),
            noop(
              "terminal planning outcome; no acceptance/implementation/publish gate",
            ),
          ],
          {
            status: "planning-stopped",
            planningArtifact: "implementationPlanDraft",
          },
        );
      }
    }
    const plan = yield* inspect(context, "implementationPlan", options);
    if (!plan.valid) {
      return pending([
        run("plan", plan.reason),
        run("capture-baseline", "baseline capture depends on refined plan"),
        run("implement", "implementation depends on plan"),
        run("refine-code", "refinement depends on implementation", 0),
        run("review-a", "review A depends on refinement", 0),
        run("review-b", "review B depends on refinement", 0),
        readiness("workflow must recompute readiness"),
        ...publishGate(options, "publish gate must run after readiness"),
      ]);
    }
    const acceptedPlan = yield* requireImplementationPlanSource(
      yield* parseImplementationPlanResultJson(plan.content ?? ""),
      triageResult,
    );
    if (!shouldImplementPlan(acceptedPlan)) {
      return terminal(
        [
          readiness(
            "implementation plan is not ready; readiness records the stop",
          ),
          noop("terminal planning outcome; no implementation/publish gate"),
        ],
        { status: "planning-stopped" },
      );
    }
    const baseline = yield* inspect(
      context,
      "preImplementationBaseline",
      options,
    );
    if (!baseline.valid) {
      return pending([
        run("capture-baseline", baseline.reason),
        run(
          "implement",
          "implementation depends on pre-implementation baseline",
        ),
        run("refine-code", "refinement depends on implementation", 0),
        run("review-a", "review A depends on refinement", 0),
        run("review-b", "review B depends on refinement", 0),
        readiness("workflow must recompute readiness"),
        ...publishGate(options, "publish gate must run after readiness"),
      ]);
    }
    const implementation = yield* inspect(
      context,
      "implementationLog",
      options,
    );
    if (!implementation.valid) {
      return pending([
        run("implement", implementation.reason),
        run("refine-code", "refinement depends on implementation", 0),
        run("review-a", "review A depends on refinement", 0),
        run("review-b", "review B depends on refinement", 0),
        readiness("workflow must recompute readiness"),
        ...publishGate(options, "publish gate must run after readiness"),
      ]);
    }
    const implementationStop = yield* executionStop(
      context,
      "implementationLog",
    );
    if (implementationStop) return implementationStop;
    const resumedPass =
      continuation?.status === "ready" &&
      ["fix", "refine-code", "review"].includes(continuation.resumeFrom)
        ? (continuation.pass ?? 0)
        : 0;
    if (resumedPass > context.maxFixPasses)
      return yield* Effect.fail(
        new ArtifactContractError({
          artifact: "Continuation",
          message: `Saved work is at pass ${resumedPass}. Set --max-fix-passes to at least ${resumedPass}, or use continue --restart to start over.`,
        }),
      );
    if (resumedPass > 0 && continuation?.resumeFrom === "fix") {
      const fix = yield* inspect(context, fixLogRef(resumedPass), options);
      if (!fix.valid)
        return pending([run("fix", "resume the saved fix pass", resumedPass)]);
      const stop = yield* executionStop(context, fixLogRef(resumedPass));
      if (stop) return stop;
    }
    return yield* reviewCycleProgression(context, options, resumedPass);
  },
);
const reviewCycleProgression = Effect.fn("reviewCycleProgression")(function* (
  context: WorkflowContext,
  options: WorkflowProgressionOptions,
  initialPass: number,
) {
  for (let pass = initialPass; pass <= context.maxFixPasses; pass++) {
    const refinement = yield* inspect(context, refinementLogRef(pass), options);
    if (!refinement.valid) {
      return pending([
        run("refine-code", refinement.reason, pass),
        run("review-a", "review A depends on refinement", pass),
        run("review-b", "review B depends on refinement", pass),
        readiness("workflow must recompute readiness"),
        ...publishGate(options, "publish gate must run after readiness"),
      ]);
    }
    const refinementStop = yield* executionStop(
      context,
      refinementLogRef(pass),
    );
    if (refinementStop) return refinementStop;
    const reviewA = yield* inspect(context, reviewARef(pass), options);
    const reviewB = yield* inspect(context, reviewBRef(pass), options);
    const reviewActions: WorkflowProgressionAction[] = [];
    if (!reviewA.valid)
      reviewActions.push(run("review-a", reviewA.reason, pass));
    if (!reviewB.valid)
      reviewActions.push(run("review-b", reviewB.reason, pass));
    if (reviewActions.length > 0) {
      return pending([
        ...reviewActions,
        readiness("workflow must recompute readiness"),
        ...publishGate(options, "publish gate must run after readiness"),
      ]);
    }
    const reviewAResult = yield* parseReviewResultJson(reviewA.content ?? "", {
      allowRestart: true,
    });
    const reviewBResult = yield* parseReviewResultJson(reviewB.content ?? "", {
      allowRestart: true,
    });
    const nextPass = pass + 1;
    if (needsRestart(reviewAResult, reviewBResult)) {
      if (nextPass > context.maxFixPasses) return maxPassesReached(options);
      const reset = yield* inspect(
        context,
        baselineResetLogRef(nextPass),
        options,
      );
      if (!reset.valid) {
        return pending([
          run("reset-baseline", reset.reason, nextPass),
          run(
            "implement",
            "implementation restart depends on baseline reset",
            nextPass,
          ),
          run(
            "refine-code",
            "refinement depends on restarted implementation",
            nextPass,
          ),
          run("review-a", "review A depends on refinement", nextPass),
          run("review-b", "review B depends on refinement", nextPass),
          readiness("workflow must recompute readiness"),
          ...publishGate(options, "publish gate must run after readiness"),
        ]);
      }
      if (yield* reviewCycleProgressExists(context, nextPass)) continue;
      const restartImplementation = yield* inspect(
        context,
        implementationRestartLogRef(nextPass),
        options,
      );
      if (!restartImplementation.valid) {
        return pending([
          run(
            "implement",
            restartImplementation.reason === "artifact is missing"
              ? "implementation restart depends on baseline reset"
              : restartImplementation.reason,
            nextPass,
          ),
          run(
            "refine-code",
            "refinement depends on restarted implementation",
            nextPass,
          ),
          run("review-a", "review A depends on refinement", nextPass),
          run("review-b", "review B depends on refinement", nextPass),
          readiness("workflow must recompute readiness"),
          ...publishGate(options, "publish gate must run after readiness"),
        ]);
      }
      continue;
    }
    if (needsFix(reviewAResult, reviewBResult)) {
      if (nextPass > context.maxFixPasses) return maxPassesReached(options);
      const fix = yield* inspect(context, fixLogRef(nextPass), options);
      if (!fix.valid) {
        return pending([
          run("fix", fix.reason, nextPass),
          run("refine-code", "refinement depends on fix", nextPass),
          run("review-a", "review A depends on refinement", nextPass),
          run("review-b", "review B depends on refinement", nextPass),
          readiness("workflow must recompute readiness"),
          ...publishGate(options, "publish gate must run after readiness"),
        ]);
      }
      const fixStop = yield* executionStop(context, fixLogRef(nextPass));
      if (fixStop) return fixStop;
      continue;
    }
    if (hasBlockedReview(reviewAResult, reviewBResult)) {
      return terminal(
        [
          readiness(
            "a review remains externally blocked after all available local fixes; readiness records the stop",
          ),
          ...publishGate(options, "publish gate records non-publish"),
        ],
        { status: "review-blocked" },
      );
    }
    return terminal(
      [
        readiness(
          pass === 0
            ? "reviews approve; recompute deterministic readiness"
            : "latest review cycle approves; recompute deterministic readiness",
        ),
        ...publishGate(options, "publish gate must run after readiness"),
      ],
      { status: "completed" },
    );
  }
  return maxPassesReached(options);
});
const executionStop = Effect.fn("executionStop")(function* (
  context: WorkflowContext,
  artifact: ExecutionStopArtifact,
) {
  const report = yield* parseChangeReportJson(
    yield* readArtifact(context, artifact),
  );
  if (
    report.blockingQuestions.length === 0 &&
    report.externalBlockers.length === 0
  )
    return undefined;
  return stoppedExecution(artifact);
});
function stoppedExecution(artifact: ExecutionStopArtifact) {
  return terminal(
    [
      readiness(
        "execution stopped for a material question or external blocker",
      ),
      noop("resolve the execution stop before continuing"),
    ],
    { status: "execution-stopped", artifact },
  );
}
const inspect = Effect.fn("inspect")(function* (
  context: WorkflowContext,
  artifact: ArtifactRef,
  options: WorkflowProgressionOptions,
) {
  const exists = yield* artifactExists(context, artifact);
  if (!exists)
    return { exists: false, valid: false, reason: "artifact is missing" };
  const forcedAction = forceActionForArtifact(artifact);
  if (
    options.force === true &&
    forcedAction !== undefined &&
    !hasCompletedAction(options.completedActions ?? [], forcedAction)
  ) {
    return { exists: true, valid: false, reason: "forced rerun requested" };
  }
  const content = yield* readArtifact(context, artifact);
  const validation = yield* validateAgentArtifact(artifact, content);
  if (
    !validation.ok &&
    options.force !== true &&
    (artifact === "triage" ||
      artifact === "implementationPlanDraft" ||
      artifact === "implementationPlan" ||
      artifact === "implementationLog") &&
    (yield* artifactExists(context, "implementationLog"))
  )
    return yield* Effect.fail(
      new ArtifactContractError({
        artifact: "Workflow recovery",
        message: `Saved planning or execution artifacts are incompatible with the current contract (${validation.reason}). Preserve any completed work, then run continue to update the saved work, or continue --restart to start over; old implementation cannot be reused with a regenerated plan.`,
      }),
    );
  if (!validation.ok)
    return { exists: true, valid: false, reason: validation.reason, content };
  return { exists: true, valid: true, reason: "artifact is valid", content };
});
function forceActionForArtifact(
  artifact: ArtifactRef,
): WorkflowProgressionAction | undefined {
  if (typeof artifact === "string") {
    if (artifact === "issue") return run("fetch", "forced rerun requested");
    if (artifact === "triage") return run("triage", "forced rerun requested");
    if (artifact === "implementationPlanDraft")
      return run("plan-draft", "forced rerun requested");
    if (artifact === "implementationPlan")
      return run("plan", "forced rerun requested");
    if (artifact === "preImplementationBaseline")
      return run("capture-baseline", "forced rerun requested");
    if (artifact === "implementationLog")
      return run("implement", "forced rerun requested");
    return undefined;
  }
  if (artifact.name === "fixLog")
    return run("fix", "forced rerun requested", artifact.pass);
  if (artifact.name === "implementationRestartLog")
    return run("implement", "forced rerun requested", artifact.pass);
  if (artifact.name === "refinementLog")
    return run("refine-code", "forced rerun requested", artifact.pass);
  if (artifact.name === "reviewA")
    return run("review-a", "forced rerun requested", artifact.pass);
  if (artifact.name === "reviewB")
    return run("review-b", "forced rerun requested", artifact.pass);
  if (artifact.name === "baselineResetLog")
    return run("reset-baseline", "forced rerun requested", artifact.pass);
  return undefined;
}
const reviewCycleProgressExists = Effect.fn("reviewCycleProgressExists")(
  function* (context: WorkflowContext, pass: number) {
    return (
      (yield* artifactExists(context, refinementLogRef(pass))) ||
      (yield* artifactExists(context, reviewARef(pass))) ||
      (yield* artifactExists(context, reviewBRef(pass)))
    );
  },
);
function hasCompletedAction(
  actions: readonly WorkflowProgressionAction[],
  expected: WorkflowProgressionAction,
): boolean {
  return actions.some((action) => actionKey(action) === actionKey(expected));
}
function actionKey(action: WorkflowProgressionAction): string {
  if (action.type === "run")
    return action.pass === undefined
      ? `run:${action.phase}`
      : `run:${action.phase}:${action.pass}`;
  return action.type;
}
function issuePrerequisitePlan(
  reason: string,
  options: WorkflowProgressionOptions,
): WorkflowProgressionPlan {
  return pending([
    run("fetch", reason),
    run("triage", "triage has not run"),
    run("plan-draft", "plan draft has not run"),
    run("plan", "plan refinement has not run"),
    run("capture-baseline", "baseline has not been captured"),
    run("implement", "implementation has not run"),
    run("refine-code", "refinement has not run", 0),
    run("review-a", "review A has not run", 0),
    run("review-b", "review B has not run", 0),
    readiness("workflow must recompute readiness"),
    ...publishGate(options, "publish gate must run after readiness"),
  ]);
}
function maxPassesReached(
  options: WorkflowProgressionOptions,
): WorkflowProgressionPlan {
  return terminal(
    [
      readiness("maximum fix/restart passes reached"),
      ...publishGate(options, "publish gate records non-publish"),
    ],
    { status: "fix-budget-exhausted" },
  );
}
function pending(
  actions: WorkflowProgressionAction[],
): WorkflowProgressionPlan {
  return { actions };
}
function terminal(
  actions: WorkflowProgressionAction[],
  terminalStatus: WorkflowTerminalStatus,
): WorkflowProgressionPlan {
  return { actions, terminalStatus };
}
function run(
  phase: WorkflowRunPhase,
  reason: string,
  pass?: number,
): WorkflowProgressionAction {
  return { type: "run", phase, pass, reason };
}
function readiness(reason: string): WorkflowProgressionAction {
  return { type: "write-readiness", reason };
}
function publishGate(
  options: WorkflowProgressionOptions,
  reason: string,
): WorkflowProgressionAction[] {
  return options.includePublishGate === true
    ? [{ type: "publish-gate", reason }]
    : [];
}
function noop(reason: string): WorkflowProgressionAction {
  return { type: "noop", reason };
}
