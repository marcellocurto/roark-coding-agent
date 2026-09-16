import type { OutcomeReport } from "../presentation/presenter.ts";
import { buildRoarkMarker } from "../github/comments.ts";
import type { WorkspaceFailure } from "./workspace.ts";
import {
  createFileRunObserver,
  RunObservation,
} from "../observability/observer.ts";

import { AttemptStore } from "./attempts.ts";
import { Cause, DateTime, Effect, Exit } from "effect";
import { Presentation } from "../runtime/services.ts";
import {
  artifactRelativePath,
  type WorkflowContext,
} from "../workflow/artifacts.ts";
import { readArtifact } from "../workflow/artifacts.ts";
import { ArtifactContractError } from "../structured-output/contract.ts";
import { changeReportStopsExecution } from "../change-report/result.ts";
import { fixLogRef, refinementLogRef } from "../workflow/artifacts.ts";

import { type WorkflowRunResult } from "../workflow/phases.ts";
import {
  codeRefinementPhase,
  fixPhase,
  readinessPhase,
  runFullWorkflow,
  reviewPhase,
} from "../workflow/phases.ts";
import type { GitHubIssueSnapshot } from "../github/issue.ts";
import type { IssueContinuationOptions } from "../issue-continuation/workflow.ts";
import { recordWorkflowPosition } from "../issue-continuation/checkpoint.ts";
import { AgentTaskRunError } from "../workflow/tasks.ts";
import {
  hasBlockedReview,
  needsFix,
  needsRestart,
} from "../workflow/verdicts.ts";
import { finalizeAttemptObservability } from "./observability.ts";
import {
  attemptMetadataRelativePath,
  formatAttemptMetadata,
  recordAttemptIssueComment,
  type AttemptMetadata,
  type AttemptOutcome,
} from "./attempts.ts";
import type { AutorunBranchPlan } from "./branch.ts";
import { completeAutorunWorkflow } from "./completion.ts";
import { formatFailureComment } from "./failure.ts";
import { markIssueFailed } from "./failure.ts";
import {
  publishPlanningLedgerComments,
  publishReviewLedgerComments,
} from "./ledger-comments.ts";
import type { AutorunGateOptions } from "./publish-flow.ts";
import {
  formatContinueCommand,
  formatPublicContinueCommand,
  shouldRecoverWithYes,
} from "./recovery.ts";
import type { AutorunIssueCandidate } from "./selection.ts";

import { labelsToRemoveForAutorunTransition } from "./labels.ts";

type AutorunRequirements =
  | Effect.Services<ReturnType<typeof completeAutorunWorkflow>>
  | Effect.Services<ReturnType<typeof runFullWorkflow>>
  | AttemptStore;
type AutorunFailure =
  | Effect.Error<ReturnType<typeof completeAutorunWorkflow>>
  | Effect.Error<ReturnType<typeof runFullWorkflow>>
  | WorkspaceFailure;
export interface RunAutorunAttemptLifecycleInput {
  issueDir: string;
  workflowContext: WorkflowContext;
  branchPlan: AutorunBranchPlan;
  gateOptions: AutorunGateOptions;
  attemptMetadata: AttemptMetadata;
  issue?: AutorunIssueCandidate | undefined;
  loadIssue?:
    | (() => Effect.Effect<
        AutorunIssueCandidate,
        AutorunFailure,
        AutorunRequirements
      >)
    | undefined;
  beforeWorkflow?:
    | ((
        metadata: AttemptMetadata,
      ) => Effect.Effect<void, AutorunFailure, AutorunRequirements>)
    | undefined;
  beforeRun?:
    | ((
        metadata: AttemptMetadata,
      ) => Effect.Effect<void, AutorunFailure, AutorunRequirements>)
    | undefined;
  afterRun?:
    | ((
        metadata: AttemptMetadata,
      ) => Effect.Effect<void, AutorunFailure, AutorunRequirements>)
    | undefined;
  logPrefix?: string | undefined;
  inProgressOutcomeDetail?: string | null | undefined;
  issueSnapshot?: GitHubIssueSnapshot | undefined;
  continuation?: IssueContinuationOptions;
}

