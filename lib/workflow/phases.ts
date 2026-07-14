import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
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
  inferNextFixPass,
  inferNextRefinementPass,
  latestCompleteReviewCycle,
  readArtifact,
  type ArtifactRef,
  type WorkflowContext,
  writeArtifact,
  writeJsonArtifact,
} from "./artifacts.ts";
import { validateAgentArtifact } from "./artifact-validation.ts";
import { assertCleanGit, capturePreImplementationBaseline, resetWorktreeToPreImplementationBaseline, type PreImplementationBaseline } from "./git.ts";
import { createIssuesPhase } from "../issue-curation/create-issues.ts";
import { issueCurationPhase } from "./issue-curation.ts";
import { buildReadinessArtifacts } from "./readiness.ts";
import {
  issueArtifactHasRelationshipSnapshot,
  planWorkflowProgression,
  type WorkflowProgressionAction,
} from "./progression.ts";
import type { SinglePhaseCommand, StandaloneWorkflowPhase, WorkflowRunPhase } from "./phase-vocabulary.ts";
import {
  codeRefinementTask,
  type CodeRefinementSource,
  fixTask,
  implementationTaskForPass,
  reviewATaskForPass,
  reviewBTaskForPass,
  runChangeReportTask,
  runPlanDraftTask,
  runPlanTask,
  runReviewTask,
  runTriageTask,
} from "./tasks.ts";
import type { ReviewResult } from "../review/result.ts";
import type { TriageResult } from "../triage/result.ts";
import type { ImplementationPlanResult } from "../implementation-plan/result.ts";
import type { ChangeReport } from "../change-report/result.ts";

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

export async function triagePhase(context: WorkflowContext, runner: AgentRunner = runPiAgent): Promise<TriageResult> {
  return runTriageTask(context, runner);
}

export async function planDraftPhase(context: WorkflowContext, runner: AgentRunner = runPiAgent): Promise<ImplementationPlanResult> {
  return runPlanDraftTask(context, runner);
}

