import { Workspace } from "./workspace-service.ts";
import { GitHub } from "../github/service.ts";
import { Presentation } from "../runtime/services.ts";
import { DateTime, Effect, Schema } from "effect";
import { runAutorunAttemptLifecycle } from "./attempt-lifecycle.ts";
import path from "node:path";
import type { AutoCliOptions } from "../cli/args.ts";

import { displayIssueTarget } from "../cli/target.ts";
import {
  type GitHubIssue,
  type GitHubIssueDependency,
  type GitHubIssueRelationships,
} from "../github/issue.ts";
import { ensureRunDir } from "../workflow/artifacts.ts";
import { assertCleanAutorunGit } from "../workflow/git.ts";
import { type runFullWorkflow } from "../workflow/phases.ts";
import {
  formatAttemptMetadata,
  type AttemptMetadata,
  type Clock,
} from "./attempts.ts";
import { AttemptStore } from "./attempts.ts";
import { createBranchPlan, AutorunBranchError } from "./branch.ts";
import { createClaimPlan } from "./claim.ts";
import { labelsToRemoveForAutorunTransition } from "./labels.ts";
import { ensureAutorunLabelContract } from "./labels.ts";
import { type completeAutorunWorkflow } from "./completion.ts";
import { formatAttemptStartComment } from "./ledger-comments.ts";
import { publishIssueLedgerComment } from "./ledger-comments.ts";
import { type AutorunAttemptResult } from "./attempt-lifecycle.ts";
import { withAutorunIssueLock } from "./lock.ts";
import {
  findMatchingSkipLabel,
  isEligibleIssue,
  rankEligibleIssues,
  type AutorunIssueCandidate,
} from "./selection.ts";
import { createAutorunWorkflowContext } from "./workflow.ts";
import { defaultLifecycleHooks, defaultWorkspaceConfig } from "./workspace.ts";

