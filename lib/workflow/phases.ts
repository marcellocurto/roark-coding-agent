import { fetchGitHubIssue } from "../github/issue.ts";
import { createFileRunObserver } from "../observability/observer.ts";
import { runPiAgent } from "../pi/agent.ts";
import { formatGitHubIssueArtifact } from "../prompts/github-issue-artifact.ts";
import type { AgentRunner } from "./agent-runner.ts";
import {
  artifactExists,
  inferNextFinalReviewPass,
  inferNextFixPass,
  readArtifact,
  type ArtifactRef,
  type WorkflowContext,
  writeArtifact,
  writeJsonArtifact,
} from "./artifacts.ts";
import { validateAgentArtifact } from "./artifact-validation.ts";
import { assertCleanGit } from "./git.ts";
import { createIssuesPhase } from "../issue-curation/create-issues.ts";
import { issueCurationPhase } from "./issue-curation.ts";
import { buildReadinessMarkdown } from "./readiness.ts";
import {
  issueArtifactHasRelationshipSnapshot,
  planWorkflowProgression,
  type WorkflowProgressionAction,
} from "./progression.ts";
import {
  finalReviewTask,
  fixTask,
  implementationTask,
  planTask,
  reviewATask,
  reviewBTask,
  runAgentTask,
  triageTask,
} from "./tasks.ts";

export { issueArtifactHasRelationshipSnapshot } from "./progression.ts";

export async function fetchIssuePhase(context: WorkflowContext): Promise<string> {
  if (!context.force && artifactExists(context, "issue")) {
    const existingIssue = await readArtifact(context, "issue");
    if (issueArtifactHasRelationshipSnapshot(existingIssue)) {
      console.log(`✓ Fetch issue: using existing issue.md`);
      await context.observer?.phaseCompleted({ phase: "fetch", label: "Fetch issue", artifact: "issue", reused: true });
      return existingIssue;
    }
    console.log(`↻ Fetch issue: existing issue.md lacks GitHub relationship snapshot; refetching`);
  }

  console.log(`\n=== Fetch issue #${context.issueNumber} ===`);
  await context.observer?.phaseStarted({ phase: "fetch", label: "Fetch issue", artifact: "issue" });
  try {
    const result = await fetchGitHubIssue(context.issueInput, { cwd: context.cwd, repo: context.repo });
    const issueArtifact = formatGitHubIssueArtifact(result.issue, result.relationships);

    await writeArtifact(context, "issue", issueArtifact);
    await writeJsonArtifact(context, "metadata", {
      issueNumber: result.issueNumber,
      repo: result.repo,
      fetchedAt: new Date().toISOString(),
      issue: result.issue,
      relationships: result.relationships,
    });
    await context.observer?.phaseCompleted({ phase: "fetch", label: "Fetch issue", artifact: "issue" });
    console.log(`✓ Fetch issue: wrote issue.md and metadata.json`);
    return issueArtifact;
  } catch (error) {
    await context.observer?.phaseFailed({ phase: "fetch", label: "Fetch issue", artifact: "issue", error });
    throw error;
  }
}

export async function triagePhase(context: WorkflowContext, runner: AgentRunner = runPiAgent): Promise<string> {
  return runAgentTask(context, runner, triageTask);
}

export async function planPhase(context: WorkflowContext, runner: AgentRunner = runPiAgent): Promise<string> {
  return runAgentTask(context, runner, planTask);
}

export async function implementationPhase(context: WorkflowContext, runner: AgentRunner = runPiAgent): Promise<string> {
  if (await shouldRegenerateArtifact(context, implementationTask.artifact)) {
    await assertCleanGit({ cwd: context.cwd, yes: context.yes });
  }
  return runAgentTask(context, runner, implementationTask);
}

export async function reviewPhase(
  context: WorkflowContext,
  runner: AgentRunner = runPiAgent,
): Promise<{ reviewA: string; reviewB: string }> {
  const reviewA = await runAgentTask(context, runner, reviewATask);
  const reviewB = await runAgentTask(context, runner, reviewBTask);
  return { reviewA, reviewB };
}

export async function fixPhase(
  context: WorkflowContext,
  pass = inferNextFixPass(context),
  runner: AgentRunner = runPiAgent,
): Promise<string> {
  const task = fixTask(pass);
  if (await shouldRegenerateArtifact(context, task.artifact)) {
    await assertCleanGit({ cwd: context.cwd, yes: true });
  }
  return runAgentTask(context, runner, task);
}

export async function finalReviewPhase(
  context: WorkflowContext,
  pass = inferNextFinalReviewPass(context),
  runner: AgentRunner = runPiAgent,
): Promise<string> {
  return runAgentTask(context, runner, finalReviewTask(pass));
}

