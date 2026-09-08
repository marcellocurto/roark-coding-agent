import {
  createFileRunObserver,
  RunObservation,
} from "../observability/observer.ts";
import { type finalizeAttemptObservabilityPromise } from "./observability-promise.ts";
import { AttemptStore } from "./attempts.ts";
import { Cause, Effect, Exit } from "effect";
import { Presentation } from "../runtime/services.ts";
import type { ApplicationServices } from "../runtime/application.ts";
import { fromLegacyPromise } from "../runtime/application.ts";
import { runApplicationPromise } from "../runtime/application.ts";
import type { ApplicationExecution } from "../runtime/application.ts";
import {
  artifactRelativePath,
  type WorkflowContext,
} from "../workflow/artifacts.ts";
import { readArtifactPromise as readArtifact } from "../workflow/artifacts-promise.ts";
import { ArtifactValidationError } from "../workflow/artifact-validation.ts";
import type { AgentRunner } from "../workflow/agent-runner.ts";
import { type WorkflowRunResult } from "../workflow/phases.ts";
import {
  codeRefinementPhasePromise as codeRefinementPhase,
  fixPhasePromise as fixPhase,
  readinessPhasePromise as readinessPhase,
  runFullWorkflowPromise as runFullWorkflow,
  reviewPhasePromise as reviewPhase,
} from "../workflow/phases-promise.ts";
import type { GitHubIssueSnapshot } from "../github/issue.ts";
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
  type AttemptMetadata,
  type AttemptOutcome,
  type Clock,
  defaultClock,
} from "./attempts.ts";
import type { AutorunBranchPlan } from "./branch.ts";
import { completeAutorunWorkflow } from "./completion.ts";
import { formatFailureComment, markIssueFailed } from "./failure.ts";
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
import { presenter } from "../presentation/presenter.ts";
import { labelsToRemoveForAutorunTransition } from "./labels.ts";

export interface RunAutorunAttemptLifecycleInput {
  issueDir: string;
  workflowContext: WorkflowContext;
  branchPlan: AutorunBranchPlan;
  gateOptions: AutorunGateOptions;
  attemptMetadata: AttemptMetadata;
  issue?: AutorunIssueCandidate | undefined;
  loadIssue?:
    | ((
        application: ApplicationExecution | undefined,
      ) => Promise<AutorunIssueCandidate>)
    | undefined;
  beforeWorkflow?:
    | ((
        attemptMetadata: AttemptMetadata,
        application: ApplicationExecution,
      ) => void | Promise<void>)
    | undefined;
  beforeRun?:
    | ((
        attemptMetadata: AttemptMetadata,
        application: ApplicationExecution,
      ) => Promise<void>)
    | undefined;
  afterRun?:
    | ((
        attemptMetadata: AttemptMetadata,
      ) => Effect.Effect<void, unknown, ApplicationServices>)
    | undefined;
  runner?: AgentRunner | undefined;
  logPrefix?: string | undefined;
  inProgressOutcomeDetail?: string | null | undefined;
  initialVerificationRepairPass?: number | undefined;
  issueSnapshot?: GitHubIssueSnapshot | undefined;
}

export interface AutorunAttemptResult {
  issueNumber: number;
  outcome: AttemptOutcome;
  outcomeDetail: string | null;
}

export interface RunAutorunAttemptLifecycleInjected {
  clock?: Clock | undefined;
  runFullWorkflow?: typeof runFullWorkflow | undefined;
  completeAutorunWorkflow?: typeof completeAutorunWorkflow | undefined;
  publishReviewLedgerComments?: typeof publishReviewLedgerComments | undefined;
  publishPlanningLedgerComments?:
    | typeof publishPlanningLedgerComments
    | undefined;
  markIssueFailed?: typeof markIssueFailed | undefined;
  finalizeAttemptObservability?:
    | typeof finalizeAttemptObservabilityPromise
    | undefined;
}

