import type { AutoCliOptions } from "../cli/args.ts";
import { claimGitHubIssue, getCurrentGitHubLogin, listOpenGitHubIssues } from "../github/issue.ts";
import { runFullWorkflow } from "../workflow/phases.ts";
import { createClaimPlan } from "./claim.ts";
import { createAutorunWorkflowContext } from "./workflow.ts";
import { createIssueWorktree, createWorktreePlan } from "./worktree.ts";
import { selectEligibleIssues } from "./selection.ts";

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
    await runFullWorkflow(createAutorunWorkflowContext(issue, worktreePlan, options));
  }

  console.log("\nAuto workflow complete.");
}

async function resolveAssignee(options: AutoCliOptions): Promise<string | undefined> {
  if (options.noAssign) return undefined;
  return options.assignee ?? await getCurrentGitHubLogin({ cwd: options.cwd });
}