export async function readinessPhase(context: WorkflowContext): Promise<string> {
  await context.observer?.phaseStarted({ phase: "readiness", label: "Readiness", artifact: "readiness" });
  try {
    const readiness = await buildReadinessMarkdown(context);
    await writeArtifact(context, "readiness", readiness);
    await context.observer?.phaseCompleted({ phase: "readiness", label: "Readiness", artifact: "readiness" });
    console.log(`✓ Readiness: wrote readiness.md`);
    return readiness;
  } catch (error) {
    await context.observer?.phaseFailed({ phase: "readiness", label: "Readiness", artifact: "readiness", error });
    throw error;
  }
}

export type WorkflowRunResult =
  | { status: "triage-stopped"; triageVerdict: string }
  | { status: "planning-stopped" }
  | { status: "review-blocked" }
  | { status: "completed" };

export async function runFullWorkflow(context: WorkflowContext, runner: AgentRunner = runPiAgent): Promise<WorkflowRunResult> {
  context.observer ??= createFileRunObserver(context);
  await context.observer.runStarted({ command: "do" });
  try {
    const result = await runFullWorkflowBody(context, runner);
    await context.observer.runCompleted({ status: result.status });
    return result;
  } catch (error) {
    await context.observer.runFailed(error);
    throw error;
  }
}

async function runFullWorkflowBody(context: WorkflowContext, runner: AgentRunner): Promise<WorkflowRunResult> {
  const completedActions: WorkflowProgressionAction[] = [];

  for (;;) {
    const progression = await planWorkflowProgression(context, {
      force: context.force,
      completedActions,
    });
    const next = progression.actions[0];

    if (!next) {
      if (progression.terminalStatus) return progression.terminalStatus;
      throw new Error("Workflow progression produced no next action and no terminal status.");
    }

    if (next.type === "run") {
      await runProgressionPhase(context, runner, next);
      completedActions.push(next);
      continue;
    }

    if (next.type === "write-readiness") {
      await readinessPhase(context);
      completedActions.push(next);
      if (progression.terminalStatus) return logAndReturnTerminal(progression.terminalStatus);
      continue;
    }

    if (next.type === "noop") {
      if (progression.terminalStatus) return logAndReturnTerminal(progression.terminalStatus);
      throw new Error(`Workflow progression returned a no-op without a terminal status: ${next.reason}`);
    }

    throw new Error(`Workflow progression returned unsupported fresh-run action '${next.type}'.`);
  }
}

async function runProgressionPhase(
  context: WorkflowContext,
  runner: AgentRunner,
  action: Extract<WorkflowProgressionAction, { type: "run" }>,
): Promise<void> {
  if (action.phase === "fetch") await fetchIssuePhase(context);
  else if (action.phase === "triage") await triagePhase(context, runner);
  else if (action.phase === "plan") await planPhase(context, runner);
  else if (action.phase === "implement") await implementationPhase(context, runner);
  else if (action.phase === "review-a") await runAgentTask(context, runner, reviewATask);
  else if (action.phase === "review-b") await runAgentTask(context, runner, reviewBTask);
  else if (action.phase === "fix") await fixPhase(context, action.pass, runner);
  else if (action.phase === "final-review") await finalReviewPhase(context, action.pass, runner);
  else assertNever(action.phase);
}

function logAndReturnTerminal(result: WorkflowRunResult): WorkflowRunResult {
  if (result.status === "triage-stopped") console.log(`\nStopped after triage: ${result.triageVerdict}`);
  else if (result.status === "planning-stopped") console.log("\nStopped after planning: plan is not ready for implementation.");
  else if (result.status === "review-blocked") console.log("\nStopped after review: at least one review is blocked.");
  return result;
}

function assertNever(value: never): never {
  throw new Error(`Unexpected workflow progression phase '${String(value)}'.`);
}

async function shouldRegenerateArtifact(context: WorkflowContext, artifact: ArtifactRef): Promise<boolean> {
  if (context.force || !artifactExists(context, artifact)) return true;
  const existing = await readArtifact(context, artifact);
  return !validateAgentArtifact(artifact, existing).ok;
}

export async function runSinglePhase(
  context: WorkflowContext,
  phase: string,
  runner: AgentRunner = runPiAgent,
): Promise<void> {
  context.observer ??= createFileRunObserver(context);
  await context.observer.runStarted({ command: phase });
  try {
    if (phase === "fetch") await fetchIssuePhase(context);
    else if (phase === "triage") await triagePhase(context, runner);
    else if (phase === "plan") await planPhase(context, runner);
    else if (phase === "implement") await implementationPhase(context, runner);
    else if (phase === "review") await reviewPhase(context, runner);
    else if (phase === "fix") await fixPhase(context, context.fixPass ?? inferNextFixPass(context), runner);
    else if (phase === "final-review") await finalReviewPhase(context, context.fixPass ?? inferNextFinalReviewPass(context), runner);
    else if (phase === "readiness") await readinessPhase(context);
    else if (phase === "curate-issues") await issueCurationPhase(context);
    else if (phase === "create-issues") await createIssuesPhase(context, runner);
    else throw new Error(`Unsupported phase '${phase}'.`);
    await context.observer.runCompleted({ status: "completed" });
  } catch (error) {
    await context.observer.runFailed(error);
    throw error;
  }
}
