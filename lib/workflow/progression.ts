import {
  artifactExists,
  baselineResetLogRef,
  fixLogRef,
  implementationRestartLogRef,
  readArtifact,
  refinementLogRef,
  reviewARef,
  reviewBRef,
  type ArtifactRef,
  type WorkflowContext,
} from "./artifacts.ts";
import { validateAgentArtifact } from "./artifact-validation.ts";
import {
  hasBlockedReview,
  needsFix,
  needsRestart,
  parseVerdict,
  shouldImplementPlan,
  shouldProceedAfterTriage,
} from "./verdicts.ts";

export type WorkflowRunPhase =
  | "fetch"
  | "triage"
  | "plan-draft"
  | "plan"
  | "capture-baseline"
  | "implement"
  | "refine-code"
  | "review-a"
  | "review-b"
  | "fix"
  | "reset-baseline"
  | "final-review";

export type WorkflowProgressionAction =
  | { type: "run"; phase: WorkflowRunPhase; pass?: number | undefined; reason: string }
  | { type: "write-readiness"; reason: string }
  | { type: "publish-gate"; reason: string }
  | { type: "noop"; reason: string };

export type WorkflowTerminalStatus =
  | { status: "triage-stopped"; triageVerdict: string }
  | { status: "planning-stopped" }
  | { status: "review-blocked" }
  | { status: "completed" };

export interface WorkflowProgressionPlan {
  actions: WorkflowProgressionAction[];
  terminalStatus?: WorkflowTerminalStatus | undefined;
}

export interface WorkflowProgressionOptions {
  includePublishGate?: boolean | undefined;
  force?: boolean | undefined;
  completedActions?: readonly WorkflowProgressionAction[] | undefined;
}

interface Inspection {
  exists: boolean;
  valid: boolean;
  reason: string;
  content?: string | undefined;
}

export function issueArtifactHasRelationshipSnapshot(content: string): boolean {
  return /<github_issue_relationships\b/.test(content);
}

export async function planWorkflowProgression(
  context: WorkflowContext,
  options: WorkflowProgressionOptions = {},
): Promise<WorkflowProgressionPlan> {
  const issue = await inspect(context, "issue", options);
  if (!issue.valid) return issuePrerequisitePlan(issue.reason, options);
  if (!issueArtifactHasRelationshipSnapshot(issue.content ?? "")) {
    return issuePrerequisitePlan("issue artifact lacks GitHub relationship snapshot", options);
  }

  const triage = await inspect(context, "triage", options);
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

  const triageMarkdown = triage.content ?? "";
  if (!shouldProceedAfterTriage(triageMarkdown)) {
    const verdict = parseVerdict(triageMarkdown) ?? "unknown";
    return terminal(
      [
        readiness(`triage verdict is "${verdict}"; readiness records the stop`),
        noop("terminal triage outcome; no plan/implementation/publish gate"),
      ],
      { status: "triage-stopped", triageVerdict: verdict },
    );
  }

  const planDraft = await inspect(context, "implementationPlanDraft", options);
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

  const plan = await inspect(context, "implementationPlan", options);
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

  if (!shouldImplementPlan(plan.content ?? "")) {
    return terminal(
      [
        readiness("implementation plan is not ready; readiness records the stop"),
        noop("terminal planning outcome; no implementation/publish gate"),
      ],
      { status: "planning-stopped" },
    );
  }

  const baseline = await inspect(context, "preImplementationBaseline", options);
  if (!baseline.valid) {
    return pending([
      run("capture-baseline", baseline.reason),
      run("implement", "implementation depends on pre-implementation baseline"),
      run("refine-code", "refinement depends on implementation", 0),
      run("review-a", "review A depends on refinement", 0),
      run("review-b", "review B depends on refinement", 0),
      readiness("workflow must recompute readiness"),
      ...publishGate(options, "publish gate must run after readiness"),
    ]);
  }

  const implementation = await inspect(context, "implementationLog", options);
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

  return reviewCycleProgression(context, options);
}