export interface AutorunAttemptResult {
  issueNumber: number;
  outcome: AttemptOutcome;
  outcomeDetail: string | null;
  report?: OutcomeReport;
}

export interface RunAutorunAttemptLifecycleInjected {
  runFullWorkflow?: typeof runFullWorkflow | undefined;
  completeAutorunWorkflow?: typeof completeAutorunWorkflow | undefined;
  publishReviewLedgerComments?: typeof publishReviewLedgerComments | undefined;
  publishPlanningLedgerComments?:
    | typeof publishPlanningLedgerComments
    | undefined;
  markIssueFailed?: typeof markIssueFailed | undefined;
  finalizeAttemptObservability?:
    | typeof finalizeAttemptObservability
    | undefined;
}

export const runAutorunAttemptLifecycle = Effect.fn(
  "runAutorunAttemptLifecycle",
)(function* (
  input: RunAutorunAttemptLifecycleInput,
  injected: RunAutorunAttemptLifecycleInjected = {},
) {
  const observer = yield* createFileRunObserver(input.workflowContext);
  const runWorkflow = injected.runFullWorkflow ?? runFullWorkflow;
  const completeWorkflow =
    injected.completeAutorunWorkflow ?? completeAutorunWorkflow;
  const finalizeObservability =
    injected.finalizeAttemptObservability ?? finalizeAttemptObservability;

  let attemptMetadata = formatAttemptMetadata({
    ...input.attemptMetadata,
    worktreePath: input.workflowContext.agentCwd,
    runArtifactPath: input.workflowContext.runDirRelative,
    endedAt: null,
    outcome: "in-progress",
    outcomeDetail: input.inProgressOutcomeDetail ?? null,
  });

  let outcome: AttemptOutcome = "in-progress";
  let outcomeDetail: string | null = null;

  const presentation = yield* Presentation;
  const attempts = yield* AttemptStore;
  const work = attempts.persist(input.issueDir, attemptMetadata).pipe(
    Effect.uninterruptible,
    Effect.andThen(
      Effect.gen(function* () {
        yield* input.beforeWorkflow?.(attemptMetadata) ?? Effect.void;
        yield* attempts.persist(input.issueDir, attemptMetadata);

        yield* input.beforeRun?.(attemptMetadata) ?? Effect.void;
        yield* attempts.persist(input.issueDir, attemptMetadata);

        const workflowResult = yield* runWorkflow(input.workflowContext, {
          issueSnapshot: input.issueSnapshot,
          continuation: input.continuation,
        });
        const issue = yield* resolveIssue(input);
        const attemptMetadataPath =
          attemptMetadataRelativePath(attemptMetadata);
        let completionOutcome = yield* completeWorkflow(
          {
            workflowResult,
            options: input.gateOptions,
            issue,
            branchPlan: input.branchPlan,
            workflowContext: input.workflowContext,
            attemptMetadata,
            attemptMetadataPath,
            recoveryCommand: publicRecoveryCommand(input, false),
          },
          undefined,
        );

        while (completionOutcome.outcome === "verification-needs-fix") {
          const repairResult = yield* runVerificationRepairWorkflow(
            input.workflowContext,
            completionOutcome.pass,
          );
          completionOutcome = yield* completeWorkflow(
            {
              workflowResult: repairResult,
              options: input.gateOptions,
              issue,
              branchPlan: input.branchPlan,
              workflowContext: input.workflowContext,
              attemptMetadata,
              attemptMetadataPath,
              recoveryCommand: publicRecoveryCommand(input, false),
            },
            undefined,
          );
        }

        const terminalOutcome = completionOutcome;
        outcome = terminalOutcome.outcome;
        outcomeDetail = terminalOutcome.outcomeDetail;
        return {
          issueNumber: input.attemptMetadata.issueNumber,
          outcome,
          outcomeDetail,
          ...("report" in terminalOutcome
            ? { report: terminalOutcome.report }
            : {}),
        };
      }),
    ),
  );
  return yield* work.pipe(
    Effect.provideService(RunObservation, observer),
    Effect.onExit((exit) =>
      Effect.gen(function* () {
        if (Exit.isFailure(exit) && outcome === "in-progress") {
          const error = Cause.squash(exit.cause);
          outcome = isOutputContractError(error)
            ? "failed-output-contract"
            : "errored";
          outcomeDetail = Cause.hasInterruptsOnly(exit.cause)
            ? "Interrupted."
            : formatError(error);
        }
        const reportFailure =
          Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)
            ? markWorkflowError(
                input,
                injected,
                attemptMetadata,
                Cause.squash(exit.cause),
              )
            : Effect.void;
        const finalize = Effect.gen(function* () {
          yield* Effect.suspend(
            () => input.afterRun?.(attemptMetadata) ?? Effect.void,
          ).pipe(
            Effect.catchCause((cause) =>
              Effect.sync(() => {
                presentation.warning(
                  `afterRun hook failed: ${formatError(Cause.squash(cause))}`,
                );
              }),
            ),
          );
          const endedAt = DateTime.toDateUtc(yield* DateTime.now);
          attemptMetadata = formatAttemptMetadata({
            ...attemptMetadata,
            endedAt,
            outcome,
            outcomeDetail,
          });
          yield* attempts.persist(input.issueDir, attemptMetadata).pipe(
            Effect.ensuring(
              finalizeObservability({
                context: input.workflowContext,
                outcome,
                outcomeDetail,
                endedAt,
              }).pipe(Effect.orDie),
            ),
          );
        });
        yield* reportFailure.pipe(Effect.ensuring(finalize.pipe(Effect.orDie)));
      }),
    ),
  );
});

