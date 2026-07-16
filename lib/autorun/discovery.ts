import path from "node:path";
import type { AutoCliOptions } from "../cli/args.ts";
import { presenter } from "../presentation/presenter.ts";
import { displayIssueTarget } from "../cli/target.ts";
import {
  claimGitHubIssue,
  fetchGitHubIssue,
  fetchGitHubIssueRelationships,
  getCurrentGitHubLogin,
  listOpenGitHubIssues,
  resolveGitHubIssueRepo,
  type GitHubIssue,
  type GitHubIssueDependency,
  type GitHubIssueRelationships,
  type GitHubIssueSnapshot,
} from "../github/issue.ts";
import { ensureRunDir } from "../workflow/artifacts.ts";
import { assertCleanAutorunGit } from "../workflow/git.ts";
import { type runFullWorkflow } from "../workflow/phases.ts";
import {
  allocateNextAttempt,
  defaultClock,
  formatAttemptMetadata,
  type AttemptMetadata,
  type Clock,
} from "./attempts.ts";
import { createBranchPlan } from "./branch.ts";
import { createClaimPlan } from "./claim.ts";
import { ensureAutorunLabelContract, labelsToRemoveForAutorunTransition } from "./labels.ts";
import { type completeAutorunWorkflow } from "./completion.ts";
import { formatAttemptStartComment, publishIssueLedgerComment } from "./ledger-comments.ts";
import { runAutorunAttemptLifecycle, type AutorunAttemptResult } from "./attempt-lifecycle.ts";
import { withAutorunIssueLock } from "./lock.ts";
import { findMatchingSkipLabel, isEligibleIssue, rankEligibleIssues, type AutorunIssueCandidate } from "./selection.ts";
import { createAutorunWorkflowContext } from "./workflow.ts";
import { defaultLifecycleHooks, defaultWorkspaceConfig, prepareCloneWorkspace, refreshCopyToWorktree, runLifecycleHook } from "./workspace.ts";

const discoveryFetchLimit = 100;

interface AutoRunInjected {
  clock?: Clock | undefined;
  listOpenGitHubIssues?: typeof listOpenGitHubIssues | undefined;
  fetchGitHubIssue?: typeof fetchGitHubIssue | undefined;
  fetchGitHubIssueRelationships?: typeof fetchGitHubIssueRelationships | undefined;
  resolveGitHubIssueRepo?: typeof resolveGitHubIssueRepo | undefined;
  assertCleanAutorunGit?: typeof assertCleanAutorunGit | undefined;
  getCurrentGitHubLogin?: typeof getCurrentGitHubLogin | undefined;
  claimGitHubIssue?: typeof claimGitHubIssue | undefined;
  prepareCloneWorkspace?: typeof prepareCloneWorkspace | undefined;
  runFullWorkflow?: typeof runFullWorkflow | undefined;
  completeAutorunWorkflow?: typeof completeAutorunWorkflow | undefined;
  publishIssueLedgerComment?: typeof publishIssueLedgerComment | undefined;
  ensureAutorunLabelContract?: typeof ensureAutorunLabelContract | undefined;
}

export interface AutoDiscoveryResult {
  kind: "attempts" | "dry-run" | "no-eligible";
  attempts: AutorunAttemptResult[];
}

export async function runAutoDiscovery(
  options: AutoCliOptions,
  injected: AutoRunInjected = {},
): Promise<AutoDiscoveryResult> {
  presenter().transition(options.issue ? "Target lookup" : "Discovery", displayIssueTarget(options.issue, "auto"));
  await ensureRequiredLabelsBeforeIssueWork(options, injected);
  if (options.issue) return runTargetedAuto(options, injected);
  return runDiscoveryAuto(options, injected);
}

async function ensureRequiredLabelsBeforeIssueWork(options: AutoCliOptions, injected: AutoRunInjected): Promise<void> {
  const ensureLabels = injected.ensureAutorunLabelContract ?? ensureAutorunLabelContract;
  await ensureLabels({
    cwd: options.cwd,
    repo: options.repo,
    readyLabel: options.readyLabel,
    inProgressLabel: options.inProgressLabel,
    failureLabel: options.failureLabel,
    successLabel: options.successLabel,
    dryRun: options.dryRun,
  });
}

