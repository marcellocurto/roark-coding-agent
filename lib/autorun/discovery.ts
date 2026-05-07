import path from "node:path";
import type { AutoCliOptions } from "../cli/args.ts";
import { claimGitHubIssue, fetchGitHubIssue, getCurrentGitHubLogin, listOpenGitHubIssues, type GitHubIssue } from "../github/issue.ts";
import { ArtifactValidationError } from "../workflow/artifact-validation.ts";
import { artifactRelativePath, ensureRunDir, readArtifact, type WorkflowContext } from "../workflow/artifacts.ts";
import { assertCleanAutorunGit } from "../workflow/git.ts";
import { runFullWorkflow } from "../workflow/phases.ts";
import { AgentTaskRunError } from "../workflow/tasks.ts";
import {
  allocateNextAttempt,
  attemptMetadataRelativePath,
  defaultClock,
  formatAttemptMetadata,
  summarizeAttempt,
  updateAttemptIndex,
  writeAttemptMetadata,
  type AttemptMetadata,
  type AttemptOutcome,
  type Clock,
} from "./attempts.ts";
import { checkoutIssueBranch, createBranchPlan } from "./branch.ts";
import { createClaimPlan } from "./claim.ts";
import { completeAutorunWorkflow } from "./completion.ts";
import { formatFailureComment, markIssueFailed } from "./failure.ts";
import { formatAttemptStartComment, publishIssueLedgerComment, publishReviewLedgerComments } from "./ledger-comments.ts";
import { formatContinueCommand, shouldRecoverWithYes } from "./recovery.ts";
import { findMatchingSkipLabel, selectEligibleIssues, type AutorunIssueCandidate } from "./selection.ts";
import { createAutorunWorkflowContext } from "./workflow.ts";

const discoveryFetchLimit = 100;

type AutoRunInjected = {
  clock?: Clock;
  listOpenGitHubIssues?: typeof listOpenGitHubIssues;
  fetchGitHubIssue?: typeof fetchGitHubIssue;
  assertCleanAutorunGit?: typeof assertCleanAutorunGit;
  getCurrentGitHubLogin?: typeof getCurrentGitHubLogin;
  claimGitHubIssue?: typeof claimGitHubIssue;
  checkoutIssueBranch?: typeof checkoutIssueBranch;
  runFullWorkflow?: typeof runFullWorkflow;
  completeAutorunWorkflow?: typeof completeAutorunWorkflow;
  publishIssueLedgerComment?: typeof publishIssueLedgerComment;
};

export async function runAutoDiscovery(
  options: AutoCliOptions,
  injected: AutoRunInjected = {},
): Promise<void> {
  if (options.issue) {
    await runTargetedAuto(options, injected);
    return;
  }
  await runDiscoveryAuto(options, injected);
}

async function runDiscoveryAuto(options: AutoCliOptions, injected: AutoRunInjected): Promise<void> {
  console.log("\n=== Auto issue discovery ===");
  console.log(`Ready label: ${options.readyLabel}`);
  console.log(`Skip labels: ${options.skipLabels.join(", ") || "none"}`);
  console.log(`Selection limit: ${options.limit}`);
  console.log(`Mode: ${options.dryRun ? "dry run" : "claim + branch + workflow"}`);

  const listIssues = injected.listOpenGitHubIssues ?? listOpenGitHubIssues;
  const issues = await listIssues({
    cwd: options.cwd,
    repo: options.repo,
    limit: discoveryFetchLimit,
  });
  const selected = selectEligibleIssues(issues, {
    readyLabel: options.readyLabel,
    skipLabels: options.skipLabels,
    limit: options.limit,
  });

  if (selected.length === 0) {
    console.log("\nNo eligible issues found.");
    return;
  }

  printSelectedIssues(selected);

  if (options.dryRun) {
    console.log("\nDry run: no issues were claimed and no branches were changed.");
    return;
  }

  await runManagedIssueAttempts(selected, options, injected);
}