const runVerificationRepairWorkflow = Effect.fn(
  "runVerificationRepairWorkflow",
)(function* (context: WorkflowContext, initialPass: number) {
  for (let pass = initialPass; pass <= context.maxFixPasses; pass++) {
    yield* recordWorkflowPosition(context, pass);
    (yield* Presentation).line(`Verification repair pass ${pass}`);
    const fix = yield* fixPhase(context, pass);
    if (changeReportStopsExecution(fix)) {
      yield* readinessPhase(context);
      return {
        status: "execution-stopped",
        artifact: fixLogRef(pass),
      } satisfies WorkflowRunResult;
    }
    const refinement = yield* codeRefinementPhase(context, pass);
    if (changeReportStopsExecution(refinement)) {
      yield* readinessPhase(context);
      return {
        status: "execution-stopped",
        artifact: refinementLogRef(pass),
      } satisfies WorkflowRunResult;
    }
    const reviews = yield* reviewPhase(context, pass);
    if (
      hasBlockedReview(reviews.reviewA, reviews.reviewB) ||
      needsRestart(reviews.reviewA, reviews.reviewB)
    )
      break;
    if (
      !needsFix(reviews.reviewA, reviews.reviewB) ||
      pass >= context.maxFixPasses
    )
      break;
    (yield* Presentation).line(
      `Review requested more fixes; continuing to fix pass ${pass + 1}`,
    );
  }
  yield* readinessPhase(context);
  return { status: "completed" } satisfies WorkflowRunResult;
});