async function runDiscoveryAuto(options: AutoCliOptions, injected: AutoRunInjected): Promise<AutoDiscoveryResult> {
  presenter().line("Auto issue discovery");
  presenter().line(`Ready label: ${options.readyLabel}`);
  presenter().line(`Skip labels: ${options.skipLabels.join(", ") || "none"}`);
  presenter().line(`Selection limit: ${options.limit}`);
  presenter().line(`Mode: ${options.dryRun ? "dry run" : "claim + branch + workflow"}`);

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
    presenter().line("No eligible issues found");
    return { kind: "no-eligible", attempts: [] };
  }

  printSelectedIssues(selected);
  const selectedTarget = selected[0];
  if (selectedTarget) presenter().updateTarget(`#${selectedTarget.number}`);

  if (options.dryRun) {
    presenter().line("Dry run: no issues were claimed and no branches were changed");
    return { kind: "dry-run", attempts: [] };
  }

  return { kind: "attempts", attempts: await runManagedIssueAttempts(selected, options, injected, { requireReadyLabel: true }) };
}

interface SkippedBlockedIssue {
  issue: AutorunIssueCandidate;
  blockers: GitHubIssueDependency[];
}

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
      body: issue.body ?? "",
    });

    if (!relationships.nativeDependenciesAvailable) {
      const reason = relationships.unavailableReason ? `: ${relationships.unavailableReason}` : "";
      throw new Error(`Could not verify native GitHub dependencies for issue #${issue.number}${reason}. Refusing to run unchecked discovery candidate.`);
    }

    const activeBlockers = activeRelationshipBlockers(relationships);

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

function assertDependencyClearForIssue(issue: AutorunIssueCandidate, relationships: GitHubIssueRelationships): void {
  if (!relationships.nativeDependenciesAvailable) {
    const reason = relationships.unavailableReason ? `: ${relationships.unavailableReason}` : "";
    throw new Error(`Could not verify native GitHub dependencies for issue #${issue.number}${reason}. Refusing to run unchecked issue.`);
  }

  const activeBlockers = activeRelationshipBlockers(relationships);
  if (activeBlockers.length === 0) return;

  const blockers = activeBlockers.map((blocker) => `#${blocker.number} ${blocker.title} [${blocker.state}]`).join(", ");
  throw new Error(`Issue #${issue.number} has active blocker(s): ${blockers}`);
}

function activeRelationshipBlockers(relationships: GitHubIssueRelationships): GitHubIssueDependency[] {
  return dedupeDependencies([
    ...relationships.blockedBy.filter((blocker) => blocker.state !== "CLOSED"),
    ...relationships.bodyDeclaredBlockers
      .filter((blocker) => blocker.verified && blocker.state !== undefined && blocker.closed !== true && blocker.state !== "CLOSED")
      .map((blocker) => ({
        number: blocker.number,
        title: blocker.title ?? blocker.raw,
        url: blocker.url,
        state: blocker.state ?? "OPEN",
        stateReason: blocker.stateReason,
        closedAt: blocker.closedAt,
      })),
  ]).toSorted(compareDependencyByNumber);
}