async function runTargetedAuto(options: AutoCliOptions, injected: AutoRunInjected): Promise<void> {
  if (!options.issue) throw new Error("Targeted auto requires an issue.");

  console.log("\n=== Targeted auto issue ===");
  console.log(`Target issue: ${options.issue}`);
  console.log(`Skip labels: ${options.skipLabels.join(", ") || "none"}`);
  console.log(`Mode: ${options.dryRun ? "dry run" : "claim + branch + workflow"}`);

  const fetchIssue = injected.fetchGitHubIssue ?? fetchGitHubIssue;
  const fetched = await fetchIssue(options.issue, { cwd: options.cwd, repo: options.repo });
  const runOptions: AutoCliOptions = { ...options, repo: fetched.repo ?? options.repo };
  const issue = toAutorunIssueCandidate(fetched.issue);

  const skipLabel = findMatchingSkipLabel(issue, runOptions.skipLabels);
  if (skipLabel) {
    throw new Error(
      `Issue #${issue.number} has skip label ${skipLabel}.\n` +
        `Use continue ${issue.number} if this is an existing attempt, or remove the label.`,
    );
  }

  printSelectedIssues([issue]);

  if (runOptions.dryRun) {
    console.log("\nDry run: no issues were claimed and no branches were changed.");
    return;
  }

  await runManagedIssueAttempts([issue], runOptions, injected);
}

async function runManagedIssueAttempts(
  issues: readonly AutorunIssueCandidate[],
  options: AutoCliOptions,
  injected: AutoRunInjected,
): Promise<void> {
  const assignee = await resolveAssignee(options, injected);
  console.log(`\nClaiming issue(s) with label: ${options.inProgressLabel}`);
  if (assignee) console.log(`Assignee: ${assignee}`);
  else console.log("Assignee: none");

  const clock = injected.clock ?? defaultClock;
  for (const issue of issues) {
    await runManagedIssueAttempt(issue, options, assignee, clock, injected);
  }

  console.log("\nAuto workflow complete.");
}

async function runManagedIssueAttempt(
  issue: AutorunIssueCandidate,
  options: AutoCliOptions,
  assignee: string | undefined,
  clock: Clock,
  injected: AutoRunInjected,
): Promise<void> {
  const preflight = injected.assertCleanAutorunGit ?? assertCleanAutorunGit;
  await preflight({ cwd: options.cwd });

  const claimPlan = createClaimPlan(issue, { inProgressLabel: options.inProgressLabel, assignee });
  const branchPlan = createBranchPlan({
    issueNumber: claimPlan.issueNumber,
    branchName: claimPlan.branchName,
    baseBranch: options.baseBranch,
  });

  const issueDir = path.resolve(options.cwd, ".roark/runs", "issue", String(issue.number));
  const attempt = await allocateNextAttempt(issueDir);

  console.log(`- Claiming #${claimPlan.issueNumber} for branch ${claimPlan.branchName}`);
  const claimIssue = injected.claimGitHubIssue ?? claimGitHubIssue;
  await claimIssue({ cwd: options.cwd, repo: options.repo, plan: claimPlan, postComment: false });

  console.log(`- Switching to branch ${branchPlan.branchName}`);
  const checkoutBranch = injected.checkoutIssueBranch ?? checkoutIssueBranch;
  await checkoutBranch({ cwd: options.cwd, plan: branchPlan });

  console.log(`- Running full workflow on branch ${branchPlan.branchName} (attempt ${attempt})`);
  const workflowContext = createAutorunWorkflowContext(issue, branchPlan, options, attempt);
  await ensureRunDir(workflowContext);

  let attemptMetadata: AttemptMetadata = formatAttemptMetadata({
    attempt,
    issueNumber: issue.number,
    branch: branchPlan.branchName,
    baseBranch: branchPlan.baseBranch,
    worktreePath: workflowContext.cwd,
    runArtifactPath: workflowContext.runDirRelative,
    startedAt: clock.now(),
  });
  await writeAttemptMetadata(issueDir, attemptMetadata);
  await updateAttemptIndex(issueDir, summarizeAttempt(attemptMetadata));

  const publishLedger = injected.publishIssueLedgerComment ?? publishIssueLedgerComment;
  await publishLedger({
    cwd: options.cwd,
    repo: options.repo,
    issueNumber: issue.number,
    attemptMetadata,
    phase: "attempt-start",
    body: formatAttemptStartComment({
      issueNumber: issue.number,
      attempt,
      branchName: branchPlan.branchName,
      assignee,
      attemptMetadataPath: attemptMetadataRelativePath(attemptMetadata),
    }),
  });
  await writeAttemptMetadata(issueDir, attemptMetadata);

  let outcome: AttemptOutcome = "in-progress";
  let outcomeDetail: string | null = null;

  try {
    const runWorkflow = injected.runFullWorkflow ?? runFullWorkflow;
    const workflowResult = await runWorkflow(workflowContext);

    const attemptMetadataPath = attemptMetadataRelativePath(attemptMetadata);
    const completeWorkflow = injected.completeAutorunWorkflow ?? completeAutorunWorkflow;
    const completionOutcome = await completeWorkflow({
      workflowResult,
      options,
      issue,
      branchPlan,
      workflowContext,
      attemptMetadata,
      attemptMetadataPath,
      recoveryCommand: formatContinueCommand({ issueNumber: issue.number, repo: options.repo, attempt }),
    });
    outcome = completionOutcome.outcome;
    outcomeDetail = completionOutcome.outcomeDetail;
  } catch (error) {
    outcome = isOutputContractError(error) ? "failed-output-contract" : "errored";
    outcomeDetail = formatError(error);
    await markWorkflowError({
      options,
      issue,
      error,
      workflowContext,
      phase: errorPhase(error),
      attemptMetadataPath: attemptMetadataRelativePath(attemptMetadata),
      recoveryCommand: formatContinueCommand({ issueNumber: issue.number, repo: options.repo, attempt, yes: shouldRecoverWithYes(error) }),
      attemptMetadata,
    });
    throw error;
  } finally {
    attemptMetadata = formatAttemptMetadata({
      ...attemptMetadata,
      endedAt: clock.now(),
      outcome,
      outcomeDetail,
    });
    await writeAttemptMetadata(issueDir, attemptMetadata);
    await updateAttemptIndex(issueDir, summarizeAttempt(attemptMetadata));
  }
}

