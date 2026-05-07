import { fetchGitHubIssue } from "../github/issue.ts";
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
  hasBlockedReview,
  parseVerdict,
  shouldImplementPlan,
  shouldProceedAfterTriage,
  shouldRunAnotherFixPass,
  needsFix,
} from "./verdicts.ts";
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

export async function fetchIssuePhase(context: WorkflowContext): Promise<string> {
  if (!context.force && artifactExists(context, "issue")) {
    console.log(`✓ Fetch issue: using existing issue.md`);
    return readArtifact(context, "issue");
  }

  console.log(`\n=== Fetch issue #${context.issueNumber} ===`);
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
  console.log(`✓ Fetch issue: wrote issue.md and metadata.json`);
  return issueArtifact;
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
  const readiness = await buildReadinessMarkdown(context);
  await writeArtifact(context, "readiness", readiness);
  console.log(`✓ Readiness: wrote readiness.md`);
  return readiness;
}

export type WorkflowRunResult =
  | { status: "triage-stopped"; triageVerdict: string }
  | { status: "planning-stopped" }
  | { status: "review-blocked" }
  | { status: "completed" };

export async function runFullWorkflow(context: WorkflowContext, runner: AgentRunner = runPiAgent): Promise<WorkflowRunResult> {
  await fetchIssuePhase(context);

  const triage = await triagePhase(context, runner);
  if (!shouldProceedAfterTriage(triage)) {
    const triageVerdict = parseVerdict(triage) ?? "unknown";
    await readinessPhase(context);
    console.log(`\nStopped after triage: ${triageVerdict}`);
    return { status: "triage-stopped", triageVerdict };
  }

  const plan = await planPhase(context, runner);
  if (!shouldImplementPlan(plan)) {
    await readinessPhase(context);
    console.log("\nStopped after planning: plan is not ready for implementation.");
    return { status: "planning-stopped" };
  }

  await implementationPhase(context, runner);
  const { reviewA, reviewB } = await reviewPhase(context, runner);

  if (hasBlockedReview(reviewA, reviewB)) {
    await readinessPhase(context);
    console.log("\nStopped after review: at least one review is blocked.");
    return { status: "review-blocked" };
  }

  if (needsFix(reviewA, reviewB)) {
    for (let pass = 1; pass <= context.maxFixPasses; pass++) {
      await fixPhase(context, pass, runner);
      const finalReview = await finalReviewPhase(context, pass, runner);
      if (!shouldRunAnotherFixPass(finalReview)) break;
    }
  }

  await readinessPhase(context);
  return { status: "completed" };
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
  if (phase === "fetch") await fetchIssuePhase(context);
  else if (phase === "triage") await triagePhase(context, runner);
  else if (phase === "plan") await planPhase(context, runner);
  else if (phase === "implement") await implementationPhase(context, runner);
  else if (phase === "review") await reviewPhase(context, runner);
  else if (phase === "fix") await fixPhase(context, context.fixPass ?? inferNextFixPass(context), runner);
  else if (phase === "final-review") await finalReviewPhase(context, context.fixPass ?? inferNextFinalReviewPass(context), runner);
  else if (phase === "readiness") await readinessPhase(context);
  else if (phase === "curate-issues") await issueCurationPhase(context);
  else if (phase === "create-issues") await createIssuesPhase(context);
  else throw new Error(`Unsupported phase '${phase}'.`);
}
