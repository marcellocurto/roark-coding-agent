import { artifactRelativePath, readArtifact, type WorkflowContext } from "../workflow/artifacts.ts";
import { ArtifactValidationError } from "../workflow/artifact-validation.ts";
import type { AgentRunner } from "../workflow/agent-runner.ts";
import { runFullWorkflow, type WorkflowRunResult } from "../workflow/phases.ts";
import { AgentTaskRunError } from "../workflow/tasks.ts";
import { finalizeAttemptObservability } from "./observability.ts";
import {
  attemptMetadataRelativePath,
  formatAttemptMetadata,
  summarizeAttempt,
  updateAttemptIndex,
  writeAttemptMetadata,
  type AttemptMetadata,
  type AttemptOutcome,
  type Clock,
  defaultClock,
} from "./attempts.ts";
import type { AutorunBranchPlan } from "./branch.ts";
import { completeAutorunWorkflow } from "./completion.ts";
import { formatFailureComment, markIssueFailed } from "./failure.ts";
import { publishReviewLedgerComments } from "./ledger-comments.ts";
import type { AutorunGateOptions } from "./publish-flow.ts";
import { formatContinueCommand, shouldRecoverWithYes } from "./recovery.ts";
import type { AutorunIssueCandidate } from "./selection.ts";

export type RunAutorunAttemptLifecycleInput = {
  issueDir: string;
  workflowContext: WorkflowContext;
  branchPlan: AutorunBranchPlan;
  gateOptions: AutorunGateOptions;
  attemptMetadata: AttemptMetadata;
  issue?: AutorunIssueCandidate;
  loadIssue?: () => Promise<AutorunIssueCandidate>;
  beforeWorkflow?: (attemptMetadata: AttemptMetadata) => Promise<void>;
  beforeRun?: (attemptMetadata: AttemptMetadata) => Promise<void>;
  afterRun?: (attemptMetadata: AttemptMetadata) => Promise<void>;
  runner?: AgentRunner;
  logPrefix?: string;
  inProgressOutcomeDetail?: string | null;
};

export type RunAutorunAttemptLifecycleInjected = {
  clock?: Clock;
  runFullWorkflow?: (context: WorkflowContext, runner?: AgentRunner) => Promise<WorkflowRunResult>;
  completeAutorunWorkflow?: typeof completeAutorunWorkflow;
  publishReviewLedgerComments?: typeof publishReviewLedgerComments;
  markIssueFailed?: typeof markIssueFailed;
  finalizeAttemptObservability?: typeof finalizeAttemptObservability;
};

export async function runAutorunAttemptLifecycle(
  input: RunAutorunAttemptLifecycleInput,
  injected: RunAutorunAttemptLifecycleInjected = {},
): Promise<void> {
  const clock = injected.clock ?? defaultClock;
  const runWorkflow = injected.runFullWorkflow ?? runFullWorkflow;
  const completeWorkflow = injected.completeAutorunWorkflow ?? completeAutorunWorkflow;
  const finalizeObservability = injected.finalizeAttemptObservability ?? finalizeAttemptObservability;

  let attemptMetadata = formatAttemptMetadata({
    ...input.attemptMetadata,
    worktreePath: input.workflowContext.agentCwd,
    runArtifactPath: input.workflowContext.runDirRelative,
    endedAt: null,
    outcome: "in-progress",
    outcomeDetail: input.inProgressOutcomeDetail ?? null,
  });
  await persistAttempt(input.issueDir, attemptMetadata);

  let outcome: AttemptOutcome = "in-progress";
  let outcomeDetail: string | null = null;

  try {
    await input.beforeWorkflow?.(attemptMetadata);
    await persistAttempt(input.issueDir, attemptMetadata);

    await input.beforeRun?.(attemptMetadata);
    await persistAttempt(input.issueDir, attemptMetadata);

    const workflowResult = await runWorkflow(input.workflowContext, input.runner);
    const issue = await resolveIssue(input);
    const attemptMetadataPath = attemptMetadataRelativePath(attemptMetadata);
    const completionOutcome = await completeWorkflow({
      workflowResult,
      options: input.gateOptions,
      issue,
      branchPlan: input.branchPlan,
      workflowContext: input.workflowContext,
      attemptMetadata,
      attemptMetadataPath,
      recoveryCommand: recoveryCommand(input, false),
    });
    outcome = completionOutcome.outcome;
    outcomeDetail = completionOutcome.outcomeDetail;
  } catch (error) {
    outcome = isOutputContractError(error) ? "failed-output-contract" : "errored";
    outcomeDetail = formatError(error);
    await markWorkflowError(input, injected, attemptMetadata, error);
    throw error;
  } finally {
    try {
      await input.afterRun?.(attemptMetadata);
    } catch (error) {
      console.warn(`afterRun hook failed: ${formatError(error)}`);
    }
    const endedAt = clock.now();
    attemptMetadata = formatAttemptMetadata({
      ...attemptMetadata,
      endedAt,
      outcome,
      outcomeDetail,
    });
    await persistAttempt(input.issueDir, attemptMetadata);
    await finalizeObservability({
      context: input.workflowContext,
      outcome,
      outcomeDetail,
      endedAt,
    });
  }
}