async function markWorkflowError(input: {
  options: AutoCliOptions;
  issue: AutorunIssueCandidate;
  error: unknown;
  workflowContext: WorkflowContext;
  phase: string;
  attemptMetadataPath: string;
  recoveryCommand: string;
  attemptMetadata: AttemptMetadata;
}): Promise<void> {
  const { options, issue, error, workflowContext, phase, attemptMetadataPath, recoveryCommand, attemptMetadata } = input;
  console.log(`\nAuto workflow error on #${issue.number}: ${formatError(error)}`);
  console.log(`Attempt: ${attemptMetadataPath}`);
  console.log(`Continue: ${recoveryCommand}`);

  await publishReviewLedgerComments({
    cwd: options.cwd,
    repo: options.repo,
    issue,
    workflowContext,
    attemptMetadata,
  });

  const errorArtifact = await readErrorArtifact(workflowContext, error);
  if (errorArtifact) console.log(`Artifact: ${errorArtifact.path}`);

  const comment = formatFailureComment({
    issueNumber: issue.number,
    issueUrl: issue.url,
    phase,
    reason: formatError(error),
    artifactPath: errorArtifact?.path,
    artifactContent: errorArtifact?.content,
    attemptMetadataPath,
    recoveryCommand,
  });

  await markIssueFailed({
    cwd: options.cwd,
    repo: options.repo,
    issueNumber: issue.number,
    label: options.failureLabel,
    comment,
    removeLabels: [options.inProgressLabel],
  });
}

async function readErrorArtifact(
  context: WorkflowContext,
  error: unknown,
): Promise<{ path: string; content: string } | undefined> {
  if (!(error instanceof AgentTaskRunError)) return undefined;
  try {
    return {
      path: artifactRelativePath(context, error.artifact),
      content: await readArtifact(context, error.artifact),
    };
  } catch {
    return undefined;
  }
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

async function resolveAssignee(options: AutoCliOptions, injected: AutoRunInjected): Promise<string | undefined> {
  if (options.noAssign) return undefined;
  const getLogin = injected.getCurrentGitHubLogin ?? getCurrentGitHubLogin;
  return options.assignee ?? await getLogin({ cwd: options.cwd });
}

function printSelectedIssues(issues: readonly AutorunIssueCandidate[]): void {
  console.log("\nSelected issue(s):");
  for (const issue of issues) {
    console.log(`- #${issue.number} ${issue.title}${issue.url ? ` (${issue.url})` : ""}`);
  }
}

function toAutorunIssueCandidate(issue: GitHubIssue): AutorunIssueCandidate {
  return {
    number: issue.number,
    title: issue.title,
    url: issue.url,
    labels: issue.labels,
  };
}
