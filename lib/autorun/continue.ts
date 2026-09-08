import { fromLegacyPromise } from "../runtime/application.ts";
import { runApplicationPromise } from "../runtime/application.ts";
import type { ApplicationExecution } from "../runtime/application.ts";
import { existsSync } from "node:fs";
import path from "node:path";
import type { ContinueCliOptions, IssueCliOptions } from "../cli/args.ts";
import { parseIssueRef, type GitHubIssue } from "../github/issue.ts";
import {
  fetchGitHubIssuePromise as fetchGitHubIssue,
  transitionGitHubIssueLabelsPromise as transitionGitHubIssueLabels,
} from "../github/promise.ts";
import { createWorkflowContext } from "../workflow/artifacts.ts";
import {
  ensureRunDirPromise as ensureRunDir,
  readArtifactPromise as readArtifact,
} from "../workflow/artifacts-promise.ts";
import type { AgentRunner } from "../workflow/agent-runner.ts";
import { runAgentPromise } from "../workflow/agent-runner.ts";
import { presenter } from "../presentation/presenter.ts";
import {
  defaultClock,
  formatAttemptMetadata,
  type AttemptMetadata,
  type Clock,
} from "./attempts.ts";
import {
  latestAttemptNumberPromise as latestAttemptNumber,
  readAttemptMetadataPromise as readAttemptMetadata,
} from "./attempts-promise.ts";
import {
  autorunWorktreePath,
  checkoutExistingIssueBranch,
  type AutorunBranchPlan,
} from "./branch.ts";
import {
  formatContinuationPlan,
  planContinuation,
  type ContinuePlanStep,
} from "./continue-plan.ts";
import type { AutorunGateOptions } from "./publish-flow.ts";
import { formatContinueCommand } from "./recovery.ts";
import {
  runAutorunAttemptLifecyclePromise,
  type AutorunAttemptResult,
} from "./attempt-lifecycle.ts";
import {
  ensureAutorunLabelContract,
  labelsToRemoveForAutorunTransition,
} from "./labels.ts";
import { withAutorunIssueLockPromise } from "./lock.ts";
import type { AutorunIssueCandidate } from "./selection.ts";
import {
  defaultLifecycleHooks,
  defaultWorkspaceConfig,
  prepareCloneWorkspace,
  refreshCopyToWorktree,
  runLifecycleHook,
  runLifecycleHookPromise,
  type PreparedWorkspace,
} from "./workspace.ts";