async function persistAttempt(issueDir: string, attemptMetadata: AttemptMetadata): Promise<void> {
  await writeAttemptMetadata(issueDir, attemptMetadata);
  await updateAttemptIndex(issueDir, summarizeAttempt(attemptMetadata));
}

async function markWorkflowError(
  input: RunAutorunAttemptLifecycleInput,
  injected: RunAutorunAttemptLifecycleInjected,
  attemptMetadata: AttemptMetadata,
  error: unknown,
): Promise<void> {
  const issue = await resolveIssue(input);
  const phase = errorPhase(error);
  const attemptMetadataPath = attemptMetadataRelativePath(attemptMetadata);
  const command = recoveryCommand(input, shouldRecoverWithYes(error));
  const prefix = input.logPrefix ?? "Auto";
  const publishLedger = injected.publishReviewLedgerComments ?? publishReviewLedgerComments;
  const markFailed = injected.markIssueFailed ?? markIssueFailed;

  console.log(`\n${prefix} workflow error on #${issue.number}: ${formatError(error)}`);
  console.log(`Attempt: ${attemptMetadataPath}`);
  console.log(`Continue: ${command}`);

  await publishLedger({
    cwd: input.gateOptions.cwd,
    repo: input.gateOptions.repo,
    issue,
    workflowContext: input.workflowContext,
    attemptMetadata,
  });

  const errorArtifact = await readErrorArtifact(input.workflowContext, error);
  if (errorArtifact) console.log(`Artifact: ${errorArtifact.path}`);

  const comment = formatFailureComment({
    issueNumber: issue.number,
    issueUrl: issue.url,
    phase,
    reason: formatError(error),
    branchName: attemptMetadata.branch,
    worktreePath: attemptMetadata.worktreePath,
    workspacePath: attemptMetadata.workspace?.path,
    artifactPath: errorArtifact?.path,
    artifactContent: errorArtifact?.content,
    attemptMetadataPath,
    recoveryCommand: command,
  });

  await markFailed({
    cwd: input.gateOptions.cwd,
    repo: input.gateOptions.repo,
    issueNumber: issue.number,
    label: input.gateOptions.failureLabel,
    comment,
    removeLabels: [input.gateOptions.inProgressLabel],
  });
}

async function resolveIssue(input: RunAutorunAttemptLifecycleInput): Promise<AutorunIssueCandidate> {
  if (input.issue) return input.issue;
  if (input.loadIssue) {
    try {
      return await input.loadIssue();
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
): Promise<{ path: string; content: string } | undefined> {
  const artifact = error instanceof AgentTaskRunError || error instanceof ArtifactValidationError
    ? error.artifact
    : undefined;
  if (!artifact) return undefined;
  try {
    return {
      path: artifactRelativePath(context, artifact),
      content: await readArtifact(context, artifact),
    };
  } catch {
    return undefined;
  }
}

function recoveryCommand(input: RunAutorunAttemptLifecycleInput, yes: boolean): string {
  return formatContinueCommand({
    issueNumber: input.attemptMetadata.issueNumber,
    cwd: input.gateOptions.cwd,
    repo: input.gateOptions.repo,
    attempt: input.attemptMetadata.attempt,
    yes,
  });
}

function isOutputContractError(error: unknown): boolean {
  return error instanceof ArtifactValidationError ||
    (error instanceof AgentTaskRunError && error.phase === "output-contract");
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
