import {
  artifactExists,
  finalReviewRef,
  fixLogRef,
  readArtifact,
  type ArtifactRef,
  type WorkflowContext,
} from "./artifacts.ts";
import { validateAgentArtifact } from "./artifact-validation.ts";
import {
  hasBlockedReview,
  needsFix,
  parseVerdict,
  shouldImplementPlan,
  shouldProceedAfterTriage,
  shouldRunAnotherFixPass,
} from "./verdicts.ts";

export type WorkflowRunPhase = "fetch" | "triage" | "plan" | "implement" | "review-a" | "review-b" | "fix" | "final-review";

export type WorkflowProgressionAction =
  | { type: "run"; phase: WorkflowRunPhase; pass?: number; reason: string }
  | { type: "write-readiness"; reason: string }
  | { type: "publish-gate"; reason: string }
  | { type: "noop"; reason: string };

export type WorkflowTerminalStatus =
  | { status: "triage-stopped"; triageVerdict: string }
  | { status: "planning-stopped" }
  | { status: "review-blocked" }
  | { status: "completed" };

export type WorkflowProgressionPlan = {
  actions: WorkflowProgressionAction[];
  terminalStatus?: WorkflowTerminalStatus;
};

export type WorkflowProgressionOptions = {
  includePublishGate?: boolean;
  force?: boolean;
  completedActions?: readonly WorkflowProgressionAction[];
};

type Inspection = {
  exists: boolean;
  valid: boolean;
  reason: string;
  content?: string;
};

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
      run("plan", "plan depends on triage"),
      run("implement", "implementation depends on plan"),
      run("review-a", "review A depends on implementation"),
      run("review-b", "review B depends on implementation"),
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

  const plan = await inspect(context, "implementationPlan", options);
  if (!plan.valid) {
    return pending([
      run("plan", plan.reason),
      run("implement", "implementation depends on plan"),
      run("review-a", "review A depends on implementation"),
      run("review-b", "review B depends on implementation"),
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

  const implementation = await inspect(context, "implementationLog", options);
  if (!implementation.valid) {
    return pending([
      run("implement", implementation.reason),
      run("review-a", "review A depends on implementation"),
      run("review-b", "review B depends on implementation"),
      readiness("workflow must recompute readiness"),
      ...publishGate(options, "publish gate must run after readiness"),
    ]);
  }

  const reviewA = await inspect(context, "reviewA", options);
  const reviewB = await inspect(context, "reviewB", options);
  const reviewActions: WorkflowProgressionAction[] = [];
  if (!reviewA.valid) reviewActions.push(run("review-a", reviewA.reason));
  if (!reviewB.valid) reviewActions.push(run("review-b", reviewB.reason));
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

  if (needsFix(reviewAMarkdown, reviewBMarkdown) || hasExistingFixProgress(context)) {
    for (let pass = 1; pass <= context.maxFixPasses; pass++) {
      const fix = await inspect(context, fixLogRef(pass), options);
      if (!fix.valid) {
        return pending([
          run("fix", fix.reason, pass),
          run("final-review", "final review depends on fix", pass),
          readiness("workflow must recompute readiness"),
          ...publishGate(options, "publish gate must run after readiness"),
        ]);
      }

      const finalReview = await inspect(context, finalReviewRef(pass), options);
      if (!finalReview.valid) {
        return pending([
          run("final-review", finalReview.reason, pass),
          readiness("workflow must recompute readiness"),
          ...publishGate(options, "publish gate must run after readiness"),
        ]);
      }

      if (!shouldRunAnotherFixPass(finalReview.content ?? "")) {
        return terminal(
          [
            readiness("latest final review decides readiness"),
            ...publishGate(options, "publish gate must run after readiness"),
          ],
          { status: "completed" },
        );
      }
    }

    return terminal(
      [
        readiness("maximum fix passes reached"),
        ...publishGate(options, "publish gate records non-publish"),
      ],
      { status: "completed" },
    );
  }

  return terminal(
    [
      readiness("reviews approve; recompute deterministic readiness"),
      ...publishGate(options, "publish gate must run after readiness"),
    ],
    { status: "completed" },
  );
}

async function inspect(
  context: WorkflowContext,
  artifact: ArtifactRef,
  options: WorkflowProgressionOptions,
): Promise<Inspection> {
  const exists = artifactExists(context, artifact);
  if (!exists) return { exists: false, valid: false, reason: "artifact is missing" };

  const forcedAction = forceActionForArtifact(artifact);
  if (options.force && forcedAction && !hasCompletedAction(options.completedActions ?? [], forcedAction)) {
    return { exists: true, valid: false, reason: "forced rerun requested" };
  }

  const content = await readArtifact(context, artifact);
  const validation = validateAgentArtifact(artifact, content);
  if (!validation.ok) return { exists: true, valid: false, reason: validation.reason, content };
  return { exists: true, valid: true, reason: "artifact is valid", content };
}

function hasExistingFixProgress(context: WorkflowContext): boolean {
  return artifactExists(context, fixLogRef(1)) || artifactExists(context, finalReviewRef(1));
}

function forceActionForArtifact(artifact: ArtifactRef): WorkflowProgressionAction | undefined {
  if (typeof artifact === "string") {
    if (artifact === "issue") return run("fetch", "forced rerun requested");
    if (artifact === "triage") return run("triage", "forced rerun requested");
    if (artifact === "implementationPlan") return run("plan", "forced rerun requested");
    if (artifact === "implementationLog") return run("implement", "forced rerun requested");
    if (artifact === "reviewA") return run("review-a", "forced rerun requested");
    if (artifact === "reviewB") return run("review-b", "forced rerun requested");
    return undefined;
  }
  if (artifact.name === "fixLog") return run("fix", "forced rerun requested", artifact.pass);
  if (artifact.name === "finalReview") return run("final-review", "forced rerun requested", artifact.pass);
  return undefined;
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
    run("plan", "plan has not run"),
    run("implement", "implementation has not run"),
    run("review-a", "review A has not run"),
    run("review-b", "review B has not run"),
    readiness("workflow must recompute readiness"),
    ...publishGate(options, "publish gate must run after readiness"),
  ]);
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
  return options.includePublishGate ? [{ type: "publish-gate", reason }] : [];
}

function noop(reason: string): WorkflowProgressionAction {
  return { type: "noop", reason };
}
