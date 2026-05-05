import path from "node:path";
import type { AutoCliOptions } from "../cli/args.ts";
import { claimGitHubIssue, getCurrentGitHubLogin, listOpenGitHubIssues } from "../github/issue.ts";
import { ensureRunDir, readArtifact, type WorkflowContext } from "../workflow/artifacts.ts";
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
import { checkoutIssueBranch, createBranchPlan, type AutorunBranchPlan } from "./branch.ts";
import { createClaimPlan } from "./claim.ts";
import { formatFailureComment, markIssueFailed } from "./failure.ts";
import { publishAutorunResult } from "./publish.ts";
import { decidePublish, parseReadinessStatus, type PublishGateDecision } from "./publish-gate.ts";
import { createAutorunWorkflowContext } from "./workflow.ts";
import { selectEligibleIssues, type AutorunIssueCandidate } from "./selection.ts";
import {
  runVerification,
  writeVerificationArtifact,
  type VerificationResult,
} from "./verification.ts";

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
      await runFullWorkflow(workflowContext);

      const gateOutcome = await runPublishGate({
        options,
        issue,
        branchPlan,
        workflowContext,
        attemptMetadata,
        attemptMetadataPath: attemptMetadataRelativePath(attemptMetadata),
      });
      outcome = gateOutcome.outcome;
      outcomeDetail = gateOutcome.outcomeDetail;
    } catch (error) {
      outcome = "errored";
      outcomeDetail = formatError(error);
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

type PublishGateOutcome = { outcome: AttemptOutcome; outcomeDetail: string | null };

async function runPublishGate(input: {
  options: AutoCliOptions;
  issue: AutorunIssueCandidate;
  branchPlan: AutorunBranchPlan;
  workflowContext: WorkflowContext;
  attemptMetadata: AttemptMetadata;
  attemptMetadataPath: string;
}): Promise<PublishGateOutcome> {
  const { options, issue, branchPlan, workflowContext, attemptMetadata, attemptMetadataPath } = input;

  const readinessMarkdown = await readReadinessArtifact(workflowContext);
  const readinessStatus = readinessMarkdown ? parseReadinessStatus(readinessMarkdown) : undefined;

  let verification: VerificationResult | undefined;
  if (readinessStatus === "ready-for-pr") {
    verification = await runVerification({ command: options.verifyCommand, cwd: workflowContext.cwd });
    await writeVerificationArtifact(workflowContext, verification);
  }

  const decision = decidePublish({ readinessStatus, verification });

  if (decision.publish) {
    await publishAutorunResult({
      options,
      issue,
      branchPlan,
      workflowContext,
      verification,
      attemptMetadata,
      attemptMetadataPath,
    });
    return { outcome: "published", outcomeDetail: null };
  }

  await handleNonPublish({ options, issue, workflowContext, decision, attemptMetadataPath });
  return {
    outcome: decision.phase === "verification" ? "failed-verification" : "failed-readiness",
    outcomeDetail: decision.reason,
  };
}

async function readReadinessArtifact(context: WorkflowContext): Promise<string | undefined> {
  try {
    return await readArtifact(context, "readiness");
  } catch {
    return undefined;
  }
}

async function handleNonPublish(input: {
  options: AutoCliOptions;
  issue: AutorunIssueCandidate;
  workflowContext: WorkflowContext;
  decision: Extract<PublishGateDecision, { publish: false }>;
  attemptMetadataPath: string;
}): Promise<void> {
  const { options, issue, workflowContext, decision, attemptMetadataPath } = input;
  const artifactPath = path.join(workflowContext.runDirRelative, decision.artifactPath);

  console.log(`\nNot publishing #${issue.number}: ${decision.phase} — ${decision.reason}.`);
  console.log(`Artifact: ${artifactPath}`);
  console.log(`Attempt: ${attemptMetadataPath}`);

  const comment = formatFailureComment({
    issueNumber: issue.number,
    phase: decision.phase,
    reason: decision.reason,
    artifactPath,
    attemptMetadataPath,
  });

  await markIssueFailed({
    cwd: options.cwd,
    repo: options.repo,
    issueNumber: issue.number,
    label: options.failureLabel,
    comment,
  });
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

async function resolveAssignee(options: AutoCliOptions): Promise<string | undefined> {
  if (options.noAssign) return undefined;
  return options.assignee ?? await getCurrentGitHubLogin({ cwd: options.cwd });
}