export async function planPhase(context: WorkflowContext, runner: AgentRunner = runPiAgent): Promise<ImplementationPlanResult> {
  return runPlanTask(context, runner);
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

export async function implementationPhase(context: WorkflowContext, runner: AgentRunner = runPiAgent, restartPass = 0): Promise<ChangeReport> {
  const task = implementationTaskForPass(restartPass);
  if (await shouldRegenerateArtifact(context, task.artifact) || restartPass > 0) {
    await assertCleanGit({ cwd: context.agentCwd, yes: context.yes || restartPass > 0 });
  }
  const content = await runChangeReportTaskWithForceOverride(context, runner, task, restartPass > 0);
  if (restartPass > 0) {
    await writeArtifact(
      context,
      implementationRestartLogRef(restartPass),
      `# Implementation Restart Log Pass ${restartPass}\n\n## Summary\nRestart implementation completed after baseline reset. See implementation-log.json for the authoritative report and implementation-log.md for its human-readable view.\n`,
    );
  }
  return content;
}

export async function codeRefinementPhase(
  context: WorkflowContext,
  pass = inferNextRefinementPass(context),
  runner: AgentRunner = runPiAgent,
): Promise<ChangeReport> {
  return runChangeReportTask(context, runner, codeRefinementTask(pass, codeRefinementSourceForPass(context, pass)));
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
): Promise<{ reviewA: ReviewResult; reviewB: ReviewResult }> {
  const [reviewA, reviewB] = await Promise.allSettled([
    runReviewTask(context, runner, reviewATaskForPass(pass)),
    runReviewTask(context, runner, reviewBTaskForPass(pass)),
  ]);
  if (reviewA.status === "rejected") throw reviewA.reason;
  if (reviewB.status === "rejected") throw reviewB.reason;
  return { reviewA: reviewA.value, reviewB: reviewB.value };
}

export async function fixPhase(
  context: WorkflowContext,
  pass = inferNextFixPass(context),
  runner: AgentRunner = runPiAgent,
): Promise<ChangeReport> {
  const task = fixTask(pass);
  if (await shouldRegenerateArtifact(context, task.artifact)) {
    await assertCleanGit({ cwd: context.agentCwd, yes: true });
  }
  return runChangeReportTask(context, runner, task);
}

export async function resetBaselinePhase(context: WorkflowContext, pass: number): Promise<string> {
  const baseline = JSON.parse(await readArtifact(context, "preImplementationBaseline")) as PreImplementationBaseline;
  await resetWorktreeToPreImplementationBaseline({ cwd: context.agentCwd, baseline });
  const content = `# Baseline Reset Pass ${pass}\n\n## Summary\nReset non-.roark worktree state to pre-implementation baseline ${baseline.head}.\n\n## Preserved Control Plane\n.roark artifacts were preserved.\n`;
  await writeArtifact(context, baselineResetLogRef(pass), content);
  console.log(`✓ Reset baseline: wrote baseline-reset-${pass}.md`);
  return content;
}

export async function readinessPhase(context: WorkflowContext): Promise<string> {
  await context.observer?.phaseStarted({ phase: "readiness", label: "Readiness", artifact: "readiness" });
  try {
    const readiness = await buildReadinessArtifacts(context);
    await writeJsonArtifact(context, "readiness", readiness.result);
    await writeArtifact(context, "readinessMarkdown", readiness.markdown);
    await context.observer?.phaseCompleted({ phase: "readiness", label: "Readiness", artifact: "readiness" });
    console.log(`✓ Readiness: wrote readiness.json and readiness.md`);
    return readiness.markdown;
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
      const following = progression.actions[1];
      if (
        next.phase === "review-a" &&
        following?.type === "run" &&
        following.phase === "review-b" &&
        following.pass === next.pass
      ) {
        await reviewPhase(context, next.pass ?? 0, runner);
        completedActions.push(next, following);
        continue;
      }
      await runWorkflowPhase(context, runner, next.phase, next.pass);
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

async function runWorkflowPhase(
  context: WorkflowContext,
  runner: AgentRunner,
  phase: WorkflowRunPhase,
  pass?: number,
): Promise<void> {
  switch (phase) {
    case "fetch": await fetchIssuePhase(context); return;
    case "triage": await triagePhase(context, runner); return;
    case "plan-draft": await planDraftPhase(context, runner); return;
    case "plan": await planPhase(context, runner); return;
    case "capture-baseline": await captureBaselinePhase(context); return;
    case "implement": await implementationPhase(context, runner, pass ?? 0); return;
    case "refine-code": await codeRefinementPhase(context, pass, runner); return;
    case "review-a": await runReviewTask(context, runner, reviewATaskForPass(pass ?? 0)); return;
    case "review-b": await runReviewTask(context, runner, reviewBTaskForPass(pass ?? 0)); return;
    case "fix": await fixPhase(context, pass, runner); return;
    case "reset-baseline": await resetBaselinePhase(context, pass ?? 1); return;
    default: return assertNever(phase);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unsupported workflow phase '${String(value)}'.`);
}

function logAndReturnTerminal(result: WorkflowRunResult): WorkflowRunResult {
  if (result.status === "triage-stopped") console.log(`\nStopped after triage: ${result.triageVerdict}`);
  else if (result.status === "planning-stopped") console.log("\nStopped after planning: plan is not ready for implementation.");
  else if (result.status === "review-blocked") console.log("\nStopped after review: at least one review is blocked.");
  return result;
}

function inferNextReviewPass(context: WorkflowContext): number {
  return (latestCompleteReviewCycle(context) ?? -1) + 1;
}

async function runChangeReportTaskWithForceOverride(
  context: WorkflowContext,
  runner: AgentRunner,
  task: Parameters<typeof runChangeReportTask>[2],
  force: boolean,
): Promise<ChangeReport> {
  if (!force) return runChangeReportTask(context, runner, task);
  const previous = context.force;
  context.force = true;
  try {
    return await runChangeReportTask(context, runner, task);
  } finally {
    context.force = previous;
  }
}

async function shouldRegenerateArtifact(context: WorkflowContext, artifact: ArtifactRef): Promise<boolean> {
  if (context.force || !artifactExists(context, artifact)) return true;
  const existing = await readArtifact(context, artifact);
  return !validateAgentArtifact(artifact, existing).ok;
}

function assertAttemptSelectedWhenAttemptsExist(context: WorkflowContext, command: "curate-issues" | "create-issues"): void {
  if (context.attempt !== undefined) return;
  const attemptsDir = path.join(context.outDir, "issue", context.issueNumber, "attempts");
  if (!existsSync(attemptsDir)) return;
  const attempts = readdirSync(attemptsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
    .map((entry) => Number(entry.name))
    .sort((left, right) => left - right);
  if (attempts.length === 0) return;
  const latest = attempts[attempts.length - 1];
  if (latest === undefined) return;
  throw new Error(`Issue #${context.issueNumber} has attempt artifacts under ${path.relative(context.controlCwd, attemptsDir)}. Run '${command} ${context.issueInput} --attempt ${latest}' (or choose another attempt) so reviewer findings are curated from the intended attempt.`);
}

export async function runSinglePhase(
  context: WorkflowContext,
  phase: SinglePhaseCommand,
  runner: AgentRunner = runPiAgent,
): Promise<void> {
  context.observer ??= createFileRunObserver(context);
  await context.observer.runStarted({ command: phase });
  try {
    if (phase === "review") await reviewPhase(context, context.fixPass ?? inferNextReviewPass(context), runner);
    else if (phase === "readiness") await readinessPhase(context);
    else if (phase === "curate-issues") {
      assertAttemptSelectedWhenAttemptsExist(context, "curate-issues");
      await issueCurationPhase(context);
    }
    else if (phase === "create-issues") {
      assertAttemptSelectedWhenAttemptsExist(context, "create-issues");
      await createIssuesPhase(context, runner);
    }
    else await runWorkflowPhase(context, runner, phase, standalonePhasePass(context, phase));
    await context.observer.runCompleted({ status: "completed" });
  } catch (error) {
    await context.observer.runFailed(error);
    throw error;
  }
}

function standalonePhasePass(context: WorkflowContext, phase: StandaloneWorkflowPhase): number | undefined {
  if (phase === "refine-code") return context.fixPass ?? inferNextRefinementPass(context);
  if (phase === "fix") return context.fixPass ?? inferNextFixPass(context);
  if (phase === "reset-baseline") return context.fixPass ?? 1;
  return undefined;
}
