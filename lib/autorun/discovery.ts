import path from "node:path";
import type { AutoCliOptions } from "../cli/args.ts";
import { claimGitHubIssue, getCurrentGitHubLogin, listOpenGitHubIssues } from "../github/issue.ts";
import { artifactRelativePath, ensureRunDir, readArtifact, type WorkflowContext } from "../workflow/artifacts.ts";
import { runFullWorkflow } from "../workflow/phases.ts";
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
import { formatFailureComment, markIssueFailed } from "./failure.ts";
import { runPublishGate } from "./publish-flow.ts";
import { formatContinueCommand } from "./recovery.ts";
import { markIssueTriageStopped } from "./triage-stop.ts";
import { createAutorunWorkflowContext } from "./workflow.ts";
import { selectEligibleIssues, type AutorunIssueCandidate } from "./selection.ts";
import { ArtifactValidationError } from "../workflow/artifact-validation.ts";
import { AgentTaskRunError } from "../workflow/tasks.ts";

const discoveryFetchLimit = 100;

export async function runAutoDiscovery(
  options: AutoCliOptions,
  injected: { clock?: Clock } = {},
): Promise<void> {
  const clock = injected.clock ?? defaultClock;
  console.log("\n=== Auto issue discovery ===");
  console.log(`Ready label: ${options.readyLabel}`);
  console.log(`Skip labels: ${options.skipLabels.join(", ") || "none"}`);
  console.log(`Selection limit: ${options.limit}`);
  console.log(`Mode: ${options.dryRun ? "dry run" : "claim + branch + workflow"}`);

  const issues = await listOpenGitHubIssues({
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

  console.log("\nSelected issue(s):");
  for (const issue of selected) {
    console.log(`- #${issue.number} ${issue.title}${issue.url ? ` (${issue.url})` : ""}`);
  }

  if (options.dryRun) {
    console.log("\nDry run: no issues were claimed and no branches were changed.");
    return;
  }

  const assignee = await resolveAssignee(options);
  console.log(`\nClaiming issue(s) with label: ${options.inProgressLabel}`);
  if (assignee) console.log(`Assignee: ${assignee}`);
  else console.log("Assignee: none");

  for (const issue of selected) {
    const claimPlan = createClaimPlan(issue, { inProgressLabel: options.inProgressLabel, assignee });
    const branchPlan = createBranchPlan({
      issueNumber: claimPlan.issueNumber,
      branchName: claimPlan.branchName,
      baseBranch: options.baseBranch,
    });

    console.log(`- Claiming #${claimPlan.issueNumber} for branch ${claimPlan.branchName}`);
    await claimGitHubIssue({ cwd: options.cwd, repo: options.repo, plan: claimPlan });

    console.log(`- Switching to branch ${branchPlan.branchName}`);
    await checkoutIssueBranch({ cwd: options.cwd, plan: branchPlan });

    const issueDir = path.resolve(options.cwd, ".roark/runs", "issue", String(issue.number));
    const attempt = await allocateNextAttempt(issueDir);

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

    let outcome: AttemptOutcome = "in-progress";
    let outcomeDetail: string | null = null;

    try {
      const workflowResult = await runFullWorkflow(workflowContext);

      const attemptMetadataPath = attemptMetadataRelativePath(attemptMetadata);
      if (workflowResult.status === "triage-stopped") {
        await markIssueTriageStopped({
          cwd: options.cwd,
          repo: options.repo,
          issueNumber: issue.number,
          issueUrl: issue.url,
          triageVerdict: workflowResult.triageVerdict,
          triageArtifactPath: artifactRelativePath(workflowContext, "triage"),
          attemptMetadataPath,
          removeLabels: [options.inProgressLabel],
        });
        outcome = "triage-stopped";
        outcomeDetail = `triage verdict is "${workflowResult.triageVerdict}"`;
      } else {
        const gateOutcome = await runPublishGate({
          options,
          issue,
          branchPlan,
          workflowContext,
          attemptMetadata,
          attemptMetadataPath,
          recoveryCommand: formatContinueCommand({ issueNumber: issue.number, repo: options.repo, attempt }),
        });
        outcome = gateOutcome.outcome;
        outcomeDetail = gateOutcome.outcomeDetail;
      }
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
        recoveryCommand: formatContinueCommand({ issueNumber: issue.number, repo: options.repo, attempt }),
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

  console.log("\nAuto workflow complete.");
}

async function markWorkflowError(input: {
  options: AutoCliOptions;
  issue: AutorunIssueCandidate;
  error: unknown;
  workflowContext: WorkflowContext;
  phase: string;
  attemptMetadataPath: string;
  recoveryCommand: string;
}): Promise<void> {
  const { options, issue, error, workflowContext, phase, attemptMetadataPath, recoveryCommand } = input;
  console.log(`\nAuto workflow error on #${issue.number}: ${formatError(error)}`);
  console.log(`Attempt: ${attemptMetadataPath}`);
  console.log(`Continue: ${recoveryCommand}`);

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

async function resolveAssignee(options: AutoCliOptions): Promise<string | undefined> {
  if (options.noAssign) return undefined;
  return options.assignee ?? await getCurrentGitHubLogin({ cwd: options.cwd });
}
