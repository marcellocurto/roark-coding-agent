import path from "node:path";
import type { ContinueCliOptions, IssueCliOptions } from "../cli/args.ts";
import { fetchGitHubIssue, parseIssueRef, type GitHubIssue } from "../github/issue.ts";
import { ArtifactValidationError } from "../workflow/artifact-validation.ts";
import { artifactRelativePath, createWorkflowContext, ensureRunDir, readArtifact, type WorkflowContext } from "../workflow/artifacts.ts";
import type { AgentRunner } from "../workflow/agent-runner.ts";
import { runPiAgent } from "../pi/agent.ts";
import { runFullWorkflow } from "../workflow/phases.ts";
import {
  attemptMetadataRelativePath,
  defaultClock,
  formatAttemptMetadata,
  latestAttemptNumber,
  readAttemptMetadata,
  summarizeAttempt,
  updateAttemptIndex,
  writeAttemptMetadata,
  type AttemptMetadata,
  type AttemptOutcome,
  type Clock,
} from "./attempts.ts";
import { checkoutExistingIssueBranch, type AutorunBranchPlan } from "./branch.ts";
import { formatFailureComment, markIssueFailed } from "./failure.ts";
import { formatContinuationPlan, planContinuation } from "./continue-plan.ts";
import { runPublishGate, type AutorunGateOptions } from "./publish-flow.ts";
import { formatContinueCommand } from "./recovery.ts";
import type { AutorunIssueCandidate } from "./selection.ts";
import { AgentTaskRunError } from "../workflow/tasks.ts";

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
    endedAt: null,
    outcome: "in-progress",
    outcomeDetail: `continued at ${clock.now().toISOString()}`,
  });
  await writeAttemptMetadata(issueDir, attemptMetadata);
  await updateAttemptIndex(issueDir, summarizeAttempt(attemptMetadata));

  const plan = await planContinuation(workflowContext);
  console.log("\nContinuation plan:");
  for (const line of formatContinuationPlan(plan)) console.log(line);

  let outcome: AttemptOutcome = "in-progress";
  let outcomeDetail: string | null = null;

  try {
    await runFullWorkflow(workflowContext, runner);

    const issue = await loadIssueCandidate({ context: workflowContext, options, issueNumber: attemptMetadata.issueNumber });
    const gateOutcome = await runPublishGate({
      options: createGateOptions(options, workflowContext.cwd, branchPlan.baseBranch, parsed.repo),
      issue,
      branchPlan,
      workflowContext,
      attemptMetadata,
      attemptMetadataPath: attemptMetadataRelativePath(attemptMetadata),
      recoveryCommand,
    });
    outcome = gateOutcome.outcome;
    outcomeDetail = gateOutcome.outcomeDetail;
  } catch (error) {
    outcome = isOutputContractError(error) ? "failed-output-contract" : "errored";
    outcomeDetail = formatError(error);
    const issue = await loadIssueCandidate({ context: workflowContext, options, issueNumber: attemptMetadata.issueNumber });
    await markContinueError({
      options,
      issue,
      error,
      workflowContext,
      phase: errorPhase(error),
      attemptMetadataPath: attemptMetadataRelativePath(attemptMetadata),
      recoveryCommand,
      cwd: workflowContext.cwd,
      repo: parsed.repo,
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

async function markContinueError(input: {
  options: ContinueCliOptions;
  issue: AutorunIssueCandidate;
  error: unknown;
  workflowContext: WorkflowContext;
  phase: string;
  attemptMetadataPath: string;
  recoveryCommand: string;
  cwd: string;
  repo?: string;
}): Promise<void> {
  const { options, issue, error, workflowContext, phase, attemptMetadataPath, recoveryCommand, cwd, repo } = input;
  console.log(`\nContinue workflow error on #${issue.number}: ${formatError(error)}`);
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
    cwd,
    repo,
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

function assertAttemptMatchesIssue(metadata: AttemptMetadata, issueNumber: string): void {
  if (String(metadata.issueNumber) !== issueNumber) {
    throw new Error(
      `Attempt metadata issue #${metadata.issueNumber} does not match requested issue #${issueNumber}.`,
    );
  }
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