export async function runAutoContinue(
  options: ContinueCliOptions,
  injected: {
    clock?: Clock | undefined;
    runner?: AgentRunner | undefined;
    prepareCloneWorkspace?: typeof prepareCloneWorkspace | undefined;
    ensureAutorunLabelContract?: typeof ensureAutorunLabelContract | undefined;
    fetchGitHubIssue?: typeof fetchGitHubIssue | undefined;
    transitionGitHubIssueLabels?:
      | typeof transitionGitHubIssueLabels
      | undefined;
  } = {},
  application?: ApplicationExecution,
): Promise<AutorunAttemptResult> {
  if (!application)
    return runApplicationPromise(
      fromLegacyPromise((application) =>
        runAutoContinue(options, injected, application),
      ),
      application,
    );

  const clock = injected.clock ?? defaultClock;
  const runner = injected.runner ?? runAgentPromise;
  const prepareWorkspace =
    injected.prepareCloneWorkspace ?? prepareCloneWorkspace;
  const ensureLabels =
    injected.ensureAutorunLabelContract ?? ensureAutorunLabelContract;
  const cwd = path.resolve(options.cwd);
  const parsed = parseIssueRef(options.issue, options.repo);
  const outDir = path.resolve(cwd, options.outDir);
  const issueDir = path.join(outDir, "issue", parsed.issueNumber);
  const attempt =
    options.attempt ?? (await latestAttemptNumber(issueDir, application));
  const recoveryCommand = formatContinueCommand({
    issueNumber: parsed.issueNumber,
    cwd,
    repo: parsed.repo,
    attempt,
  });

  presenter(application).transition("Continuation", `#${parsed.issueNumber}`, {
    pass: attempt,
  });
  presenter(application).line("Continue autorun attempt");
  presenter(application).line(`Issue: #${parsed.issueNumber}`);
  presenter(application).line(`Attempt: ${attempt}`);
  presenter(application).recovery(recoveryCommand);

  return withAutorunIssueLockPromise(
    {
      cwd,
      issueNumber: parsed.issueNumber,
      description: `roark continue issue #${parsed.issueNumber} attempt ${attempt}`,
    },
    async (application) => {
      let attemptMetadata = await readAttemptMetadata(
        issueDir,
        attempt,
        application,
      );
      assertAttemptMatchesIssue(attemptMetadata, parsed.issueNumber);

      if (attemptMetadata.outcome === "published" && !options.force) {
        presenter(application).line(
          `Attempt ${attempt} is already published. Pass --force to rerun gates anyway.`,
        );
        return attemptResult(attemptMetadata);
      }
      if (attemptMetadata.outcome === "triage-stopped" && !options.force) {
        presenter(application).line(
          `Attempt ${attempt} already stopped after triage. Pass --force to rerun the workflow.`,
        );
        return attemptResult(attemptMetadata);
      }

      await ensureLabels(
        {
          cwd,
          repo: parsed.repo ?? options.repo,
          readyLabel: options.readyLabel,
          inProgressLabel: options.inProgressLabel,
          failureLabel: options.failureLabel,
          successLabel: options.successLabel,
        },
        application,
      );

      const branchPlan: AutorunBranchPlan = {
        issueNumber: attemptMetadata.issueNumber,
        branchName: attemptMetadata.branch,
        baseBranch: attemptMetadata.baseBranch,
      };

      let preparedWorkspace: PreparedWorkspace | undefined;
      const legacyAgentCwd =
        attemptMetadata.worktreePath && existsSync(attemptMetadata.worktreePath)
          ? attemptMetadata.worktreePath
          : autorunWorktreePath(cwd, attemptMetadata.issueNumber);
      let workflowContext = createWorkflowContext(
        createContinueWorkflowOptions(options, attempt),
        {
          agentCwd: attemptMetadata.workspace?.path ?? legacyAgentCwd,
          displayCommand: "continue",
        },
      );
      await ensureRunDir(workflowContext, application);

      if (attemptMetadata.workspace) {
        presenter(application).line(
          `Reusing workspace for branch ${branchPlan.branchName}`,
        );
        preparedWorkspace = await prepareWorkspace(
          {
            controlCwd: cwd,
            repo: parsed.repo ?? options.repo,
            issueNumber: attemptMetadata.issueNumber,
            plan: branchPlan,
            workspace: options.workspace ?? defaultWorkspaceConfig,
            hooks: options.hooks ?? defaultLifecycleHooks,
            mode: "continue",
            workspacePath: attemptMetadata.workspace.path,
          },
          application,
        );
        workflowContext = createWorkflowContext(
          createContinueWorkflowOptions(options, attempt),
          { agentCwd: preparedWorkspace.path, displayCommand: "continue" },
        );
        await ensureRunDir(workflowContext, application);
      } else {
        presenter(application).line(
          `Switching to legacy worktree branch ${branchPlan.branchName}`,
        );
        const recoveredAgentCwd = await checkoutExistingIssueBranch(
          {
            cwd: workflowContext.controlCwd,
            plan: branchPlan,
            worktreePath: workflowContext.agentCwd,
          },
          application,
        );
        if (recoveredAgentCwd !== workflowContext.agentCwd) {
          workflowContext = createWorkflowContext(
            createContinueWorkflowOptions(options, attempt),
            { agentCwd: recoveredAgentCwd, displayCommand: "continue" },
          );
          await ensureRunDir(workflowContext, application);
        }
      }

      attemptMetadata = formatAttemptMetadata({
        ...attemptMetadata,
        worktreePath: workflowContext.agentCwd,
        workspace: preparedWorkspace?.metadata ?? attemptMetadata.workspace,
        runArtifactPath: workflowContext.runDirRelative,
      });

      const continuationPlan = await planContinuation(
        workflowContext,
        {
          attemptOutcome: attemptMetadata.outcome,
        },
        application,
      );
      const initialVerificationRepairPass =
        verificationRepairPassFromPlan(continuationPlan);
      if (isTerminalContinuationNoop(continuationPlan) && !options.force) {
        presenter(application).line("Continuation plan:");
        for (const line of formatContinuationPlan(continuationPlan))
          presenter(application).line(line);
        return attemptResult(attemptMetadata);
      }

      const fetchIssue = injected.fetchGitHubIssue ?? fetchGitHubIssue;
      const fetched = await fetchIssue(
        options.issue,
        { cwd, repo: parsed.repo ?? options.repo },
        application,
      );
      const currentIssue = toIssueCandidate(fetched.issue);
      const transitionLabels =
        injected.transitionGitHubIssueLabels ?? transitionGitHubIssueLabels;
      await transitionLabels(
        {
          cwd,
          repo: parsed.repo ?? options.repo,
          issueNumber: attemptMetadata.issueNumber,
          nextLabel: options.inProgressLabel,
          removeLabels: labelsToRemoveForAutorunTransition({
            issueLabels: currentIssue.labels,
            workflow: options,
            nextLabel: options.inProgressLabel,
          }),
        },
        application,
      );

      const result = await runAutorunAttemptLifecyclePromise(
        {
          issueDir,
          workflowContext,
          branchPlan,
          gateOptions: createGateOptions(
            options,
            workflowContext.controlCwd,
            branchPlan.baseBranch,
            parsed.repo,
          ),
          attemptMetadata,
          loadIssue: (application) =>
            loadIssueCandidate(
              {
                context: workflowContext,
                options,
                issueNumber: attemptMetadata.issueNumber,
              },
              application,
            ),
          runner,
          logPrefix: "Continue",
          inProgressOutcomeDetail: `continued at ${clock.now().toISOString()}`,
          initialVerificationRepairPass,
          beforeWorkflow: (_metadata, application) => {
            presenter(application).line("Continuation plan:");
            for (const line of formatContinuationPlan(continuationPlan))
              presenter(application).line(line);
          },
          beforeRun: async (_metadata, application) => {
            await refreshCopyToWorktree(
              {
                controlCwd: workflowContext.controlCwd,
                worktreePath: workflowContext.agentCwd,
                copyToWorktree: options.workspace?.copyToWorktree,
              },
              application,
            );
            await runLifecycleHookPromise(
              "beforeRun",
              options.hooks,
              workflowContext.agentCwd,
              undefined,
              application,
            );
          },
          afterRun: () =>
            runLifecycleHook(
              "afterRun",
              options.hooks,
              workflowContext.agentCwd,
            ),
        },
        { clock },
        application,
      );

      return result;
    },
    application,
  );
}