function dedupeDependencies(dependencies: GitHubIssueDependency[]): GitHubIssueDependency[] {
  const seen = new Set<string>();
  const result: GitHubIssueDependency[] = [];
  for (const dependency of dependencies) {
    const key = `${dependency.url ?? ""}#${dependency.number}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(dependency);
  }
  return result;
}

async function runTargetedAuto(options: AutoCliOptions, injected: AutoRunInjected): Promise<AutoDiscoveryResult> {
  if (!options.issue) throw new Error("Targeted auto requires an issue.");

  presenter().line("Targeted auto issue");
  presenter().line(`Target issue: ${options.issue}`);
  presenter().line(`Skip labels: ${options.skipLabels.join(", ") || "none"}`);
  presenter().line(`Mode: ${options.dryRun ? "dry run" : "claim + branch + workflow"}`);

  const fetchIssue = injected.fetchGitHubIssue ?? fetchGitHubIssue;
  const fetched = await fetchIssue(options.issue, { cwd: options.cwd, repo: options.repo });
  const runOptions: AutoCliOptions = { ...options, repo: fetched.repo ?? options.repo };
  const issue = toAutorunIssueCandidate(fetched.issue);
  presenter().updateTarget(`#${issue.number}`);

  const skipLabel = findMatchingSkipLabel(issue, runOptions.skipLabels);
  if (skipLabel) {
    throw new Error(
      `Issue #${issue.number} has skip label ${skipLabel}.\n` +
        `Use continue ${issue.number} if this is an existing attempt, or remove the label.`,
    );
  }

  assertDependencyClearForIssue(issue, fetched.relationships);

  printSelectedIssues([issue]);

  if (runOptions.dryRun) {
    presenter().line("Dry run: no issues were claimed and no branches were changed");
    return { kind: "dry-run", attempts: [] };
  }

  return { kind: "attempts", attempts: await runManagedIssueAttempts([issue], runOptions, injected, { requireReadyLabel: false }) };
}

async function runManagedIssueAttempts(
  issues: readonly AutorunIssueCandidate[],
  options: AutoCliOptions,
  injected: AutoRunInjected,
  claimOptions: { requireReadyLabel: boolean },
): Promise<AutorunAttemptResult[]> {
  const assignee = await resolveAssignee(options, injected);
  const results: AutorunAttemptResult[] = [];
  presenter().line(`Claiming issue(s) with label: ${options.inProgressLabel}`);
  if (assignee) presenter().line(`Assignee: ${assignee}`);
  else presenter().line("Assignee: none");

  const clock = injected.clock ?? defaultClock;
  for (const issue of issues) {
    const result = await withAutorunIssueLock({ cwd: options.cwd, issueNumber: issue.number, description: `roark auto issue #${issue.number}` }, async () => {
      return runManagedIssueAttempt(issue, options, assignee, clock, injected, claimOptions);
    });
    if (result) results.push(result);
  }

  return results;
}

async function runManagedIssueAttempt(
  issue: AutorunIssueCandidate,
  options: AutoCliOptions,
  assignee: string | undefined,
  clock: Clock,
  injected: AutoRunInjected,
  claimOptions: { requireReadyLabel: boolean },
): Promise<AutorunAttemptResult | undefined> {
  presenter().updateTarget(`#${issue.number}`);
  presenter().transition("Preparation", `#${issue.number}`, { operation: "edit" });
  const preflight = injected.assertCleanAutorunGit ?? assertCleanAutorunGit;
  await preflight({ cwd: options.cwd });

  let claimPlan = createClaimPlan(issue, { inProgressLabel: options.inProgressLabel, assignee });
  const branchPlan = createBranchPlan({
    issueNumber: claimPlan.issueNumber,
    branchName: claimPlan.branchName,
    baseBranch: options.baseBranch,
  });

  presenter().line(`Preparing clone workspace for branch ${branchPlan.branchName}`);
  const preparedWorkspace = await (injected.prepareCloneWorkspace ?? prepareCloneWorkspace)({
    controlCwd: options.cwd,
    repo: options.repo,
    issueNumber: claimPlan.issueNumber,
    plan: branchPlan,
    workspace: options.workspace ?? defaultWorkspaceConfig,
    hooks: options.hooks ?? defaultLifecycleHooks,
    mode: "auto",
  });

  const recheckedSnapshot = await fetchLatestIssueForClaimRecheck(issue, options, injected);
  const recheckedIssue = toAutorunIssueCandidate(recheckedSnapshot.issue);
  const skipReason = claimRecheckSkipReason(recheckedIssue, options, claimOptions);
  if (skipReason) {
    presenter().line(`Skipping #${issue.number} before claim: ${skipReason}`);
    return;
  }
  assertDependencyClearForIssue(recheckedIssue, recheckedSnapshot.relationships);

  claimPlan = createClaimPlan(recheckedIssue, {
    inProgressLabel: options.inProgressLabel,
    assignee,
    removeLabels: labelsToRemoveForAutorunTransition({
      issueLabels: recheckedIssue.labels,
      workflow: options,
      nextLabel: options.inProgressLabel,
    }),
  });

  const issueDir = path.resolve(options.cwd, ".roark/runs", "issue", String(issue.number));
  const attempt = await allocateNextAttempt(issueDir);

  presenter().line(`Claiming #${claimPlan.issueNumber} for branch ${claimPlan.branchName}`);
  const claimIssue = injected.claimGitHubIssue ?? claimGitHubIssue;
  await claimIssue({ cwd: options.cwd, repo: options.repo, plan: claimPlan, postComment: false });

  const workflowIssue = recheckedIssue;
  presenter().line(`Running full workflow in workspace for branch ${branchPlan.branchName} (attempt ${attempt})`);
  const workflowContext = createAutorunWorkflowContext(workflowIssue, branchPlan, options, attempt, preparedWorkspace.path);
  await ensureRunDir(workflowContext);

  const attemptMetadata: AttemptMetadata = formatAttemptMetadata({
    attempt,
    issueNumber: workflowIssue.number,
    branch: branchPlan.branchName,
    baseBranch: branchPlan.baseBranch,
    worktreePath: workflowContext.agentCwd,
    workspace: preparedWorkspace.metadata,
    runArtifactPath: workflowContext.runDirRelative,
    startedAt: clock.now(),
  });

  return runAutorunAttemptLifecycle({
    issueDir,
    workflowContext,
    branchPlan,
    gateOptions: options,
    attemptMetadata,
    issue: workflowIssue,
    issueSnapshot: recheckedSnapshot,
    logPrefix: "Auto",
    beforeWorkflow: async (metadata) => {
      const publishLedger = injected.publishIssueLedgerComment ?? publishIssueLedgerComment;
      await publishLedger({
        cwd: options.cwd,
        repo: options.repo,
        issueNumber: workflowIssue.number,
        attemptMetadata: metadata,
        phase: "attempt-start",
        body: formatAttemptStartComment({
          issueNumber: workflowIssue.number,
          attempt,
          branchName: branchPlan.branchName,
          assignee,
        }),
      });
    },
    beforeRun: async () => {
      await refreshCopyToWorktree({ controlCwd: options.cwd, worktreePath: preparedWorkspace.path, copyToWorktree: options.workspace?.copyToWorktree });
      await runLifecycleHook("beforeRun", options.hooks, preparedWorkspace.path);
    },
    afterRun: async () => runLifecycleHook("afterRun", options.hooks, preparedWorkspace.path),
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

async function fetchLatestIssueForClaimRecheck(
  issue: AutorunIssueCandidate,
  options: AutoCliOptions,
  injected: AutoRunInjected,
): Promise<GitHubIssueSnapshot> {
  const fetchIssue = injected.fetchGitHubIssue ?? fetchGitHubIssue;
  return fetchIssue(issue.url ?? String(issue.number), { cwd: options.cwd, repo: options.repo });
}

function claimRecheckSkipReason(
  issue: AutorunIssueCandidate,
  options: AutoCliOptions,
  claimOptions: { requireReadyLabel: boolean },
): string | undefined {
  const skipLabel = findMatchingSkipLabel(issue, options.skipLabels);
  if (skipLabel) return `issue now has skip label ${skipLabel}`;
  if (claimOptions.requireReadyLabel && !isEligibleIssue(issue, {
    readyLabel: options.readyLabel,
    skipLabels: options.skipLabels,
    limit: 1,
  })) {
    return `issue no longer has ready label ${options.readyLabel}`;
  }
  return undefined;
}

function printSkippedBlockedIssues(skipped: readonly SkippedBlockedIssue[]): void {
  if (skipped.length === 0) return;

  presenter().line("Skipped issue(s) with active blockers:");
  for (const skippedIssue of skipped) {
    presenter().line(`- #${skippedIssue.issue.number} ${skippedIssue.issue.title}${skippedIssue.issue.url ? ` (${skippedIssue.issue.url})` : ""}`);
    for (const blocker of skippedIssue.blockers) {
      presenter().line(`- blocked by #${blocker.number} ${blocker.title} [${blocker.state}]${blocker.url ? ` (${blocker.url})` : ""}`);
    }
  }
}

function printSelectedIssues(issues: readonly AutorunIssueCandidate[]): void {
  presenter().line("Selected issue(s):");
  for (const issue of issues) {
    presenter().line(`- #${issue.number} ${issue.title}${issue.url ? ` (${issue.url})` : ""}`);
  }
}

function toAutorunIssueCandidate(issue: GitHubIssue): AutorunIssueCandidate {
  return {
    number: issue.number,
    title: issue.title,
    body: issue.body,
    url: issue.url,
    labels: issue.labels,
  };
}
