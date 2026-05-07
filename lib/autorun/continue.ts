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
import { checkoutExistingIssueBranch, type AutorunBranchPlan } from "./branch.ts";
import { formatContinuationPlan, planContinuation } from "./continue-plan.ts";
import type { AutorunGateOptions } from "./publish-flow.ts";
import { formatContinueCommand } from "./recovery.ts";
import { runAutorunAttemptLifecycle } from "./attempt-lifecycle.ts";
import type { AutorunIssueCandidate } from "./selection.ts";

export async function runAutoContinue(
  options: ContinueCliOptions,
  injected: { clock?: Clock; runner?: AgentRunner } = {},
): Promise<void> {
  const clock = injected.clock ?? defaultClock;
  const runner = injected.runner ?? runPiAgent;
  const cwd = path.resolve(options.cwd);
  const parsed = parseIssueRef(options.issue, options.repo);
  const outDir = path.resolve(cwd, options.outDir);
  const issueDir = path.join(outDir, "issue", parsed.issueNumber);
  const attempt = options.attempt ?? await latestAttemptNumber(issueDir);
  const recoveryCommand = formatContinueCommand({ issueNumber: parsed.issueNumber, repo: parsed.repo, attempt });

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

  const branchPlan: AutorunBranchPlan = {
    issueNumber: attemptMetadata.issueNumber,
    branchName: attemptMetadata.branch,
    baseBranch: attemptMetadata.baseBranch,
  };

  const workflowContext = createWorkflowContext(createContinueWorkflowOptions(options, attempt));
  await ensureRunDir(workflowContext);

  console.log(`- Switching to branch ${branchPlan.branchName}`);
  await checkoutExistingIssueBranch({ cwd: workflowContext.cwd, plan: branchPlan });

  attemptMetadata = formatAttemptMetadata({
    ...attemptMetadata,
    worktreePath: workflowContext.cwd,
    runArtifactPath: workflowContext.runDirRelative,
  });

  await runAutorunAttemptLifecycle({
    issueDir,
    workflowContext,
    branchPlan,
    gateOptions: createGateOptions(options, workflowContext.cwd, branchPlan.baseBranch, parsed.repo),
    attemptMetadata,
    loadIssue: () => loadIssueCandidate({ context: workflowContext, options, issueNumber: attemptMetadata.issueNumber }),
    runner,
    logPrefix: "Continue",
    inProgressOutcomeDetail: `continued at ${clock.now().toISOString()}`,
    beforeWorkflow: async () => {
      const plan = await planContinuation(workflowContext);
      console.log("\nContinuation plan:");
      for (const line of formatContinuationPlan(plan)) console.log(line);
    },
  }, { clock });

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
    failureLabel: options.failureLabel,
    successLabel: options.successLabel,
    inProgressLabel: options.inProgressLabel,
    remote: options.remote,
    baseBranch,
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
    const fetched = await fetchGitHubIssue(input.options.issue, { cwd: input.context.cwd, repo: input.options.repo });
    return toIssueCandidate(fetched.issue);
  } catch {
    return { number: input.issueNumber, title: `Fix issue #${input.issueNumber}` };
  }
}

async function loadIssueCandidateFromMetadata(context: ReturnType<typeof createWorkflowContext>): Promise<AutorunIssueCandidate | undefined> {
  try {
    const raw = await readArtifact(context, "metadata");
    const parsed = JSON.parse(raw) as { issue?: GitHubIssue };
    if (!parsed.issue?.number || !parsed.issue.title) return undefined;
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

function assertAttemptMatchesIssue(metadata: AttemptMetadata, issueNumber: string): void {
  if (String(metadata.issueNumber) !== issueNumber) {
    throw new Error(
      `Attempt metadata issue #${metadata.issueNumber} does not match requested issue #${issueNumber}.`,
    );
  }
}