function attemptResult(metadata: AttemptMetadata): AutorunAttemptResult {
  return {
    issueNumber: metadata.issueNumber,
    outcome: metadata.outcome,
    outcomeDetail: metadata.outcomeDetail,
  };
}

export function createContinueWorkflowOptions(
  options: ContinueCliOptions,
  attempt: number,
): IssueCliOptions {
  return {
    command: "do",
    issue: options.issue,
    cwd: options.cwd,
    outDir: options.outDir,
    repo: options.repo,
    model: options.model,
    thinkingLevel: options.thinkingLevel,
    thinkingProfile: options.thinkingProfile,
    force: options.force,
    yes: options.yes,
    maxFixPasses: options.maxFixPasses,
    attempt,
  };
}

function createGateOptions(
  options: ContinueCliOptions,
  cwd: string,
  baseBranch: string,
  repo?: string,
): AutorunGateOptions {
  return {
    cwd,
    repo,
    verifyCommand: options.verifyCommand,
    readyLabel: options.readyLabel,
    failureLabel: options.failureLabel,
    successLabel: options.successLabel,
    inProgressLabel: options.inProgressLabel,
    remote: options.remote,
    baseBranch,
    hooks: options.hooks,
    workspace: options.workspace,
  };
}

async function loadIssueCandidate(
  input: {
    context: ReturnType<typeof createWorkflowContext>;
    options: ContinueCliOptions;
    issueNumber: number;
  },
  application?: ApplicationExecution,
): Promise<AutorunIssueCandidate> {
  const fromMetadata = await loadIssueCandidateFromMetadata(
    input.context,
    application,
  );
  if (fromMetadata) return fromMetadata;

  try {
    const fetched = await fetchGitHubIssue(
      input.options.issue,
      { cwd: input.context.controlCwd, repo: input.options.repo },
      application,
    );
    return toIssueCandidate(fetched.issue);
  } catch {
    return {
      number: input.issueNumber,
      title: `Fix issue #${input.issueNumber}`,
    };
  }
}

async function loadIssueCandidateFromMetadata(
  context: ReturnType<typeof createWorkflowContext>,
  application?: ApplicationExecution,
): Promise<AutorunIssueCandidate | undefined> {
  try {
    const raw = await readArtifact(context, "metadata", application);
    const parsed = JSON.parse(raw) as { issue?: GitHubIssue };
    if (parsed.issue?.number === undefined || parsed.issue.title === "")
      return undefined;
    return toIssueCandidate(parsed.issue);
  } catch {
    return undefined;
  }
}

function toIssueCandidate(issue: GitHubIssue): AutorunIssueCandidate {
  return {
    number: issue.number,
    title: issue.title,
    url: issue.url,
    labels: issue.labels,
  };
}

function verificationRepairPassFromPlan(
  steps: readonly ContinuePlanStep[],
): number | undefined {
  const first = steps[0];
  if (first?.type !== "run" || first.phase !== "fix") return undefined;
  return first.reason.includes("verification failed") ? first.pass : undefined;
}

function isTerminalContinuationNoop(
  steps: readonly ContinuePlanStep[],
): boolean {
  const first = steps[0];
  return (
    steps.length === 1 &&
    first?.type === "noop" &&
    first.reason.includes("maximum fix passes reached")
  );
}

function assertAttemptMatchesIssue(
  metadata: AttemptMetadata,
  issueNumber: string,
): void {
  if (String(metadata.issueNumber) !== issueNumber) {
    throw new Error(
      `Attempt metadata issue #${metadata.issueNumber} does not match requested issue #${issueNumber}.`,
    );
  }
}