export const runAutorunAttemptLifecycle = Effect.fn(
  "runAutorunAttemptLifecycle",
)(function* (
  input: RunAutorunAttemptLifecycleInput,
  injected: RunAutorunAttemptLifecycleInjected = {},
) {
  const observer =
    input.workflowContext.observer ??
    (yield* createFileRunObserver(input.workflowContext));
  input.workflowContext.observer = observer;
  const clock = injected.clock ?? defaultClock;
  const runWorkflow = injected.runFullWorkflow ?? runFullWorkflow;
  const completeWorkflow =
    injected.completeAutorunWorkflow ?? completeAutorunWorkflow;
  const injectedFinalize = injected.finalizeAttemptObservability;
  const finalizeObservability = (
    input: Parameters<typeof finalizeAttemptObservability>[0],
  ) =>
    injectedFinalize
      ? fromLegacyPromise(() => injectedFinalize(input))
      : finalizeAttemptObservability(input);

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
      fromLegacyPromise(async (application) => {
        await input.beforeWorkflow?.(attemptMetadata, application);
        await runApplicationPromise(
          attempts.persist(input.issueDir, attemptMetadata),
          application,
        );

        await input.beforeRun?.(attemptMetadata, application);
        await runApplicationPromise(
          attempts.persist(input.issueDir, attemptMetadata),
          application,
        );

        const workflowResult =
          input.initialVerificationRepairPass === undefined
            ? await runWorkflow(
                input.workflowContext,
                input.runner,
                { issueSnapshot: input.issueSnapshot },
                application,
              )
            : await runVerificationRepairWorkflow(
                input.workflowContext,
                input.initialVerificationRepairPass,
                input.runner,
                application,
              );
        const issue = await resolveIssue(input, application);
        const attemptMetadataPath =
          attemptMetadataRelativePath(attemptMetadata);
        let completionOutcome = await completeWorkflow(
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
          application,
        );

        while (completionOutcome.outcome === "verification-needs-fix") {
          const repairResult = await runVerificationRepairWorkflow(
            input.workflowContext,
            completionOutcome.pass,
            input.runner,
            application,
          );
          completionOutcome = await completeWorkflow(
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
            application,
          );
        }

        const terminalOutcome = completionOutcome;
        outcome = terminalOutcome.outcome;
        outcomeDetail = terminalOutcome.outcomeDetail;
        return {
          issueNumber: input.attemptMetadata.issueNumber,
          outcome,
          outcomeDetail,
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
            ? fromLegacyPromise((application) =>
                markWorkflowError(
                  input,
                  injected,
                  attemptMetadata,
                  Cause.squash(exit.cause),
                  application,
                ),
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
          const endedAt = clock.now();
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

export function runAutorunAttemptLifecyclePromise(
  input: RunAutorunAttemptLifecycleInput,
  injected: RunAutorunAttemptLifecycleInjected = {},
  application?: ApplicationExecution,
): Promise<AutorunAttemptResult> {
  return runApplicationPromise(
    runAutorunAttemptLifecycle(input, injected),
    application,
  );
}

async function runVerificationRepairWorkflow(
  context: WorkflowContext,
  initialPass: number,
  runner?: AgentRunner,
  application?: ApplicationExecution,
): Promise<WorkflowRunResult> {
  for (let pass = initialPass; pass <= context.maxFixPasses; pass++) {
    presenter(application).line(`Verification repair pass ${pass}`);
    await fixPhase(context, pass, runner, application);
    await codeRefinementPhase(context, pass, runner, application);
    const reviews = await reviewPhase(context, pass, runner, application);
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
    presenter(application).line(
      `Review requested more fixes; continuing to fix pass ${pass + 1}`,
    );
  }
  await readinessPhase(context, application);
  return { status: "completed" };
}

async function markWorkflowError(
  input: RunAutorunAttemptLifecycleInput,
  injected: RunAutorunAttemptLifecycleInjected,
  attemptMetadata: AttemptMetadata,
  error: unknown,
  application?: ApplicationExecution,
): Promise<void> {
  const issue = await resolveIssue(input, application);
  const phase = errorPhase(error);
  const attemptMetadataPath = attemptMetadataRelativePath(attemptMetadata);
  const command = recoveryCommand(input, shouldRecoverWithYes(error));
  const prefix = input.logPrefix ?? "Auto";
  const publishPlanning =
    injected.publishPlanningLedgerComments ?? publishPlanningLedgerComments;
  const publishLedger =
    injected.publishReviewLedgerComments ?? publishReviewLedgerComments;
  const markFailed = injected.markIssueFailed ?? markIssueFailed;

  presenter(application).line(
    `${prefix} workflow error on #${issue.number}: ${formatError(error)}`,
  );
  presenter(application).artifact(attemptMetadataPath);
  presenter(application).recovery(command);

  await publishPlanning(
    {
      cwd: input.gateOptions.cwd,
      repo: input.gateOptions.repo,
      issue,
      workflowContext: input.workflowContext,
      attemptMetadata,
    },
    undefined,
    application,
  );

  await publishLedger(
    {
      cwd: input.gateOptions.cwd,
      repo: input.gateOptions.repo,
      issue,
      workflowContext: input.workflowContext,
      attemptMetadata,
    },
    undefined,
    application,
  );

  const errorArtifact = await readErrorArtifact(
    input.workflowContext,
    error,
    application,
  );
  if (errorArtifact) presenter(application).artifact(errorArtifact.path);

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

  await markFailed(
    {
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
    },
    application,
  );
}

async function resolveIssue(
  input: RunAutorunAttemptLifecycleInput,
  application?: ApplicationExecution,
): Promise<AutorunIssueCandidate> {
  if (input.issue) return input.issue;
  if (input.loadIssue) {
    try {
      return await input.loadIssue(application);
    } catch {
      // Preserve the original workflow/completion error; issue details are best-effort in failure handling.
    }
  }
  return {
    number: input.attemptMetadata.issueNumber,
    title: `Fix issue #${input.attemptMetadata.issueNumber}`,
  };
}

async function readErrorArtifact(
  context: WorkflowContext,
  error: unknown,
  application?: ApplicationExecution,
): Promise<{ path: string; content: string } | undefined> {
  const artifact =
    error instanceof AgentTaskRunError ||
    error instanceof ArtifactValidationError
      ? error.artifact
      : undefined;
  if (artifact === undefined) return undefined;
  try {
    return {
      path: artifactRelativePath(context, artifact),
      content: await readArtifact(context, artifact, application),
    };
  } catch {
    return undefined;
  }
}

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
    error instanceof ArtifactValidationError ||
    (error instanceof AgentTaskRunError && error.phase === "output-contract")
  );
}

function errorPhase(error: unknown): string {
  if (error instanceof AgentTaskRunError) return error.phase;
  if (error instanceof ArtifactValidationError) return "output-contract";
  return "workflow-error";
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
