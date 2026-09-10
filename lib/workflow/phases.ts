import { GitHub } from "../github/service.ts";
import { Presentation } from "../runtime/services.ts";
import { Cause, Effect, Exit, FileSystem } from "effect";
import { RunObservation } from "../observability/observer.ts";
import path from "node:path";
import { type GitHubIssueSnapshot } from "../github/issue.ts";
import { createFileRunObserver } from "../observability/observer.ts";
import {
  type AgentDisplayContext,
  type AgentOperation,
} from "../presentation/presenter.ts";
import { runPresentedPhase } from "../presentation/phase.ts";
import { formatGitHubIssueArtifact } from "../prompts/github-issue-artifact.ts";
import {
  baselineResetLogRef,
  fixLogRef,
  implementationRestartLogRef,
  type ArtifactRef,
  type WorkflowContext,
} from "./artifacts.ts";
import {
  artifactExists,
  inferNextFixPass,
  inferNextRefinementPass,
  latestCompleteReviewCycle,
} from "./artifacts.ts";
import { readArtifact, writeArtifact, writeJsonArtifact } from "./artifacts.ts";
import { validateAgentArtifact } from "./artifact-validation.ts";
import {
  prepareIssueContinuation,
  type IssueContinuationOptions,
} from "../issue-continuation/workflow.ts";
import {
  assertCleanGit,
  capturePreImplementationBaseline,
  resetWorktreeToPreImplementationBaseline,
  parsePreImplementationBaseline,
} from "./git.ts";
import { createIssuesPhase } from "../issue-curation/create-issues.ts";
import { issueCurationPhase } from "./issue-curation.ts";
import { buildReadinessArtifacts } from "./readiness.ts";
import {
  issueArtifactHasRelationshipSnapshot,
  planWorkflowProgression,
  type WorkflowProgressionAction,
  type WorkflowTerminalStatus,
} from "./progression.ts";
import type {
  SinglePhaseCommand,
  StandaloneWorkflowPhase,
  WorkflowRunPhase,
} from "./phase-vocabulary.ts";
import {
  codeRefinementTask,
  fixTask,
  implementationTaskForPass,
  reviewATaskForPass,
  reviewBTaskForPass,
  runChangeReportTask,
  runPlanDraftTask,
  runPlanTask,
  runReviewTask,
  runTriageTask,
  type ChangeReportRunOptions,
} from "./tasks.ts";
export { issueArtifactHasRelationshipSnapshot } from "./progression.ts";
export const fetchIssuePhase = Effect.fn("fetchIssuePhase")(function* (
  context: WorkflowContext,
  suppliedSnapshot?: GitHubIssueSnapshot,
) {
  const display = deterministicDisplay(
    context,
    "fetch",
    "Fetch issue",
    "issue.md",
    "inspect",
  );
  let outcome = "fetched";
  return yield* runPresentedPhase(
    display,
    Effect.fnUntraced(function* () {
      if (
        !context.force &&
        suppliedSnapshot === undefined &&
        (yield* artifactExists(context, "issue"))
      ) {
        const existingIssue = yield* readArtifact(context, "issue");
        if (issueArtifactHasRelationshipSnapshot(existingIssue)) {
          yield* (
            context.observer?.phaseCompleted({
              phase: "fetch",
              label: "Fetch issue",
              artifact: "issue",
              reused: true,
            }) ?? Effect.void
          );
          outcome = "reused";
          return existingIssue;
        }
        (yield* Presentation).line(
          "Fetch issue: existing issue.md lacks GitHub relationship snapshot; refetching",
        );
      }
      (yield* Presentation).line(
        suppliedSnapshot
          ? `Using fresh pre-claim snapshot for issue #${context.issueNumber}`
          : `Fetching issue #${context.issueNumber}`,
      );
      yield* (
        context.observer?.phaseStarted({
          phase: "fetch",
          label: "Fetch issue",
          artifact: "issue",
        }) ?? Effect.void
      );
      const result =
        suppliedSnapshot ??
        (yield* (yield* GitHub).fetchGitHubIssue(context.issueInput, {
          cwd: context.controlCwd,
          repo: context.repo,
        }));
      assertSnapshotMatchesContext(context, result);
      const issueArtifact = formatGitHubIssueArtifact(
        result.issue,
        result.relationships,
      );
      yield* writeArtifact(context, "issue", issueArtifact);
      yield* writeJsonArtifact(context, "metadata", {
        issueNumber: result.issueNumber,
        repo: result.repo,
        fetchedAt: result.fetchedAt,
        issue: result.issue,
        relationships: result.relationships,
      });
      yield* (
        context.observer?.phaseCompleted({
          phase: "fetch",
          label: "Fetch issue",
          artifact: "issue",
        }) ?? Effect.void
      );
      return issueArtifact;
    }),
    () => ({ outcome, artifact: "issue.md" }),
    {
      onError: (error) =>
        context.observer?.phaseFailed({
          phase: "fetch",
          label: "Fetch issue",
          artifact: "issue",
          error,
        }),
    },
  );
});
export const triagePhase = Effect.fn("triagePhase")(function* (
  context: WorkflowContext,
) {
  return yield* runTriageTask(context, undefined);
});
export const planDraftPhase = Effect.fn("planDraftPhase")(function* (
  context: WorkflowContext,
) {
  return yield* runPlanDraftTask(context, undefined);
});
export const planPhase = Effect.fn("planPhase")(function* (
  context: WorkflowContext,
) {
  return yield* runPlanTask(context, undefined);
});
export const captureBaselinePhase = Effect.fn("captureBaselinePhase")(
  function* (context: WorkflowContext) {
    const display = deterministicDisplay(
      context,
      "capture-baseline",
      "Capture baseline",
      "pre-implementation-baseline.json",
      "inspect",
    );
    let outcome = "captured";
    return yield* runPresentedPhase(
      display,
      Effect.fnUntraced(function* () {
        if (
          !context.force &&
          (yield* artifactExists(context, "preImplementationBaseline"))
        ) {
          const existing = yield* readArtifact(
            context,
            "preImplementationBaseline",
          );
          if (existing.trim()) {
            outcome = "reused";
            return existing;
          }
        }
        const baseline = yield* capturePreImplementationBaseline({
          cwd: context.agentCwd,
          yes: context.yes,
        });
        const content = JSON.stringify(
          {
            ...baseline,
            note: "Restart resets non-.roark worktree state to this baseline; .roark control-plane artifacts are preserved.",
          },
          null,
          2,
        );
        yield* writeArtifact(context, "preImplementationBaseline", content);
        return content;
      }),
      () => ({ outcome, artifact: display.expectedArtifact }),
      undefined,
    );
  },
);
export const implementationPhase = Effect.fn("implementationPhase")(function* (
  context: WorkflowContext,
  restartPass?: number,
  executionOptions: ChangeReportRunOptions = {},
) {
  restartPass ??= 0;
  const task = implementationTaskForPass(restartPass);
  if (
    context.continuing !== true &&
    ((yield* shouldRegenerateArtifact(context, task.artifact)) ||
      restartPass > 0)
  ) {
    yield* assertCleanGit({
      cwd: context.agentCwd,
      yes: context.yes || restartPass > 0,
    });
  }
  const content = yield* runChangeReportTask(
    restartPass > 0 ? { ...context, force: true } : context,
    task,
    undefined,
    executionOptions,
  );
  if (restartPass > 0) {
    yield* writeArtifact(
      context,
      implementationRestartLogRef(restartPass),
      `# Implementation Restart Log Pass ${restartPass}\n\n## Summary\nRestart implementation completed after baseline reset. See implementation-log.json for the authoritative report and implementation-log.md for its human-readable view.\n`,
    );
  }
  return content;
});
export const codeRefinementPhase = Effect.fn("codeRefinementPhase")(function* (
  context: WorkflowContext,
  pass?: number,
) {
  pass ??= yield* inferNextRefinementPass(context);
  return yield* runChangeReportTask(
    context,
    codeRefinementTask(pass, yield* codeRefinementSourceForPass(context, pass)),
    undefined,
  );
});
const codeRefinementSourceForPass = Effect.fn("codeRefinementSourceForPass")(
  function* (context: WorkflowContext, pass: number) {
    if (pass === 0) return "initial";
    if (yield* artifactExists(context, fixLogRef(pass))) return "fix";
    if (
      (yield* artifactExists(context, implementationRestartLogRef(pass))) ||
      (yield* artifactExists(context, baselineResetLogRef(pass)))
    )
      return "restart";
    return "fix";
  },
);
export const reviewPhase = Effect.fn("reviewPhase")(function* (
  context: WorkflowContext,
  pass?: number,
) {
  pass ??= yield* inferNextReviewPass(context);
  const [reviewA, reviewB] = yield* Effect.all(
    [
      Effect.exit(runReviewTask(context, reviewATaskForPass(pass))),
      Effect.exit(runReviewTask(context, reviewBTaskForPass(pass))),
    ],
    { concurrency: "unbounded" },
  );
  if (Exit.isFailure(reviewA))
    return yield* Effect.failCause(
      Exit.isFailure(reviewB)
        ? Cause.combine(reviewA.cause, reviewB.cause)
        : reviewA.cause,
    );
  if (Exit.isFailure(reviewB)) return yield* Effect.failCause(reviewB.cause);
  return { reviewA: reviewA.value, reviewB: reviewB.value };
});
export const fixPhase = Effect.fn("fixPhase")(function* (
  context: WorkflowContext,
  pass?: number,
) {
  pass ??= yield* inferNextFixPass(context);
  const task = fixTask(pass);
  if (yield* shouldRegenerateArtifact(context, task.artifact)) {
    yield* assertCleanGit({ cwd: context.agentCwd, yes: true });
  }
  return yield* runChangeReportTask(context, task, undefined);
});
export const resetBaselinePhase = Effect.fn("resetBaselinePhase")(function* (
  context: WorkflowContext,
  pass: number,
) {
  const artifact = `baseline-reset-${pass}.md`;
  const display = {
    ...deterministicDisplay(
      context,
      `baseline-reset-${pass}`,
      "Reset baseline",
      artifact,
      "edit",
    ),
    pass,
  };
  return yield* runPresentedPhase(
    display,
    Effect.fnUntraced(function* () {
      const raw = yield* readArtifact(context, "preImplementationBaseline");
      const baseline = yield* parsePreImplementationBaseline(raw);
      yield* resetWorktreeToPreImplementationBaseline({
        cwd: context.agentCwd,
        baseline,
      });
      const content = `# Baseline Reset Pass ${pass}\n\n## Summary\nReset non-.roark worktree state to pre-implementation baseline ${baseline.head}.\n\n## Preserved Control Plane\n.roark artifacts were preserved.\n`;
      yield* writeArtifact(context, baselineResetLogRef(pass), content);
      return content;
    }),
    () => ({ outcome: "reset", artifact }),
    undefined,
  );
});
export const readinessPhase = Effect.fn("readinessPhase")(function* (
  context: WorkflowContext,
) {
  const display = deterministicDisplay(
    context,
    "readiness",
    "Readiness",
    "readiness.md",
    "inspect",
  );
  yield* (
    context.observer?.phaseStarted({
      phase: "readiness",
      label: "Readiness",
      artifact: "readiness",
    }) ?? Effect.void
  );
  return yield* runPresentedPhase(
    display,
    Effect.fnUntraced(function* () {
      const readiness = yield* buildReadinessArtifacts(context);
      yield* writeJsonArtifact(context, "readiness", readiness.result);
      yield* writeArtifact(context, "readinessMarkdown", readiness.markdown);
      yield* (
        context.observer?.phaseCompleted({
          phase: "readiness",
          label: "Readiness",
          artifact: "readiness",
        }) ?? Effect.void
      );
      return readiness.markdown;
    }),
    () => ({ outcome: "generated", artifact: "readiness.md" }),
    {
      onError: (error) =>
        context.observer?.phaseFailed({
          phase: "readiness",
          label: "Readiness",
          artifact: "readiness",
          error,
        }),
    },
  );
});
export type WorkflowRunResult = WorkflowTerminalStatus;
export interface RunFullWorkflowOptions {
  issueSnapshot?: GitHubIssueSnapshot | undefined;
  continuation?: IssueContinuationOptions | undefined;
}
export const runFullWorkflow = Effect.fn("runFullWorkflow")(function* (
  context: WorkflowContext,
  options: RunFullWorkflowOptions = {},
) {
  const observer = context.observer ?? (yield* createFileRunObserver(context));
  yield* observer.runStarted({ command: "do" });
  return yield* runFullWorkflowBody({ ...context, observer }, options).pipe(
    Effect.provideService(RunObservation, observer),
    Effect.onExit((exit) =>
      Exit.isSuccess(exit)
        ? observer.runCompleted({ status: exit.value.status })
        : observer.runFailed(Cause.squash(exit.cause)),
    ),
  );
});
const runFullWorkflowBody = Effect.fn("runFullWorkflowBody")(function* (
  context: WorkflowContext,
  options: RunFullWorkflowOptions,
) {
  if (options.continuation)
    yield* prepareIssueContinuation(
      context,
      options.continuation,
      options.issueSnapshot,
    );
  const completedActions: WorkflowProgressionAction[] = [];
  for (;;) {
    const progression = yield* planWorkflowProgression(context, {
      force: context.force,
      completedActions,
    });
    const next = progression.actions[0];
    if (!next) {
      if (progression.terminalStatus) return progression.terminalStatus;
      return yield* Effect.fail(
        new Error(
          "Workflow progression produced no next action and no terminal status.",
        ),
      );
    }
    if (next.type === "run") {
      const reassessExecutionStop =
        context.force &&
        next.phase === "implement" &&
        completedActions.some(
          (action) => action.type === "run" && action.phase === "plan",
        );
      const following = progression.actions[1];
      if (
        next.phase === "review-a" &&
        following?.type === "run" &&
        following.phase === "review-b" &&
        following.pass === next.pass
      ) {
        yield* reviewPhase(context, next.pass ?? 0);
        completedActions.push(next, following);
        continue;
      }
      yield* runWorkflowPhase(context, next.phase, next.pass, options, {
        reassessExecutionStop,
      });
      completedActions.push(next);
      continue;
    }
    if (next.type === "write-readiness") {
      yield* readinessPhase(context);
      completedActions.push(next);
      if (progression.terminalStatus) return progression.terminalStatus;
      continue;
    }
    if (next.type === "noop") {
      if (progression.terminalStatus) return progression.terminalStatus;
      return yield* Effect.fail(
        new Error(
          `Workflow progression returned a no-op without a terminal status: ${next.reason}`,
        ),
      );
    }
    return yield* Effect.fail(
      new Error(
        `Workflow progression returned unsupported fresh-run action '${next.type}'.`,
      ),
    );
  }
});
const runWorkflowPhase = Effect.fn("runWorkflowPhase")(function* (
  context: WorkflowContext,
  phase: WorkflowRunPhase,
  pass?: number,
  options: RunFullWorkflowOptions = {},
  executionOptions: ChangeReportRunOptions = {},
) {
  switch (phase) {
    case "fetch":
      yield* fetchIssuePhase(context, options.issueSnapshot);
      return;
    case "triage":
      yield* triagePhase(context);
      return;
    case "plan-draft":
      yield* planDraftPhase(context);
      return;
    case "plan":
      yield* planPhase(context);
      return;
    case "capture-baseline":
      yield* captureBaselinePhase(context);
      return;
    case "implement":
      yield* implementationPhase(context, pass ?? 0, executionOptions);
      return;
    case "refine-code":
      yield* codeRefinementPhase(context, pass);
      return;
    case "review-a":
      yield* runReviewTask(context, reviewATaskForPass(pass ?? 0), undefined);
      return;
    case "review-b":
      yield* runReviewTask(context, reviewBTaskForPass(pass ?? 0), undefined);
      return;
    case "fix":
      yield* fixPhase(context, pass);
      return;
    case "reset-baseline":
      yield* resetBaselinePhase(context, pass ?? 1);
      return;
    default:
      return assertNever(phase);
  }
});
function assertSnapshotMatchesContext(
  context: WorkflowContext,
  snapshot: GitHubIssueSnapshot,
): void {
  if (
    snapshot.issueNumber !== context.issueNumber ||
    String(snapshot.issue.number) !== context.issueNumber
  ) {
    throw new Error(
      `Supplied GitHub issue snapshot is for #${snapshot.issueNumber}, but workflow expects #${context.issueNumber}.`,
    );
  }
}
function assertNever(value: never): never {
  throw new Error(`Unsupported workflow phase '${String(value)}'.`);
}
const inferNextReviewPass = Effect.fn("inferNextReviewPass")(function* (
  context: WorkflowContext,
) {
  return ((yield* latestCompleteReviewCycle(context)) ?? -1) + 1;
});
const shouldRegenerateArtifact = Effect.fn("shouldRegenerateArtifact")(
  function* (context: WorkflowContext, artifact: ArtifactRef) {
    if (context.force || !(yield* artifactExists(context, artifact)))
      return true;
    const existing = yield* readArtifact(context, artifact);
    return !(yield* validateAgentArtifact(artifact, existing)).ok;
  },
);
const assertAttemptSelectedWhenAttemptsExist = Effect.fn(
  "assertAttemptSelectedWhenAttemptsExist",
)(function* (
  context: WorkflowContext,
  command: "curate-issues" | "create-issues",
) {
  if (context.attempt !== undefined) return;
  const fs = yield* FileSystem.FileSystem;
  const attemptsDir = path.join(
    context.outDir,
    "issue",
    context.issueNumber,
    "attempts",
  );
  if (!(yield* fs.exists(attemptsDir))) return;
  const entries = yield* fs.readDirectory(attemptsDir);
  let latest: number | undefined;
  for (const name of entries) {
    if (
      !/^\d+$/.test(name) ||
      (yield* fs.stat(path.join(attemptsDir, name))).type !== "Directory"
    )
      continue;
    latest = Math.max(latest ?? 0, Number(name));
  }
  if (latest === undefined) return;
  return yield* Effect.fail(
    new Error(
      `Issue #${context.issueNumber} has attempt artifacts under ${path.relative(context.controlCwd, attemptsDir)}. Run '${command} ${context.issueInput} --attempt ${latest}' (or choose another attempt) so reviewer findings are curated from the intended attempt.`,
    ),
  );
});
export const runSinglePhase = Effect.fn("runSinglePhase")(function* (
  context: WorkflowContext,
  phase: SinglePhaseCommand,
) {
  const observer = context.observer ?? (yield* createFileRunObserver(context));
  const current = { ...context, observer };
  yield* observer.runStarted({ command: phase });
  return yield* Effect.gen(function* () {
    if (phase === "review")
      yield* reviewPhase(
        current,
        context.fixPass ?? (yield* inferNextReviewPass(current)),
      );
    else if (phase === "readiness") yield* readinessPhase(current);
    else if (phase === "curate-issues") {
      yield* assertAttemptSelectedWhenAttemptsExist(current, phase);
      yield* issueCurationPhase(current);
    } else if (phase === "create-issues") {
      yield* assertAttemptSelectedWhenAttemptsExist(current, phase);
      yield* createIssuesPhase(current);
    } else
      yield* runWorkflowPhase(
        current,
        phase,
        yield* standalonePhasePass(current, phase),
      );
  }).pipe(
    Effect.provideService(RunObservation, observer),
    Effect.onExit((exit) =>
      Exit.isSuccess(exit)
        ? observer.runCompleted({ status: "completed" })
        : observer.runFailed(Cause.squash(exit.cause)),
    ),
  );
});
const standalonePhasePass = Effect.fn("standalonePhasePass")(function* (
  context: WorkflowContext,
  phase: StandaloneWorkflowPhase,
) {
  if (phase === "refine-code")
    return context.fixPass ?? (yield* inferNextRefinementPass(context));
  if (phase === "fix")
    return context.fixPass ?? (yield* inferNextFixPass(context));
  if (phase === "reset-baseline") return context.fixPass ?? 1;
  return undefined;
});
function deterministicDisplay(
  context: WorkflowContext,
  phaseId: string,
  phaseLabel: string,
  expectedArtifact: string,
  operation: AgentOperation,
): AgentDisplayContext {
  return {
    command: context.displayCommand ?? "issue-workflow",
    repository: context.repo,
    target: `#${context.issueNumber}`,
    phaseId,
    phaseLabel,
    expectedArtifact,
    operation,
  };
}