const markWorkflowError = Effect.fn("markWorkflowError")(function* (
  input: RunAutorunAttemptLifecycleInput,
  injected: RunAutorunAttemptLifecycleInjected,
  attemptMetadata: AttemptMetadata,
  error: unknown,
) {
  const issue = yield* resolveIssue(input);
  const phase = errorPhase(error);
  const attemptMetadataPath = attemptMetadataRelativePath(attemptMetadata);
  const command = recoveryCommand(input, shouldRecoverWithYes(error));
  const prefix = input.logPrefix ?? "Auto";
  const publishPlanning =
    injected.publishPlanningLedgerComments ?? publishPlanningLedgerComments;
  const publishLedger =
    injected.publishReviewLedgerComments ?? publishReviewLedgerComments;
  const markFailed = injected.markIssueFailed ?? markIssueFailed;

  (yield* Presentation).line(
    `${prefix} workflow error on #${issue.number}: ${formatError(error)}`,
  );
  (yield* Presentation).artifact(attemptMetadataPath);
  (yield* Presentation).recovery(command);

  yield* publishPlanning(
    {
      cwd: input.gateOptions.cwd,
      repo: input.gateOptions.repo,
      issue,
      workflowContext: input.workflowContext,
      attemptMetadata,
    },
    undefined,
  );

  yield* publishLedger(
    {
      cwd: input.gateOptions.cwd,
      repo: input.gateOptions.repo,
      issue,
      workflowContext: input.workflowContext,
      attemptMetadata,
    },
    undefined,
  );

  const errorArtifact = yield* readErrorArtifact(input.workflowContext, error);
  if (errorArtifact) (yield* Presentation).artifact(errorArtifact.path);

  const comment = formatFailureComment({
    issueNumber: issue.number,
    issueUrl: issue.url,
    phase,
    reason: formatError(error),
    branchName: attemptMetadata.branch,
    worktreePath: attemptMetadata.worktreePath,
    workspacePath: attemptMetadata.workspace?.path,
    artifactContent: errorArtifact?.content,
    recoveryCommand: publicRecoveryCommand(input, shouldRecoverWithYes(error)),
  });

  const ref = yield* markFailed({
    marker: buildRoarkMarker({
      issueNumber: issue.number,
      attempt: attemptMetadata.attempt,
      phase: "attempt-status",
    }),
    existingCommentId:
      attemptMetadata.githubComments?.issue?.["attempt-status"]?.id,
    cwd: input.gateOptions.cwd,
    repo: input.gateOptions.repo,
    issueNumber: issue.number,
    label: input.gateOptions.failureLabel,
    comment,
    removeLabels: labelsToRemoveForAutorunTransition({
      issueLabels: issue.labels,
      workflow: input.gateOptions,
      nextLabel: input.gateOptions.failureLabel,
      knownPresent: [input.gateOptions.inProgressLabel],
    }),
  });
  if (ref)
    recordAttemptIssueComment(
      attemptMetadata,
      "attempt-status",
      ref,
      DateTime.formatIso(yield* DateTime.now),
    );
  (yield* Presentation).outcomeReport({
    reason: formatError(error),
    issueUrl: issue.url,
    commentUrl: ref?.url,
    published: ref !== undefined,
    artifactPath: errorArtifact?.path ?? attemptMetadataPath,
    runDirectory: input.workflowContext.runDirRelative,
  });
});

const resolveIssue = Effect.fn("resolveIssue")(function* (
  input: RunAutorunAttemptLifecycleInput,
) {
  if (input.issue) return input.issue;
  if (input.loadIssue) {
    const issue = yield* input
      .loadIssue()
      .pipe(Effect.catch(() => Effect.succeed(undefined)));
    if (issue) return issue;
  }
  return {
    number: input.attemptMetadata.issueNumber,
    title: `Fix issue #${input.attemptMetadata.issueNumber}`,
  };
});

const readErrorArtifact = Effect.fn("readErrorArtifact")(function* (
  context: WorkflowContext,
  error: unknown,
) {
  const artifact =
    error instanceof AgentTaskRunError ? error.artifact : undefined;
  if (artifact === undefined) return undefined;
  return yield* Effect.gen(function* () {
    return {
      path: artifactRelativePath(context, artifact),
      content: yield* readArtifact(context, artifact),
    };
  }).pipe(
    Effect.catch(
      Effect.fnUntraced(function* () {
        return undefined;
      }),
    ),
  );
});

function recoveryCommand(
  input: RunAutorunAttemptLifecycleInput,
  yes: boolean,
): string {
  return formatContinueCommand({
    issueNumber: input.attemptMetadata.issueNumber,
    cwd: input.gateOptions.cwd,
    repo: input.gateOptions.repo,
    attempt: input.attemptMetadata.attempt,
    yes,
  });
}

function publicRecoveryCommand(
  input: RunAutorunAttemptLifecycleInput,
  yes: boolean,
): string {
  return formatPublicContinueCommand({
    issueNumber: input.attemptMetadata.issueNumber,
    repo: input.gateOptions.repo,
    attempt: input.attemptMetadata.attempt,
    yes,
  });
}

function isOutputContractError(error: unknown): boolean {
  return (
    error instanceof ArtifactContractError ||
    (error instanceof AgentTaskRunError && error.phase === "output-contract")
  );
}

function errorPhase(error: unknown): string {
  if (error instanceof AgentTaskRunError) return error.phase;
  if (error instanceof ArtifactContractError) return "output-contract";
  return "workflow-error";
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