async function reviewCycleProgression(
  context: WorkflowContext,
  options: WorkflowProgressionOptions,
): Promise<WorkflowProgressionPlan> {
  for (let pass = 0; pass <= context.maxFixPasses; pass++) {
    const refinement = await inspect(context, refinementLogRef(pass), options);
    if (!refinement.valid) {
      return pending([
        run("refine-code", refinement.reason, pass),
        run("review-a", "review A depends on refinement", pass),
        run("review-b", "review B depends on refinement", pass),
        readiness("workflow must recompute readiness"),
        ...publishGate(options, "publish gate must run after readiness"),
      ]);
    }

    const reviewA = await inspect(context, reviewARef(pass), options);
    const reviewB = await inspect(context, reviewBRef(pass), options);
    const reviewActions: WorkflowProgressionAction[] = [];
    if (!reviewA.valid) reviewActions.push(run("review-a", reviewA.reason, pass));
    if (!reviewB.valid) reviewActions.push(run("review-b", reviewB.reason, pass));
    if (reviewActions.length > 0) {
      return pending([
        ...reviewActions,
        readiness("workflow must recompute readiness"),
        ...publishGate(options, "publish gate must run after readiness"),
      ]);
    }

    const reviewAMarkdown = reviewA.content ?? "";
    const reviewBMarkdown = reviewB.content ?? "";
    if (hasBlockedReview(reviewAMarkdown, reviewBMarkdown)) {
      return terminal(
        [
          readiness("a review is blocked; readiness records the stop"),
          ...publishGate(options, "publish gate records non-publish"),
        ],
        { status: "review-blocked" },
      );
    }

    const nextPass = pass + 1;
    if (needsRestart(reviewAMarkdown, reviewBMarkdown)) {
      if (nextPass > context.maxFixPasses) return maxPassesReached(options);
      const reset = await inspect(context, baselineResetLogRef(nextPass), options);
      if (!reset.valid) {
        return pending([
          run("reset-baseline", reset.reason, nextPass),
          run("implement", "implementation restart depends on baseline reset", nextPass),
          run("refine-code", "refinement depends on restarted implementation", nextPass),
          run("review-a", "review A depends on refinement", nextPass),
          run("review-b", "review B depends on refinement", nextPass),
          readiness("workflow must recompute readiness"),
          ...publishGate(options, "publish gate must run after readiness"),
        ]);
      }
      if (reviewCycleProgressExists(context, nextPass)) continue;
      const restartImplementation = await inspect(context, implementationRestartLogRef(nextPass), options);
      if (!restartImplementation.valid) {
        return pending([
          run("implement", restartImplementation.reason === "artifact is missing" ? "implementation restart depends on baseline reset" : restartImplementation.reason, nextPass),
          run("refine-code", "refinement depends on restarted implementation", nextPass),
          run("review-a", "review A depends on refinement", nextPass),
          run("review-b", "review B depends on refinement", nextPass),
          readiness("workflow must recompute readiness"),
          ...publishGate(options, "publish gate must run after readiness"),
        ]);
      }
      continue;
    }

    if (needsFix(reviewAMarkdown, reviewBMarkdown)) {
      if (nextPass > context.maxFixPasses) return maxPassesReached(options);
      const fix = await inspect(context, fixLogRef(nextPass), options);
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
      continue;
    }

    return terminal(
      [
        readiness(pass === 0 ? "reviews approve; recompute deterministic readiness" : "latest review cycle approves; recompute deterministic readiness"),
        ...publishGate(options, "publish gate must run after readiness"),
      ],
      { status: "completed" },
    );
  }

  return maxPassesReached(options);
}

