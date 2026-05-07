import path from "node:path";
import type { AutoCliOptions } from "../cli/args.ts";
import {
  claimGitHubIssue,
  fetchGitHubIssue,
  fetchGitHubIssueRelationships,
  getCurrentGitHubLogin,
  listOpenGitHubIssues,
  resolveGitHubIssueRepo,
  type GitHubIssue,
  type GitHubIssueDependency,
} from "../github/issue.ts";
import { ensureRunDir } from "../workflow/artifacts.ts";
import { assertCleanAutorunGit } from "../workflow/git.ts";
import { runFullWorkflow } from "../workflow/phases.ts";
import {
  allocateNextAttempt,
  attemptMetadataRelativePath,
  defaultClock,
  formatAttemptMetadata,
  type AttemptMetadata,
  type Clock,
} from "./attempts.ts";
import { checkoutIssueBranch, createBranchPlan } from "./branch.ts";
import { createClaimPlan } from "./claim.ts";
import { completeAutorunWorkflow } from "./completion.ts";
import { formatAttemptStartComment, publishIssueLedgerComment } from "./ledger-comments.ts";
import { runAutorunAttemptLifecycle } from "./attempt-lifecycle.ts";
import { findMatchingSkipLabel, rankEligibleIssues, type AutorunIssueCandidate } from "./selection.ts";
import { createAutorunWorkflowContext } from "./workflow.ts";

const discoveryFetchLimit = 100;

type AutoRunInjected = {
  clock?: Clock;
  listOpenGitHubIssues?: typeof listOpenGitHubIssues;
  fetchGitHubIssue?: typeof fetchGitHubIssue;
  fetchGitHubIssueRelationships?: typeof fetchGitHubIssueRelationships;
  resolveGitHubIssueRepo?: typeof resolveGitHubIssueRepo;
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
  const rankedCandidates = rankEligibleIssues(issues, {
    readyLabel: options.readyLabel,
    skipLabels: options.skipLabels,
    limit: options.limit,
  });
  const { selected, skippedBlocked } = await selectDependencyClearIssues(rankedCandidates, options, injected);

  printSkippedBlockedIssues(skippedBlocked);

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

type SkippedBlockedIssue = {
  issue: AutorunIssueCandidate;
  blockers: GitHubIssueDependency[];
};

async function selectDependencyClearIssues(
  candidates: readonly AutorunIssueCandidate[],
  options: AutoCliOptions,
  injected: AutoRunInjected,
): Promise<{ selected: AutorunIssueCandidate[]; skippedBlocked: SkippedBlockedIssue[] }> {
  const selected: AutorunIssueCandidate[] = [];
  const skippedBlocked: SkippedBlockedIssue[] = [];
  if (options.limit <= 0) return { selected, skippedBlocked };

  const fetchRelationships = injected.fetchGitHubIssueRelationships ?? fetchGitHubIssueRelationships;
  const resolveRepo = injected.resolveGitHubIssueRepo ?? resolveGitHubIssueRepo;

  for (const issue of candidates) {
    if (selected.length >= options.limit) break;

    const repo = await resolveRepo({ cwd: options.cwd, explicitRepo: options.repo, issueUrl: issue.url });
    const relationships = await fetchRelationships({
      cwd: options.cwd,
      repo,
      issueNumber: issue.number,
      body: "",
    });

    if (!relationships.nativeDependenciesAvailable) {
      const reason = relationships.unavailableReason ? `: ${relationships.unavailableReason}` : "";
      throw new Error(`Could not verify native GitHub dependencies for issue #${issue.number}${reason}. Refusing to run unchecked discovery candidate.`);
    }

    const activeBlockers = relationships.blockedBy
      .filter((blocker) => blocker.state !== "CLOSED")
      .toSorted(compareDependencyByNumber);

    if (activeBlockers.length > 0) {
      skippedBlocked.push({ issue, blockers: activeBlockers });
      continue;
    }

    selected.push(issue);
  }

  return { selected, skippedBlocked };
}

function compareDependencyByNumber(left: GitHubIssueDependency, right: GitHubIssueDependency): number {
  if (left.number !== right.number) return left.number - right.number;
  return left.title.localeCompare(right.title);
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

  const attemptMetadata: AttemptMetadata = formatAttemptMetadata({
    attempt,
    issueNumber: issue.number,
    branch: branchPlan.branchName,
    baseBranch: branchPlan.baseBranch,
    worktreePath: workflowContext.cwd,
    runArtifactPath: workflowContext.runDirRelative,
    startedAt: clock.now(),
  });

  await runAutorunAttemptLifecycle({
    issueDir,
    workflowContext,
    branchPlan,
    gateOptions: options,
    attemptMetadata,
    issue,
    logPrefix: "Auto",
    beforeWorkflow: async (metadata) => {
      const publishLedger = injected.publishIssueLedgerComment ?? publishIssueLedgerComment;
      await publishLedger({
        cwd: options.cwd,
        repo: options.repo,
        issueNumber: issue.number,
        attemptMetadata: metadata,
        phase: "attempt-start",
        body: formatAttemptStartComment({
          issueNumber: issue.number,
          attempt,
          branchName: branchPlan.branchName,
          assignee,
          attemptMetadataPath: attemptMetadataRelativePath(metadata),
        }),
      });
    },
  }, {
    clock,
    runFullWorkflow: injected.runFullWorkflow,
    completeAutorunWorkflow: injected.completeAutorunWorkflow,
  });
}

async function resolveAssignee(options: AutoCliOptions, injected: AutoRunInjected): Promise<string | undefined> {
  if (options.noAssign) return undefined;
  const getLogin = injected.getCurrentGitHubLogin ?? getCurrentGitHubLogin;
  return options.assignee ?? await getLogin({ cwd: options.cwd });
}

function printSkippedBlockedIssues(skipped: readonly SkippedBlockedIssue[]): void {
  if (skipped.length === 0) return;

  console.log("\nSkipped issue(s) with active native blockers:");
  for (const skippedIssue of skipped) {
    console.log(`- #${skippedIssue.issue.number} ${skippedIssue.issue.title}${skippedIssue.issue.url ? ` (${skippedIssue.issue.url})` : ""}`);
    for (const blocker of skippedIssue.blockers) {
      console.log(`  - blocked by #${blocker.number} ${blocker.title} [${blocker.state}]${blocker.url ? ` (${blocker.url})` : ""}`);
    }
  }
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
