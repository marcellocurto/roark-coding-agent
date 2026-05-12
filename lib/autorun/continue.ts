import { existsSync } from "node:fs";
import path from "node:path";
import type { ContinueCliOptions, IssueCliOptions } from "../cli/args.ts";
import { fetchGitHubIssue, parseIssueRef, type GitHubIssue } from "../github/issue.ts";
import { createWorkflowContext, ensureRunDir, readArtifact } from "../workflow/artifacts.ts";
import type { AgentRunner } from "../workflow/agent-runner.ts";
import { runPiAgent } from "../pi/agent.ts";
import {
  defaultClock,
  formatAttemptMetadata,
  latestAttemptNumber,
  readAttemptMetadata,
  type AttemptMetadata,
  type Clock,
} from "./attempts.ts";
import { autorunWorktreePath, checkoutExistingIssueBranch, type AutorunBranchPlan } from "./branch.ts";
import { formatContinuationPlan, planContinuation, type ContinuePlanStep } from "./continue-plan.ts";
import type { AutorunGateOptions } from "./publish-flow.ts";
import { formatContinueCommand } from "./recovery.ts";
import { runAutorunAttemptLifecycle } from "./attempt-lifecycle.ts";
import { ensureAutorunLabelContract } from "./labels.ts";
import type { AutorunIssueCandidate } from "./selection.ts";
import { defaultLifecycleHooks, defaultWorkspaceConfig, prepareCloneWorkspace, refreshCopyToWorktree, runLifecycleHook, type PreparedWorkspace } from "./workspace.ts";

export async function runAutoContinue(
  options: ContinueCliOptions,
  injected: {
    clock?: Clock | undefined;
    runner?: AgentRunner | undefined  ;
    prepareCloneWorkspace?: typeof prepareCloneWorkspace | undefined;
    ensureAutorunLabelContract?: typeof ensureAutorunLabelContract | undefined;
  } = {},
): Promise<void> {
  const clock = injected.clock ?? defaultClock;
  const runner = injected.runner ?? runPiAgent;
  const prepareWorkspace = injected.prepareCloneWorkspace ?? prepareCloneWorkspace;
  const ensureLabels = injected.ensureAutorunLabelContract ?? ensureAutorunLabelContract;
  const cwd = path.resolve(options.cwd);
  const parsed = parseIssueRef(options.issue, options.repo);
  const outDir = path.resolve(cwd, options.outDir);
  const issueDir = path.join(outDir, "issue", parsed.issueNumber);
  const attempt = options.attempt ?? await latestAttemptNumber(issueDir);
  const recoveryCommand = formatContinueCommand({ issueNumber: parsed.issueNumber, cwd, repo: parsed.repo, attempt });

  console.log("\n=== Continue autorun attempt ===");
  console.log(`Issue: #${parsed.issueNumber}`);
  console.log(`Attempt: ${attempt}`);
  console.log(`Recovery command: ${recoveryCommand}`);

  let attemptMetadata = await readAttemptMetadata(issueDir, attempt);
  assertAttemptMatchesIssue(attemptMetadata, parsed.issueNumber);

  if (attemptMetadata.outcome === "published" && !options.force) {
    console.log(`Attempt ${attempt} is already published. Pass --force to rerun gates anyway.`);
    return;
  }
  if (attemptMetadata.outcome === "triage-stopped" && !options.force) {
    console.log(`Attempt ${attempt} already stopped after triage. Pass --force to rerun the workflow.`);
    return;
  }

  await ensureLabels({
    cwd,
    repo: parsed.repo ?? options.repo,
    inProgressLabel: options.inProgressLabel,
    failureLabel: options.failureLabel,
    successLabel: options.successLabel,
  });

  const branchPlan: AutorunBranchPlan = {
    issueNumber: attemptMetadata.issueNumber,
    branchName: attemptMetadata.branch,
    baseBranch: attemptMetadata.baseBranch,
  };

  let preparedWorkspace: PreparedWorkspace | undefined;
  const legacyAgentCwd = attemptMetadata.worktreePath && existsSync(attemptMetadata.worktreePath)
    ? attemptMetadata.worktreePath
    : autorunWorktreePath(cwd, attemptMetadata.issueNumber);
  let workflowContext = createWorkflowContext(createContinueWorkflowOptions(options, attempt), {
    agentCwd: attemptMetadata.workspace?.path ?? legacyAgentCwd,
  });
  await ensureRunDir(workflowContext);

  if (attemptMetadata.workspace) {
    console.log(`- Reusing workspace for branch ${branchPlan.branchName}`);
    preparedWorkspace = await prepareWorkspace({
      controlCwd: cwd,
      repo: parsed.repo ?? options.repo,
      issueNumber: attemptMetadata.issueNumber,
      plan: branchPlan,
      workspace: options.workspace ?? defaultWorkspaceConfig,
      hooks: options.hooks ?? defaultLifecycleHooks,
      mode: "continue",
      workspacePath: attemptMetadata.workspace.path,
    });
    workflowContext = createWorkflowContext(createContinueWorkflowOptions(options, attempt), { agentCwd: preparedWorkspace.path });
    await ensureRunDir(workflowContext);
  } else {
    console.log(`- Switching to legacy worktree branch ${branchPlan.branchName}`);
    const recoveredAgentCwd = await checkoutExistingIssueBranch({
      cwd: workflowContext.controlCwd,
      plan: branchPlan,
      worktreePath: workflowContext.agentCwd,
    });
    if (recoveredAgentCwd !== workflowContext.agentCwd) {
      workflowContext = createWorkflowContext(createContinueWorkflowOptions(options, attempt), { agentCwd: recoveredAgentCwd });
      await ensureRunDir(workflowContext);
    }
  }

  attemptMetadata = formatAttemptMetadata({
    ...attemptMetadata,
    worktreePath: workflowContext.agentCwd,
    workspace: preparedWorkspace?.metadata ?? attemptMetadata.workspace,
    runArtifactPath: workflowContext.runDirRelative,
  });

  try {
    const continuationPlan = await planContinuation(workflowContext, { attemptOutcome: attemptMetadata.outcome });
    const initialVerificationRepairPass = verificationRepairPassFromPlan(continuationPlan);
    if (isTerminalContinuationNoop(continuationPlan) && !options.force) {
      console.log("\nContinuation plan:");
      for (const line of formatContinuationPlan(continuationPlan)) console.log(line);
      return;
    }

    await runAutorunAttemptLifecycle({
      issueDir,
      workflowContext,
      branchPlan,
      gateOptions: createGateOptions(options, workflowContext.controlCwd, branchPlan.baseBranch, parsed.repo),
      attemptMetadata,
      loadIssue: () => loadIssueCandidate({ context: workflowContext, options, issueNumber: attemptMetadata.issueNumber }),
      runner,
      logPrefix: "Continue",
      inProgressOutcomeDetail: `continued at ${clock.now().toISOString()}`,
      initialVerificationRepairPass,
      beforeWorkflow: () => {
        console.log("\nContinuation plan:");
        for (const line of formatContinuationPlan(continuationPlan)) console.log(line);
      },
      beforeRun: async () => {
        await refreshCopyToWorktree({ controlCwd: workflowContext.controlCwd, worktreePath: workflowContext.agentCwd, copyToWorktree: options.workspace?.copyToWorktree });
        await runLifecycleHook("beforeRun", options.hooks, workflowContext.agentCwd);
      },
      afterRun: async () => runLifecycleHook("afterRun", options.hooks, workflowContext.agentCwd),
    }, { clock });
  } finally {
    await preparedWorkspace?.releaseLock();
  }

  console.log("\nContinue workflow complete.");
}