async function inspect(
  context: WorkflowContext,
  artifact: ArtifactRef,
  options: WorkflowProgressionOptions,
): Promise<Inspection> {
  const exists = artifactExists(context, artifact);
  if (!exists) return { exists: false, valid: false, reason: "artifact is missing" };

  const forcedAction = forceActionForArtifact(artifact);
  if (options.force === true && forcedAction !== undefined && !hasCompletedAction(options.completedActions ?? [], forcedAction)) {
    return { exists: true, valid: false, reason: "forced rerun requested" };
  }

  const content = await readArtifact(context, artifact);
  const validation = validateAgentArtifact(artifact, content);
  if (!validation.ok) return { exists: true, valid: false, reason: validation.reason, content };
  return { exists: true, valid: true, reason: "artifact is valid", content };
}

function forceActionForArtifact(artifact: ArtifactRef): WorkflowProgressionAction | undefined {
  if (typeof artifact === "string") {
    if (artifact === "issue") return run("fetch", "forced rerun requested");
    if (artifact === "triage") return run("triage", "forced rerun requested");
    if (artifact === "implementationPlanDraft") return run("plan-draft", "forced rerun requested");
    if (artifact === "implementationPlan") return run("plan", "forced rerun requested");
    if (artifact === "preImplementationBaseline") return run("capture-baseline", "forced rerun requested");
    if (artifact === "implementationLog") return run("implement", "forced rerun requested");
    if (artifact === "reviewA") return run("review-a", "forced rerun requested");
    if (artifact === "reviewB") return run("review-b", "forced rerun requested");
    return undefined;
  }
  if (artifact.name === "fixLog") return run("fix", "forced rerun requested", artifact.pass);
  if (artifact.name === "implementationRestartLog") return run("implement", "forced rerun requested", artifact.pass);
  if (artifact.name === "refinementLog") return run("refine-code", "forced rerun requested", artifact.pass);
  if (artifact.name === "reviewA") return run("review-a", "forced rerun requested", artifact.pass);
  if (artifact.name === "reviewB") return run("review-b", "forced rerun requested", artifact.pass);
  if (artifact.name === "baselineResetLog") return run("reset-baseline", "forced rerun requested", artifact.pass);
  if (artifact.name === "finalReview") return run("final-review", "forced rerun requested", artifact.pass);
  return undefined;
}

function reviewCycleProgressExists(context: WorkflowContext, pass: number): boolean {
  return artifactExists(context, refinementLogRef(pass)) || artifactExists(context, reviewARef(pass)) || artifactExists(context, reviewBRef(pass));
}

function hasCompletedAction(actions: readonly WorkflowProgressionAction[], expected: WorkflowProgressionAction): boolean {
  return actions.some((action) => actionKey(action) === actionKey(expected));
}

function actionKey(action: WorkflowProgressionAction): string {
  if (action.type === "run") return action.pass === undefined ? `run:${action.phase}` : `run:${action.phase}:${action.pass}`;
  return action.type;
}

function issuePrerequisitePlan(reason: string, options: WorkflowProgressionOptions): WorkflowProgressionPlan {
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

function maxPassesReached(options: WorkflowProgressionOptions): WorkflowProgressionPlan {
  return terminal(
    [
      readiness("maximum fix/restart passes reached"),
      ...publishGate(options, "publish gate records non-publish"),
    ],
    { status: "completed" },
  );
}

function pending(actions: WorkflowProgressionAction[]): WorkflowProgressionPlan {
  return { actions };
}

function terminal(actions: WorkflowProgressionAction[], terminalStatus: WorkflowTerminalStatus): WorkflowProgressionPlan {
  return { actions, terminalStatus };
}

function run(phase: WorkflowRunPhase, reason: string, pass?: number): WorkflowProgressionAction {
  return { type: "run", phase, pass, reason };
}

function readiness(reason: string): WorkflowProgressionAction {
  return { type: "write-readiness", reason };
}

function publishGate(options: WorkflowProgressionOptions, reason: string): WorkflowProgressionAction[] {
  return options.includePublishGate === true ? [{ type: "publish-gate", reason }] : [];
}

function noop(reason: string): WorkflowProgressionAction {
  return { type: "noop", reason };
}