import { type prepareCloneWorkspace } from "./workspace.ts";
const discoveryFetchLimit = 100;
export interface AutoRunInjected {
  clock?: Clock | undefined;
  listOpenGitHubIssues?: GitHub["Service"]["listOpenGitHubIssues"] | undefined;
  fetchGitHubIssue?: GitHub["Service"]["fetchGitHubIssue"] | undefined;
  fetchGitHubIssueRelationships?:
    | GitHub["Service"]["fetchGitHubIssueRelationships"]
    | undefined;
  resolveGitHubIssueRepo?:
    | GitHub["Service"]["resolveGitHubIssueRepo"]
    | undefined;
  assertCleanAutorunGit?: typeof assertCleanAutorunGit | undefined;
  getCurrentGitHubLogin?:
    | GitHub["Service"]["getCurrentGitHubLogin"]
    | undefined;
  claimGitHubIssue?: GitHub["Service"]["claimGitHubIssue"] | undefined;
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
export const runAutoDiscovery = Effect.fn("runAutoDiscovery")(function* (
  options: AutoCliOptions,
  injected: AutoRunInjected = {},
) {
  (yield* Presentation).transition(
    options.issue ? "Target lookup" : "Discovery",
    displayIssueTarget(options.issue, "auto"),
  );
  yield* ensureRequiredLabelsBeforeIssueWork(options, injected);
  if (options.issue) return yield* runTargetedAuto(options, injected);
  return yield* runDiscoveryAuto(options, injected);
});
const ensureRequiredLabelsBeforeIssueWork = Effect.fn(
  "ensureRequiredLabelsBeforeIssueWork",
)(function* (options: AutoCliOptions, injected: AutoRunInjected) {
  const ensureLabels =
    injected.ensureAutorunLabelContract ?? ensureAutorunLabelContract;
  yield* ensureLabels({
    cwd: options.cwd,
    repo: options.repo,
    readyLabel: options.readyLabel,
    inProgressLabel: options.inProgressLabel,
    failureLabel: options.failureLabel,
    successLabel: options.successLabel,
    dryRun: options.dryRun,
  });
});
const runDiscoveryAuto = Effect.fn("runDiscoveryAuto")(function* (
  options: AutoCliOptions,
  injected: AutoRunInjected,
) {
  (yield* Presentation).line("Auto issue discovery");
  (yield* Presentation).line(`Ready label: ${options.readyLabel}`);
  (yield* Presentation).line(
    `Skip labels: ${options.skipLabels.join(", ") || "none"}`,
  );
  (yield* Presentation).line(`Selection limit: ${options.limit}`);
  (yield* Presentation).line(
    `Mode: ${options.dryRun ? "dry run" : "claim + branch + workflow"}`,
  );
  const listIssues =
    injected.listOpenGitHubIssues ?? (yield* GitHub).listOpenGitHubIssues;
  const issues = yield* listIssues({
    cwd: options.cwd,
    repo: options.repo,
    limit: discoveryFetchLimit,
  });
  const rankedCandidates = rankEligibleIssues(issues, {
    readyLabel: options.readyLabel,
    skipLabels: options.skipLabels,
    limit: options.limit,
  });
  const { selected, skippedBlocked } = yield* selectDependencyClearIssues(
    rankedCandidates,
    options,
    injected,
  );
  yield* printSkippedBlockedIssues(skippedBlocked);
  if (selected.length === 0) {
    (yield* Presentation).line("No eligible issues found");
    return { kind: "no-eligible", attempts: [] } satisfies AutoDiscoveryResult;
  }
  yield* printSelectedIssues(selected);
  const selectedTarget = selected[0];
  if (selectedTarget)
    (yield* Presentation).updateTarget(`#${selectedTarget.number}`);
  if (options.dryRun) {
    (yield* Presentation).line(
      "Dry run: no issues were claimed and no branches were changed",
    );
    return { kind: "dry-run", attempts: [] } satisfies AutoDiscoveryResult;
  }
  return {
    kind: "attempts",
    attempts: yield* runManagedIssueAttempts(selected, options, injected, {
      requireReadyLabel: true,
    }),
  } satisfies AutoDiscoveryResult;
});
interface SkippedBlockedIssue {
  issue: AutorunIssueCandidate;
  blockers: GitHubIssueDependency[];
}
const selectDependencyClearIssues = Effect.fn("selectDependencyClearIssues")(
  function* (
    candidates: readonly AutorunIssueCandidate[],
    options: AutoCliOptions,
    injected: AutoRunInjected,
  ) {
    const selected: AutorunIssueCandidate[] = [];
    const skippedBlocked: SkippedBlockedIssue[] = [];
    if (options.limit <= 0) return { selected, skippedBlocked };
    const fetchRelationships =
      injected.fetchGitHubIssueRelationships ??
      (yield* GitHub).fetchGitHubIssueRelationships;
    const resolveRepo =
      injected.resolveGitHubIssueRepo ?? (yield* GitHub).resolveGitHubIssueRepo;
    for (const issue of candidates) {
      if (selected.length >= options.limit) break;
      const repo = yield* resolveRepo({
        cwd: options.cwd,
        explicitRepo: options.repo,
        issueUrl: issue.url,
      });
      const relationships = yield* fetchRelationships({
        cwd: options.cwd,
        repo,
        issueNumber: issue.number,
        body: issue.body ?? "",
      });
      if (!relationships.nativeDependenciesAvailable) {
        const reason = relationships.unavailableReason
          ? `: ${relationships.unavailableReason}`
          : "";
        return yield* Effect.fail(
          new AutorunDiscoveryError({
            message: `Could not verify native GitHub dependencies for issue #${issue.number}${reason}. Refusing to run unchecked discovery candidate.`,
          }),
        );
      }
      const activeBlockers = activeRelationshipBlockers(relationships);
      if (activeBlockers.length > 0) {
        skippedBlocked.push({ issue, blockers: activeBlockers });
        continue;
      }
      selected.push(issue);
    }
    return { selected, skippedBlocked };
  },
);
function compareDependencyByNumber(
  left: GitHubIssueDependency,
  right: GitHubIssueDependency,
): number {
  if (left.number !== right.number) return left.number - right.number;
  return left.title.localeCompare(right.title);
}
const assertDependencyClearForIssue = Effect.fnUntraced(function* (
  issue: AutorunIssueCandidate,
  relationships: GitHubIssueRelationships,
) {
  if (!relationships.nativeDependenciesAvailable) {
    const reason = relationships.unavailableReason
      ? `: ${relationships.unavailableReason}`
      : "";
    return yield* new AutorunDiscoveryError({
      message: `Could not verify native GitHub dependencies for issue #${issue.number}${reason}. Refusing to run unchecked issue.`,
    });
  }
  const activeBlockers = activeRelationshipBlockers(relationships);
  if (activeBlockers.length === 0) return;
  const blockers = activeBlockers
    .map((blocker) => `#${blocker.number} ${blocker.title} [${blocker.state}]`)
    .join(", ");
  return yield* new AutorunDiscoveryError({
    message: `Issue #${issue.number} has active blocker(s): ${blockers}`,
  });
});
function activeRelationshipBlockers(
  relationships: GitHubIssueRelationships,
): GitHubIssueDependency[] {
  return dedupeDependencies([
    ...relationships.blockedBy.filter((blocker) => blocker.state !== "CLOSED"),
    ...relationships.bodyDeclaredBlockers
      .filter(
        (blocker) =>
          blocker.verified &&
          blocker.state !== undefined &&
          blocker.closed !== true &&
          blocker.state !== "CLOSED",
      )
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
function dedupeDependencies(
  dependencies: GitHubIssueDependency[],
): GitHubIssueDependency[] {
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
const runTargetedAuto = Effect.fn("runTargetedAuto")(function* (
  options: AutoCliOptions,
  injected: AutoRunInjected,
) {
  if (!options.issue)
    return yield* Effect.fail(
      new AutorunDiscoveryError({
        message: "Targeted auto requires an issue.",
      }),
    );
  (yield* Presentation).line("Targeted auto issue");
  (yield* Presentation).line(`Target issue: ${options.issue}`);
  (yield* Presentation).line(
    `Skip labels: ${options.skipLabels.join(", ") || "none"}`,
  );
  (yield* Presentation).line(
    `Mode: ${options.dryRun ? "dry run" : "claim + branch + workflow"}`,
  );
  const fetchIssue =
    injected.fetchGitHubIssue ?? (yield* GitHub).fetchGitHubIssue;
  const fetched = yield* fetchIssue(options.issue, {
    cwd: options.cwd,
    repo: options.repo,
  });
  const runOptions: AutoCliOptions = {
    ...options,
    repo: fetched.repo ?? options.repo,
  };
  const issue = toAutorunIssueCandidate(fetched.issue);
  (yield* Presentation).updateTarget(`#${issue.number}`);
  const skipLabel = findMatchingSkipLabel(issue, runOptions.skipLabels);
  if (skipLabel) {
    return yield* Effect.fail(
      new AutorunDiscoveryError({
        message:
          `Issue #${issue.number} has skip label ${skipLabel}.\n` +
          `Use continue ${issue.number} if this is an existing attempt, or remove the label.`,
      }),
    );
  }
  yield* assertDependencyClearForIssue(issue, fetched.relationships);
  yield* printSelectedIssues([issue]);
  if (runOptions.dryRun) {
    (yield* Presentation).line(
      "Dry run: no issues were claimed and no branches were changed",
    );
    return { kind: "dry-run", attempts: [] } satisfies AutoDiscoveryResult;
  }
  return {
    kind: "attempts",
    attempts: yield* runManagedIssueAttempts([issue], runOptions, injected, {
      requireReadyLabel: false,
    }),
  } satisfies AutoDiscoveryResult;
});
const runManagedIssueAttempts = Effect.fn("runManagedIssueAttempts")(function* (
  issues: readonly AutorunIssueCandidate[],
  options: AutoCliOptions,
  injected: AutoRunInjected,
  claimOptions: {
    requireReadyLabel: boolean;
  },
) {
  const assignee = yield* resolveAssignee(options, injected);
  const results: AutorunAttemptResult[] = [];
  (yield* Presentation).line(
    `Claiming issue(s) with label: ${options.inProgressLabel}`,
  );
  if (assignee) (yield* Presentation).line(`Assignee: ${assignee}`);
  else (yield* Presentation).line("Assignee: none");
  const clock = injected.clock;
  for (const issue of issues) {
    const result = yield* withAutorunIssueLock(
      {
        cwd: options.cwd,
        issueNumber: issue.number,
        description: `roark auto issue #${issue.number}`,
      },
      Effect.suspend(
        Effect.fnUntraced(function* () {
          return yield* runManagedIssueAttempt(
            issue,
            options,
            assignee,
            clock,
            injected,
            claimOptions,
          );
        }),
      ),
    );
    if (result) results.push(result);
  }
  return results;
});
const runManagedIssueAttempt = Effect.fn("runManagedIssueAttempt")(function* (
  issue: AutorunIssueCandidate,
  options: AutoCliOptions,
  assignee: string | undefined,
  clock: Clock | undefined,
  injected: AutoRunInjected,
  claimOptions: {
    requireReadyLabel: boolean;
  },
) {
  (yield* Presentation).updateTarget(`#${issue.number}`);
  (yield* Presentation).transition("Preparation", `#${issue.number}`, {
    operation: "edit",
  });
  const preflight = injected.assertCleanAutorunGit ?? assertCleanAutorunGit;
  yield* preflight({ cwd: options.cwd });
  let claimPlan = createClaimPlan(issue, {
    inProgressLabel: options.inProgressLabel,
    assignee,
  });
  const branchPlan = yield* Effect.try({
    try: () =>
      createBranchPlan({
        issueNumber: claimPlan.issueNumber,
        branchName: claimPlan.branchName,
        baseBranch: options.baseBranch,
      }),
    catch: (error) => error,
  }).pipe(
    Effect.catch((error) =>
      error instanceof AutorunBranchError
        ? Effect.fail(error)
        : Effect.die(error),
    ),
  );

  (yield* Presentation).line(
    `Preparing clone workspace for branch ${branchPlan.branchName}`,
  );
  const workspaces = yield* Workspace;
  const preparedWorkspace = yield* (
    injected.prepareCloneWorkspace ?? workspaces.prepareClone
  )({
    controlCwd: options.cwd,
    repo: options.repo,
    issueNumber: claimPlan.issueNumber,
    plan: branchPlan,
    workspace: options.workspace ?? defaultWorkspaceConfig,
    hooks: options.hooks ?? defaultLifecycleHooks,
    mode: "auto",
  });
  const recheckedSnapshot = yield* fetchLatestIssueForClaimRecheck(
    issue,
    options,
    injected,
  );
  const recheckedIssue = toAutorunIssueCandidate(recheckedSnapshot.issue);
  const skipReason = claimRecheckSkipReason(
    recheckedIssue,
    options,
    claimOptions,
  );
  if (skipReason) {
    (yield* Presentation).line(
      `Skipping #${issue.number} before claim: ${skipReason}`,
    );
    return;
  }
  yield* assertDependencyClearForIssue(
    recheckedIssue,
    recheckedSnapshot.relationships,
  );
  claimPlan = createClaimPlan(recheckedIssue, {
    inProgressLabel: options.inProgressLabel,
    assignee,
    removeLabels: labelsToRemoveForAutorunTransition({
      issueLabels: recheckedIssue.labels,
      workflow: options,
      nextLabel: options.inProgressLabel,
    }),
  });
  const issueDir = path.resolve(
    options.cwd,
    ".roark/runs",
    "issue",
    String(issue.number),
  );
  const attempt = yield* (yield* AttemptStore).allocate(issueDir);
  (yield* Presentation).line(
    `Claiming #${claimPlan.issueNumber} for branch ${claimPlan.branchName}`,
  );
  const claimIssue =
    injected.claimGitHubIssue ?? (yield* GitHub).claimGitHubIssue;
  yield* claimIssue({
    cwd: options.cwd,
    repo: options.repo,
    plan: claimPlan,
    postComment: false,
  });
  const workflowIssue = recheckedIssue;
  (yield* Presentation).line(
    `Running full workflow in workspace for branch ${branchPlan.branchName} (attempt ${attempt})`,
  );
  const workflowContext = createAutorunWorkflowContext(
    workflowIssue,
    branchPlan,
    options,
    attempt,
    preparedWorkspace.path,
  );
  yield* ensureRunDir(workflowContext);
  const attemptMetadata: AttemptMetadata = formatAttemptMetadata({
    attempt,
    issueNumber: workflowIssue.number,
    branch: branchPlan.branchName,
    baseBranch: branchPlan.baseBranch,
    worktreePath: workflowContext.agentCwd,
    workspace: preparedWorkspace.metadata,
    runArtifactPath: workflowContext.runDirRelative,
    startedAt: clock?.now() ?? DateTime.toDateUtc(yield* DateTime.now),
  });
  return yield* runAutorunAttemptLifecycle(
    {
      issueDir,
      workflowContext,
      branchPlan,
      gateOptions: options,
      attemptMetadata,
      issue: workflowIssue,
      issueSnapshot: recheckedSnapshot,
      logPrefix: "Auto",
      beforeWorkflow: Effect.fnUntraced(function* (metadata) {
        const publishLedger =
          injected.publishIssueLedgerComment ?? publishIssueLedgerComment;
        yield* publishLedger({
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
      }),
      beforeRun: Effect.fnUntraced(function* () {
        yield* workspaces.refreshCopy({
          controlCwd: options.cwd,
          worktreePath: preparedWorkspace.path,
          copyToWorktree: options.workspace?.copyToWorktree,
        });
        yield* workspaces.runHook(
          "beforeRun",
          options.hooks,
          preparedWorkspace.path,
        );
      }),
      afterRun: () =>
        workspaces.runHook("afterRun", options.hooks, preparedWorkspace.path),
    },
    {
      clock,
      runFullWorkflow: injected.runFullWorkflow,
      completeAutorunWorkflow: injected.completeAutorunWorkflow,
    },
  );
});
const resolveAssignee = Effect.fn("resolveAssignee")(function* (
  options: AutoCliOptions,
  injected: AutoRunInjected,
) {
  if (options.noAssign) return undefined;
  const getLogin =
    injected.getCurrentGitHubLogin ?? (yield* GitHub).getCurrentGitHubLogin;
  return options.assignee ?? (yield* getLogin({ cwd: options.cwd }));
});
const fetchLatestIssueForClaimRecheck = Effect.fn(
  "fetchLatestIssueForClaimRecheck",
)(function* (
  issue: AutorunIssueCandidate,
  options: AutoCliOptions,
  injected: AutoRunInjected,
) {
  const fetchIssue =
    injected.fetchGitHubIssue ?? (yield* GitHub).fetchGitHubIssue;
  return yield* fetchIssue(issue.url ?? String(issue.number), {
    cwd: options.cwd,
    repo: options.repo,
  });
});
function claimRecheckSkipReason(
  issue: AutorunIssueCandidate,
  options: AutoCliOptions,
  claimOptions: {
    requireReadyLabel: boolean;
  },
): string | undefined {
  const skipLabel = findMatchingSkipLabel(issue, options.skipLabels);
  if (skipLabel) return `issue now has skip label ${skipLabel}`;
  if (
    claimOptions.requireReadyLabel &&
    !isEligibleIssue(issue, {
      readyLabel: options.readyLabel,
      skipLabels: options.skipLabels,
      limit: 1,
    })
  ) {
    return `issue no longer has ready label ${options.readyLabel}`;
  }
  return undefined;
}
const printSkippedBlockedIssues = Effect.fn("printSkippedBlockedIssues")(
  function* (skipped: readonly SkippedBlockedIssue[]) {
    if (skipped.length === 0) return;
    (yield* Presentation).line("Skipped issue(s) with active blockers:");
    for (const skippedIssue of skipped) {
      (yield* Presentation).line(
        `- #${skippedIssue.issue.number} ${skippedIssue.issue.title}${skippedIssue.issue.url ? ` (${skippedIssue.issue.url})` : ""}`,
      );
      for (const blocker of skippedIssue.blockers) {
        (yield* Presentation).line(
          `- blocked by #${blocker.number} ${blocker.title} [${blocker.state}]${blocker.url ? ` (${blocker.url})` : ""}`,
        );
      }
    }
  },
);
const printSelectedIssues = Effect.fn("printSelectedIssues")(function* (
  issues: readonly AutorunIssueCandidate[],
) {
  (yield* Presentation).line("Selected issue(s):");
  for (const issue of issues) {
    (yield* Presentation).line(
      `- #${issue.number} ${issue.title}${issue.url ? ` (${issue.url})` : ""}`,
    );
  }
});
function toAutorunIssueCandidate(issue: GitHubIssue): AutorunIssueCandidate {
  return {
    number: issue.number,
    title: issue.title,
    body: issue.body,
    url: issue.url,
    labels: issue.labels,
  };
}

export class AutorunDiscoveryError extends Schema.TaggedError<AutorunDiscoveryError>()(
  "AutorunDiscoveryError",
  { message: Schema.String },
) {}