export function createContinueWorkflowOptions(options: ContinueCliOptions, attempt: number): IssueCliOptions {
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
  repo?: string  ,
): AutorunGateOptions {
  return {
    cwd,
    repo,
    verifyCommand: options.verifyCommand,
    failureLabel: options.failureLabel,
    successLabel: options.successLabel,
    inProgressLabel: options.inProgressLabel,
    remote: options.remote,
    baseBranch,
    hooks: options.hooks,
    workspace: options.workspace,
  };
}

async function loadIssueCandidate(input: {
  context: ReturnType<typeof createWorkflowContext>;
  options: ContinueCliOptions;
  issueNumber: number;
}): Promise<AutorunIssueCandidate> {
  const fromMetadata = await loadIssueCandidateFromMetadata(input.context);
  if (fromMetadata) return fromMetadata;

  try {
    const fetched = await fetchGitHubIssue(input.options.issue, { cwd: input.context.controlCwd, repo: input.options.repo });
    return toIssueCandidate(fetched.issue);
  } catch {
    return { number: input.issueNumber, title: `Fix issue #${input.issueNumber}` };
  }
}

async function loadIssueCandidateFromMetadata(context: ReturnType<typeof createWorkflowContext>): Promise<AutorunIssueCandidate | undefined> {
  try {
    const raw = await readArtifact(context, "metadata");
    const parsed = JSON.parse(raw) as { issue?: GitHubIssue };
    if (parsed.issue?.number === undefined || parsed.issue.title === "") return undefined;
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

function verificationRepairPassFromPlan(steps: readonly ContinuePlanStep[]): number | undefined {
  const first = steps[0];
  if (first?.type !== "run" || first.phase !== "fix") return undefined;
  return first.reason.includes("verification failed") ? first.pass : undefined;
}

function isTerminalContinuationNoop(steps: readonly ContinuePlanStep[]): boolean {
  const first = steps[0];
  return steps.length === 1 && first?.type === "noop" && first.reason.includes("maximum fix passes reached");
}

function assertAttemptMatchesIssue(metadata: AttemptMetadata, issueNumber: string): void {
  if (String(metadata.issueNumber) !== issueNumber) {
    throw new Error(
      `Attempt metadata issue #${metadata.issueNumber} does not match requested issue #${issueNumber}.`,
    );
  }
}
