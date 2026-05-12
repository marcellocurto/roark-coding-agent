import { fetchGitHubIssue } from "../github/issue.ts";
import { createFileRunObserver } from "../observability/observer.ts";
import { runPiAgent } from "../pi/agent.ts";
import { formatGitHubIssueArtifact } from "../prompts/github-issue-artifact.ts";
import type { AgentRunner } from "./agent-runner.ts";
import {
  artifactExists,
  baselineResetLogRef,
  fixLogRef,
  implementationRestartLogRef,
  inferNextFinalReviewPass,
  inferNextFixPass,
  inferNextRefinementPass,
  readArtifact,
  reviewARef,
  reviewBRef,
  type ArtifactRef,
  type WorkflowContext,
  writeArtifact,
  writeJsonArtifact,
} from "./artifacts.ts";
import { validateAgentArtifact } from "./artifact-validation.ts";
import { assertCleanGit, capturePreImplementationBaseline, resetWorktreeToPreImplementationBaseline, type PreImplementationBaseline } from "./git.ts";
import { createIssuesPhase } from "../issue-curation/create-issues.ts";
import { issueCurationPhase } from "./issue-curation.ts";
import { buildReadinessMarkdown } from "./readiness.ts";
import {
  issueArtifactHasRelationshipSnapshot,
  planWorkflowProgression,
  type WorkflowProgressionAction,
} from "./progression.ts";
import {
  codeRefinementTask,
  type CodeRefinementSource,
  finalReviewTask,
  fixTask,
  implementationTaskForPass,
  planDraftTask,
  planTask,
  reviewATaskForPass,
  reviewBTaskForPass,
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
    const result = await fetchGitHubIssue(context.issueInput, { cwd: context.controlCwd, repo: context.repo });
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

export async function planDraftPhase(context: WorkflowContext, runner: AgentRunner = runPiAgent): Promise<string> {
  return runAgentTask(context, runner, planDraftTask);
}

export async function planPhase(context: WorkflowContext, runner: AgentRunner = runPiAgent): Promise<string> {
  return runAgentTask(context, runner, planTask);
}

export async function captureBaselinePhase(context: WorkflowContext): Promise<string> {
  if (!context.force && artifactExists(context, "preImplementationBaseline")) {
    const existing = await readArtifact(context, "preImplementationBaseline");
    if (existing.trim()) return existing;
  }
  const baseline = await capturePreImplementationBaseline({ cwd: context.agentCwd, yes: context.yes });
  const content = JSON.stringify({
    ...baseline,
    note: "Restart resets non-.roark worktree state to this baseline; .roark control-plane artifacts are preserved.",
  }, null, 2);
  await writeArtifact(context, "preImplementationBaseline", content);
  console.log(`✓ Capture baseline: wrote pre-implementation-baseline.json`);
  return content;
}

export async function implementationPhase(context: WorkflowContext, runner: AgentRunner = runPiAgent, restartPass = 0): Promise<string> {
  const task = implementationTaskForPass(restartPass);
  if (await shouldRegenerateArtifact(context, task.artifact) || restartPass > 0) {
    await assertCleanGit({ cwd: context.agentCwd, yes: context.yes || restartPass > 0 });
  }
  const content = await runAgentTaskWithForceOverride(context, runner, task, restartPass > 0);
  if (restartPass > 0) {
    await writeArtifact(
      context,
      implementationRestartLogRef(restartPass),
      `# Implementation Restart Log Pass ${restartPass}\n\n## Summary\nRestart implementation completed after baseline reset. See implementation-log.md for the implementation log.\n`,
    );
  }
  return content;
}

export async function codeRefinementPhase(
  context: WorkflowContext,
  pass = inferNextRefinementPass(context),
  runner: AgentRunner = runPiAgent,
): Promise<string> {
  return runAgentTask(context, runner, codeRefinementTask(pass, codeRefinementSourceForPass(context, pass)));
}

function codeRefinementSourceForPass(context: WorkflowContext, pass: number): CodeRefinementSource {
  if (pass === 0) return "initial";
  if (artifactExists(context, fixLogRef(pass))) return "fix";
  if (artifactExists(context, implementationRestartLogRef(pass)) || artifactExists(context, baselineResetLogRef(pass))) return "restart";
  return "fix";
}

export async function reviewPhase(
  context: WorkflowContext,
  pass = inferNextReviewPass(context),
  runner: AgentRunner = runPiAgent,
): Promise<{ reviewA: string; reviewB: string }> {
  const reviewA = await runAgentTask(context, runner, reviewATaskForPass(pass));
  const reviewB = await runAgentTask(context, runner, reviewBTaskForPass(pass));
  return { reviewA, reviewB };
}

export async function fixPhase(
  context: WorkflowContext,
  pass = inferNextFixPass(context),
  runner: AgentRunner = runPiAgent,
): Promise<string> {
  const task = fixTask(pass);
  if (await shouldRegenerateArtifact(context, task.artifact)) {
    await assertCleanGit({ cwd: context.agentCwd, yes: true });
  }
  return runAgentTask(context, runner, task);
}

export async function resetBaselinePhase(context: WorkflowContext, pass: number): Promise<string> {
  const baseline = JSON.parse(await readArtifact(context, "preImplementationBaseline")) as PreImplementationBaseline;
  await resetWorktreeToPreImplementationBaseline({ cwd: context.agentCwd, baseline });
  const content = `# Baseline Reset Pass ${pass}\n\n## Summary\nReset non-.roark worktree state to pre-implementation baseline ${baseline.head}.\n\n## Preserved Control Plane\n.roark artifacts were preserved.\n`;
  await writeArtifact(context, baselineResetLogRef(pass), content);
  console.log(`✓ Reset baseline: wrote baseline-reset-${pass}.md`);
  return content;
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
  else if (action.phase === "plan-draft") await planDraftPhase(context, runner);
  else if (action.phase === "plan") await planPhase(context, runner);
  else if (action.phase === "capture-baseline") await captureBaselinePhase(context);
  else if (action.phase === "implement") await implementationPhase(context, runner, action.pass ?? 0);
  else if (action.phase === "refine-code") await codeRefinementPhase(context, action.pass, runner);
  else if (action.phase === "review-a") await runAgentTask(context, runner, reviewATaskForPass(action.pass ?? 0));
  else if (action.phase === "review-b") await runAgentTask(context, runner, reviewBTaskForPass(action.pass ?? 0));
  else if (action.phase === "fix") await fixPhase(context, action.pass, runner);
  else if (action.phase === "reset-baseline") await resetBaselinePhase(context, action.pass ?? 1);
  else await finalReviewPhase(context, action.pass, runner);
}

function logAndReturnTerminal(result: WorkflowRunResult): WorkflowRunResult {
  if (result.status === "triage-stopped") console.log(`\nStopped after triage: ${result.triageVerdict}`);
  else if (result.status === "planning-stopped") console.log("\nStopped after planning: plan is not ready for implementation.");
  else if (result.status === "review-blocked") console.log("\nStopped after review: at least one review is blocked.");
  return result;
}

function inferNextReviewPass(context: WorkflowContext): number {
  for (let pass = 0; ; pass++) {
    if (!artifactExists(context, reviewARef(pass)) || !artifactExists(context, reviewBRef(pass))) return pass;
  }
}

async function runAgentTaskWithForceOverride(
  context: WorkflowContext,
  runner: AgentRunner,
  task: Parameters<typeof runAgentTask>[2],
  force: boolean,
): Promise<string> {
  if (!force) return runAgentTask(context, runner, task);
  const previous = context.force;
  context.force = true;
  try {
    return await runAgentTask(context, runner, task);
  } finally {
    context.force = previous;
  }
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
    else if (phase === "plan-draft") await planDraftPhase(context, runner);
    else if (phase === "plan") await planPhase(context, runner);
    else if (phase === "capture-baseline") await captureBaselinePhase(context);
    else if (phase === "implement") await implementationPhase(context, runner);
    else if (phase === "refine-code") await codeRefinementPhase(context, context.fixPass ?? inferNextRefinementPass(context), runner);
    else if (phase === "review") await reviewPhase(context, context.fixPass ?? inferNextReviewPass(context), runner);
    else if (phase === "fix") await fixPhase(context, context.fixPass ?? inferNextFixPass(context), runner);
    else if (phase === "reset-baseline") await resetBaselinePhase(context, context.fixPass ?? 1);
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
