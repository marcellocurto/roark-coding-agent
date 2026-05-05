import path from "node:path";
import type { AutoCliOptions } from "../cli/args.ts";
import { claimGitHubIssue, getCurrentGitHubLogin, listOpenGitHubIssues } from "../github/issue.ts";
import { readArtifact, type WorkflowContext } from "../workflow/artifacts.ts";
import { runFullWorkflow } from "../workflow/phases.ts";
import { createClaimPlan } from "./claim.ts";
import { formatFailureComment, markIssueFailed } from "./failure.ts";
import { decidePublish, parseReadinessStatus, type PublishGateDecision } from "./publish-gate.ts";
import { createAutorunWorkflowContext } from "./workflow.ts";
import { createIssueWorktree, createWorktreePlan } from "./worktree.ts";
import { selectEligibleIssues, type AutorunIssueCandidate } from "./selection.ts";
import {
  runVerification,
  writeVerificationArtifact,
  type VerificationResult,
} from "./verification.ts";

const discoveryFetchLimit = 100;

export async function runAutoDiscovery(options: AutoCliOptions): Promise<void> {
  console.log("\n=== Auto issue discovery ===");
  console.log(`Ready label: ${options.readyLabel}`);
  console.log(`Skip labels: ${options.skipLabels.join(", ") || "none"}`);
  console.log(`Selection limit: ${options.limit}`);
  console.log(`Mode: ${options.dryRun ? "dry run" : "claim + worktree + workflow"}`);

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
    console.log("\nDry run: no issues were claimed and no worktrees were created.");
    return;
  }

  const assignee = await resolveAssignee(options);
  console.log(`\nClaiming issue(s) with label: ${options.inProgressLabel}`);
  if (assignee) console.log(`Assignee: ${assignee}`);
  else console.log("Assignee: none");

  for (const issue of selected) {
    const claimPlan = createClaimPlan(issue, { inProgressLabel: options.inProgressLabel, assignee });
    const worktreePlan = createWorktreePlan({
      cwd: options.cwd,
      issueNumber: claimPlan.issueNumber,
      branchName: claimPlan.branchName,
      baseBranch: options.baseBranch,
      worktreeRoot: options.worktreeRoot,
    });

    console.log(`- Claiming #${claimPlan.issueNumber} for branch ${claimPlan.branchName}`);
    await claimGitHubIssue({ cwd: options.cwd, repo: options.repo, plan: claimPlan });

    console.log(`- Creating worktree ${worktreePlan.worktreePathRelative}`);
    await createIssueWorktree({ cwd: options.cwd, plan: worktreePlan });

    console.log(`- Running full workflow in ${worktreePlan.worktreePathRelative}`);
    const workflowContext = createAutorunWorkflowContext(issue, worktreePlan, options);
    await runFullWorkflow(workflowContext);

    await runPublishGate({
      options,
      issue,
      worktreePath: worktreePlan.worktreePath,
      workflowContext,
    });
  }

  console.log("\nAuto workflow complete.");
}

async function runPublishGate(input: {
  options: AutoCliOptions;
  issue: AutorunIssueCandidate;
  worktreePath: string;
  workflowContext: WorkflowContext;
}): Promise<void> {
  const { options, issue, worktreePath, workflowContext } = input;

  const readinessMarkdown = await readReadinessArtifact(workflowContext);
  const readinessStatus = readinessMarkdown ? parseReadinessStatus(readinessMarkdown) : undefined;

  let verification: VerificationResult | undefined;
  if (readinessStatus === "ready-for-pr") {
    verification = await runVerification({ command: options.verifyCommand, cwd: worktreePath });
    await writeVerificationArtifact(workflowContext, verification);
  }

  const decision = decidePublish({ readinessStatus, verification });

  if (decision.publish) {
    console.log("\nReady to publish (publish step not yet implemented).");
    return;
  }

  await handleNonPublish({ options, issue, workflowContext, decision });
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
}): Promise<void> {
  const { options, issue, workflowContext, decision } = input;
  const artifactPath = path.join(workflowContext.runDirRelative, decision.artifactPath);

  console.log(`\nNot publishing #${issue.number}: ${decision.phase} — ${decision.reason}.`);
  console.log(`Artifact: ${artifactPath}`);

  const comment = formatFailureComment({
    issueNumber: issue.number,
    phase: decision.phase,
    reason: decision.reason,
    artifactPath,
  });

  await markIssueFailed({
    cwd: options.cwd,
    repo: options.repo,
    issueNumber: issue.number,
    label: options.failureLabel,
    comment,
  });
}

async function resolveAssignee(options: AutoCliOptions): Promise<string | undefined> {
  if (options.noAssign) return undefined;
  return options.assignee ?? await getCurrentGitHubLogin({ cwd: options.cwd });
}
