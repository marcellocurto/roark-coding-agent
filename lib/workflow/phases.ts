import { fromLegacyPromise } from "../runtime/application.ts";
import { runApplicationPromise } from "../runtime/application.ts";
import type { ApplicationExecution } from "../runtime/application.ts";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { type GitHubIssueSnapshot } from "../github/issue.ts";
import { fetchGitHubIssuePromise as fetchGitHubIssue } from "../github/promise.ts";
import { createFileRunObserver } from "../observability/observer.ts";
import { runAgentPromise } from "./agent-runner.ts";
import {
  presenter,
  type AgentDisplayContext,
  type AgentOperation,
} from "../presentation/presenter.ts";
import { runPresentedPhase } from "../presentation/phase.ts";
import { formatGitHubIssueArtifact } from "../prompts/github-issue-artifact.ts";
import type { AgentRunner } from "./agent-runner.ts";
import {
  baselineResetLogRef,
  fixLogRef,
  implementationRestartLogRef,
  type ArtifactRef,
  type WorkflowContext,
} from "./artifacts.ts";
import {
  artifactExistsPromise as artifactExists,
  inferNextFixPassPromise as inferNextFixPass,
  inferNextRefinementPassPromise as inferNextRefinementPass,
  latestCompleteReviewCyclePromise as latestCompleteReviewCycle,
} from "./artifacts-promise.ts";
import {
  readArtifactPromise as readArtifact,
  writeArtifactPromise as writeArtifact,
  writeJsonArtifactPromise as writeJsonArtifact,
} from "./artifacts-promise.ts";
import { validateAgentArtifact } from "./artifact-validation.ts";
import {
  assertCleanGit,
  capturePreImplementationBaseline,
  resetWorktreeToPreImplementationBaseline,
  type PreImplementationBaseline,
} from "./git.ts";
import { createIssuesPhase } from "../issue-curation/create-issues.ts";
import { issueCurationPhase } from "./issue-curation.ts";
import { buildReadinessArtifacts } from "./readiness.ts";
import {
  issueArtifactHasRelationshipSnapshot,
  planWorkflowProgression,
  type WorkflowProgressionAction,
} from "./progression.ts";
import type {
  SinglePhaseCommand,
  StandaloneWorkflowPhase,
  WorkflowRunPhase,
} from "./phase-vocabulary.ts";
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

export async function fetchIssuePhase(
  context: WorkflowContext,
  suppliedSnapshot?: GitHubIssueSnapshot,
  application?: ApplicationExecution,
): Promise<string> {
  if (!application)
    return runApplicationPromise(
      fromLegacyPromise((application) =>
        fetchIssuePhase(context, suppliedSnapshot, application),
      ),
      application,
    );

  const display = deterministicDisplay(
    context,
    "fetch",
    "Fetch issue",
    "issue.md",
    "inspect",
  );
  let outcome = "fetched";
  return runPresentedPhase(
    display,
    async () => {
      if (
        !context.force &&
        suppliedSnapshot === undefined &&
        (await artifactExists(context, "issue", application))
      ) {
        const existingIssue = await readArtifact(context, "issue", application);
        if (issueArtifactHasRelationshipSnapshot(existingIssue)) {
          await context.observer?.phaseCompleted({
            phase: "fetch",
            label: "Fetch issue",
            artifact: "issue",
            reused: true,
          });
          outcome = "reused";
          return existingIssue;
        }
        presenter(application).line(
          "Fetch issue: existing issue.md lacks GitHub relationship snapshot; refetching",
        );
      }

      presenter(application).line(
        suppliedSnapshot
          ? `Using fresh pre-claim snapshot for issue #${context.issueNumber}`
          : `Fetching issue #${context.issueNumber}`,
      );
      await context.observer?.phaseStarted({
        phase: "fetch",
        label: "Fetch issue",
        artifact: "issue",
      });
      const result =
        suppliedSnapshot ??
        (await fetchGitHubIssue(
          context.issueInput,
          { cwd: context.controlCwd, repo: context.repo },
          application,
        ));
      assertSnapshotMatchesContext(context, result);
      const issueArtifact = formatGitHubIssueArtifact(
        result.issue,
        result.relationships,
      );

      await writeArtifact(context, "issue", issueArtifact, application);
      await writeJsonArtifact(
        context,
        "metadata",
        {
          issueNumber: result.issueNumber,
          repo: result.repo,
          fetchedAt: result.fetchedAt,
          issue: result.issue,
          relationships: result.relationships,
        },
        application,
      );
      await context.observer?.phaseCompleted({
        phase: "fetch",
        label: "Fetch issue",
        artifact: "issue",
      });
      return issueArtifact;
    },
    () => ({ outcome, artifact: "issue.md" }),
    {
      onError: (error) =>
        context.observer?.phaseFailed({
          phase: "fetch",
          label: "Fetch issue",
          artifact: "issue",
          error,
        }),
    },
    application,
  );
}

export async function triagePhase(
  context: WorkflowContext,
  runner: AgentRunner = runAgentPromise,
  application?: ApplicationExecution,
): Promise<TriageResult> {
  if (!application)
    return runApplicationPromise(
      fromLegacyPromise((application) =>
        triagePhase(context, runner, application),
      ),
      application,
    );

  return runTriageTask(context, runner, undefined, application);
}

export async function planDraftPhase(
  context: WorkflowContext,
  runner: AgentRunner = runAgentPromise,
  application?: ApplicationExecution,
): Promise<ImplementationPlanResult> {
  if (!application)
    return runApplicationPromise(
      fromLegacyPromise((application) =>
        planDraftPhase(context, runner, application),
      ),
      application,
    );

  return runPlanDraftTask(context, runner, undefined, application);
}

export async function planPhase(
  context: WorkflowContext,
  runner: AgentRunner = runAgentPromise,
  application?: ApplicationExecution,
): Promise<ImplementationPlanResult> {
  if (!application)
    return runApplicationPromise(
      fromLegacyPromise((application) =>
        planPhase(context, runner, application),
      ),
      application,
    );

  return runPlanTask(context, runner, undefined, application);
}

export async function captureBaselinePhase(
  context: WorkflowContext,
  application?: ApplicationExecution,
): Promise<string> {
  if (!application)
    return runApplicationPromise(
      fromLegacyPromise((application) =>
        captureBaselinePhase(context, application),
      ),
      application,
    );

  const display = deterministicDisplay(
    context,
    "capture-baseline",
    "Capture baseline",
    "pre-implementation-baseline.json",
    "inspect",
  );
  let outcome = "captured";
  return runPresentedPhase(
    display,
    async () => {
      if (
        !context.force &&
        (await artifactExists(
          context,
          "preImplementationBaseline",
          application,
        ))
      ) {
        const existing = await readArtifact(
          context,
          "preImplementationBaseline",
          application,
        );
        if (existing.trim()) {
          outcome = "reused";
          return existing;
        }
      }
      const baseline = await capturePreImplementationBaseline(
        { cwd: context.agentCwd, yes: context.yes },
        application,
      );
      const content = JSON.stringify(
        {
          ...baseline,
          note: "Restart resets non-.roark worktree state to this baseline; .roark control-plane artifacts are preserved.",
        },
        null,
        2,
      );
      await writeArtifact(
        context,
        "preImplementationBaseline",
        content,
        application,
      );
      return content;
    },
    () => ({ outcome, artifact: display.expectedArtifact }),
    undefined,
    application,
  );
}

export async function implementationPhase(
  context: WorkflowContext,
  runner: AgentRunner = runAgentPromise,
  restartPass = 0,
  application?: ApplicationExecution,
): Promise<ChangeReport> {
  if (!application)
    return runApplicationPromise(
      fromLegacyPromise((application) =>
        implementationPhase(context, runner, restartPass, application),
      ),
      application,
    );

  const task = implementationTaskForPass(restartPass);
  if (
    (await shouldRegenerateArtifact(context, task.artifact, application)) ||
    restartPass > 0
  ) {
    await assertCleanGit(
      { cwd: context.agentCwd, yes: context.yes || restartPass > 0 },
      application,
    );
  }
  const content = await runChangeReportTaskWithForceOverride(
    context,
    runner,
    task,
    restartPass > 0,
    application,
  );
  if (restartPass > 0) {
    await writeArtifact(
      context,
      implementationRestartLogRef(restartPass),
      `# Implementation Restart Log Pass ${restartPass}\n\n## Summary\nRestart implementation completed after baseline reset. See implementation-log.json for the authoritative report and implementation-log.md for its human-readable view.\n`,
      application,
    );
  }
  return content;
}

export async function codeRefinementPhase(
  context: WorkflowContext,
  pass?: number,
  runner: AgentRunner = runAgentPromise,
  application?: ApplicationExecution,
): Promise<ChangeReport> {
  if (!application)
    return runApplicationPromise(
      fromLegacyPromise((application) =>
        codeRefinementPhase(context, pass, runner, application),
      ),
      application,
    );
  pass ??= await inferNextRefinementPass(context, application);

  return runChangeReportTask(
    context,
    runner,
    codeRefinementTask(
      pass,
      await codeRefinementSourceForPass(context, pass, application),
    ),
    undefined,
    application,
  );
}

async function codeRefinementSourceForPass(
  context: WorkflowContext,
  pass: number,
  application?: ApplicationExecution,
): Promise<CodeRefinementSource> {
  if (pass === 0) return "initial";
  if (await artifactExists(context, fixLogRef(pass), application)) return "fix";
  if (
    (await artifactExists(
      context,
      implementationRestartLogRef(pass),
      application,
    )) ||
    (await artifactExists(context, baselineResetLogRef(pass), application))
  )
    return "restart";
  return "fix";
}

export async function reviewPhase(
  context: WorkflowContext,
  pass?: number,
  runner: AgentRunner = runAgentPromise,
  application?: ApplicationExecution,
): Promise<{ reviewA: ReviewResult; reviewB: ReviewResult }> {
  if (!application)
    return runApplicationPromise(
      fromLegacyPromise((application) =>
        reviewPhase(context, pass, runner, application),
      ),
      application,
    );
  pass ??= await inferNextReviewPass(context, application);

  const [reviewA, reviewB] = await Promise.allSettled([
    runReviewTask(
      context,
      runner,
      reviewATaskForPass(pass),
      undefined,
      application,
    ),
    runReviewTask(
      context,
      runner,
      reviewBTaskForPass(pass),
      undefined,
      application,
    ),
  ]);
  if (reviewA.status === "rejected") throw reviewA.reason;
  if (reviewB.status === "rejected") throw reviewB.reason;
  return { reviewA: reviewA.value, reviewB: reviewB.value };
}

export async function fixPhase(
  context: WorkflowContext,
  pass?: number,
  runner: AgentRunner = runAgentPromise,
  application?: ApplicationExecution,
): Promise<ChangeReport> {
  if (!application)
    return runApplicationPromise(
      fromLegacyPromise((application) =>
        fixPhase(context, pass, runner, application),
      ),
      application,
    );
  pass ??= await inferNextFixPass(context, application);

  const task = fixTask(pass);
  if (await shouldRegenerateArtifact(context, task.artifact, application)) {
    await assertCleanGit({ cwd: context.agentCwd, yes: true }, application);
  }
  return runChangeReportTask(context, runner, task, undefined, application);
}

export async function resetBaselinePhase(
  context: WorkflowContext,
  pass: number,
  application?: ApplicationExecution,
): Promise<string> {
  if (!application)
    return runApplicationPromise(
      fromLegacyPromise((application) =>
        resetBaselinePhase(context, pass, application),
      ),
      application,
    );

  const artifact = `baseline-reset-${pass}.md`;
  const display = {
    ...deterministicDisplay(
      context,
      `baseline-reset-${pass}`,
      "Reset baseline",
      artifact,
      "edit",
    ),
    pass,
  };
  return runPresentedPhase(
    display,
    async () => {
      const baseline = JSON.parse(
        await readArtifact(context, "preImplementationBaseline", application),
      ) as PreImplementationBaseline;
      await resetWorktreeToPreImplementationBaseline(
        { cwd: context.agentCwd, baseline },
        application,
      );
      const content = `# Baseline Reset Pass ${pass}\n\n## Summary\nReset non-.roark worktree state to pre-implementation baseline ${baseline.head}.\n\n## Preserved Control Plane\n.roark artifacts were preserved.\n`;
      await writeArtifact(
        context,
        baselineResetLogRef(pass),
        content,
        application,
      );
      return content;
    },
    () => ({ outcome: "reset", artifact }),
    undefined,
    application,
  );
}

export async function readinessPhase(
  context: WorkflowContext,
  application?: ApplicationExecution,
): Promise<string> {
  if (!application)
    return runApplicationPromise(
      fromLegacyPromise((application) => readinessPhase(context, application)),
      application,
    );

  const display = deterministicDisplay(
    context,
    "readiness",
    "Readiness",
    "readiness.md",
    "inspect",
  );
  await context.observer?.phaseStarted({
    phase: "readiness",
    label: "Readiness",
    artifact: "readiness",
  });
  return runPresentedPhase(
    display,
    async () => {
      const readiness = await buildReadinessArtifacts(context, application);
      await writeJsonArtifact(
        context,
        "readiness",
        readiness.result,
        application,
      );
      await writeArtifact(
        context,
        "readinessMarkdown",
        readiness.markdown,
        application,
      );
      await context.observer?.phaseCompleted({
        phase: "readiness",
        label: "Readiness",
        artifact: "readiness",
      });
      return readiness.markdown;
    },
    () => ({ outcome: "generated", artifact: "readiness.md" }),
    {
      onError: (error) =>
        context.observer?.phaseFailed({
          phase: "readiness",
          label: "Readiness",
          artifact: "readiness",
          error,
        }),
    },
    application,
  );
}

export type WorkflowRunResult =
  | { status: "triage-stopped"; triageVerdict: string }
  | { status: "planning-stopped" }
  | { status: "review-blocked" }
  | { status: "completed" };

export interface RunFullWorkflowOptions {
  issueSnapshot?: GitHubIssueSnapshot | undefined;
}

export async function runFullWorkflow(
  context: WorkflowContext,
  runner: AgentRunner = runAgentPromise,
  options: RunFullWorkflowOptions = {},
  application?: ApplicationExecution,
): Promise<WorkflowRunResult> {
  if (!application)
    return runApplicationPromise(
      fromLegacyPromise((application) =>
        runFullWorkflow(context, runner, options, application),
      ),
      application,
    );

  context.observer ??= createFileRunObserver(context);
  await context.observer.runStarted({ command: "do" });
  try {
    const result = await runFullWorkflowBody(
      context,
      runner,
      options,
      application,
    );
    await context.observer.runCompleted({ status: result.status });
    return result;
  } catch (error) {
    await context.observer.runFailed(error);
    throw error;
  }
}

async function runFullWorkflowBody(
  context: WorkflowContext,
  runner: AgentRunner,
  options: RunFullWorkflowOptions,
  application?: ApplicationExecution,
): Promise<WorkflowRunResult> {
  const completedActions: WorkflowProgressionAction[] = [];

  for (;;) {
    const progression = await planWorkflowProgression(
      context,
      {
        force: context.force,
        completedActions,
      },
      application,
    );
    const next = progression.actions[0];

    if (!next) {
      if (progression.terminalStatus) return progression.terminalStatus;
      throw new Error(
        "Workflow progression produced no next action and no terminal status.",
      );
    }

    if (next.type === "run") {
      const following = progression.actions[1];
      if (
        next.phase === "review-a" &&
        following?.type === "run" &&
        following.phase === "review-b" &&
        following.pass === next.pass
      ) {
        await reviewPhase(context, next.pass ?? 0, runner, application);
        completedActions.push(next, following);
        continue;
      }
      await runWorkflowPhase(
        context,
        runner,
        next.phase,
        next.pass,
        options,
        application,
      );
      completedActions.push(next);
      continue;
    }

    if (next.type === "write-readiness") {
      await readinessPhase(context, application);
      completedActions.push(next);
      if (progression.terminalStatus) return progression.terminalStatus;
      continue;
    }

    if (next.type === "noop") {
      if (progression.terminalStatus) return progression.terminalStatus;
      throw new Error(
        `Workflow progression returned a no-op without a terminal status: ${next.reason}`,
      );
    }

    throw new Error(
      `Workflow progression returned unsupported fresh-run action '${next.type}'.`,
    );
  }
}

async function runWorkflowPhase(
  context: WorkflowContext,
  runner: AgentRunner,
  phase: WorkflowRunPhase,
  pass?: number,
  options: RunFullWorkflowOptions = {},
  application?: ApplicationExecution,
): Promise<void> {
  switch (phase) {
    case "fetch":
      await fetchIssuePhase(context, options.issueSnapshot, application);
      return;
    case "triage":
      await triagePhase(context, runner, application);
      return;
    case "plan-draft":
      await planDraftPhase(context, runner, application);
      return;
    case "plan":
      await planPhase(context, runner, application);
      return;
    case "capture-baseline":
      await captureBaselinePhase(context, application);
      return;
    case "implement":
      await implementationPhase(context, runner, pass ?? 0, application);
      return;
    case "refine-code":
      await codeRefinementPhase(context, pass, runner, application);
      return;
    case "review-a":
      await runReviewTask(
        context,
        runner,
        reviewATaskForPass(pass ?? 0),
        undefined,
        application,
      );
      return;
    case "review-b":
      await runReviewTask(
        context,
        runner,
        reviewBTaskForPass(pass ?? 0),
        undefined,
        application,
      );
      return;
    case "fix":
      await fixPhase(context, pass, runner, application);
      return;
    case "reset-baseline":
      await resetBaselinePhase(context, pass ?? 1, application);
      return;
    default:
      return assertNever(phase);
  }
}

function assertSnapshotMatchesContext(
  context: WorkflowContext,
  snapshot: GitHubIssueSnapshot,
): void {
  if (
    snapshot.issueNumber !== context.issueNumber ||
    String(snapshot.issue.number) !== context.issueNumber
  ) {
    throw new Error(
      `Supplied GitHub issue snapshot is for #${snapshot.issueNumber}, but workflow expects #${context.issueNumber}.`,
    );
  }
}

function assertNever(value: never): never {
  throw new Error(`Unsupported workflow phase '${String(value)}'.`);
}

async function inferNextReviewPass(
  context: WorkflowContext,
  application?: ApplicationExecution,
): Promise<number> {
  return ((await latestCompleteReviewCycle(context, application)) ?? -1) + 1;
}

async function runChangeReportTaskWithForceOverride(
  context: WorkflowContext,
  runner: AgentRunner,
  task: Parameters<typeof runChangeReportTask>[2],
  force: boolean,
  application?: ApplicationExecution,
): Promise<ChangeReport> {
  if (!force)
    return runChangeReportTask(context, runner, task, undefined, application);
  const previous = context.force;
  context.force = true;
  try {
    return await runChangeReportTask(
      context,
      runner,
      task,
      undefined,
      application,
    );
  } finally {
    context.force = previous;
  }
}

async function shouldRegenerateArtifact(
  context: WorkflowContext,
  artifact: ArtifactRef,
  application?: ApplicationExecution,
): Promise<boolean> {
  if (context.force || !(await artifactExists(context, artifact, application)))
    return true;
  const existing = await readArtifact(context, artifact, application);
  return !validateAgentArtifact(artifact, existing).ok;
}

function assertAttemptSelectedWhenAttemptsExist(
  context: WorkflowContext,
  command: "curate-issues" | "create-issues",
): void {
  if (context.attempt !== undefined) return;
  const attemptsDir = path.join(
    context.outDir,
    "issue",
    context.issueNumber,
    "attempts",
  );
  if (!existsSync(attemptsDir)) return;
  const attempts = readdirSync(attemptsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
    .map((entry) => Number(entry.name))
    .sort((left, right) => left - right);
  if (attempts.length === 0) return;
  const latest = attempts[attempts.length - 1];
  if (latest === undefined) return;
  throw new Error(
    `Issue #${context.issueNumber} has attempt artifacts under ${path.relative(context.controlCwd, attemptsDir)}. Run '${command} ${context.issueInput} --attempt ${latest}' (or choose another attempt) so reviewer findings are curated from the intended attempt.`,
  );
}

export async function runSinglePhase(
  context: WorkflowContext,
  phase: SinglePhaseCommand,
  runner: AgentRunner = runAgentPromise,
  application?: ApplicationExecution,
): Promise<void> {
  if (!application)
    return runApplicationPromise(
      fromLegacyPromise((application) =>
        runSinglePhase(context, phase, runner, application),
      ),
      application,
    );

  context.observer ??= createFileRunObserver(context);
  await context.observer.runStarted({ command: phase });
  try {
    if (phase === "review")
      await reviewPhase(
        context,
        context.fixPass ?? (await inferNextReviewPass(context, application)),
        runner,
        application,
      );
    else if (phase === "readiness") await readinessPhase(context, application);
    else if (phase === "curate-issues") {
      assertAttemptSelectedWhenAttemptsExist(context, "curate-issues");
      await issueCurationPhase(context, undefined, undefined, application);
    } else if (phase === "create-issues") {
      assertAttemptSelectedWhenAttemptsExist(context, "create-issues");
      await createIssuesPhase(context, runner, application);
    } else
      await runWorkflowPhase(
        context,
        runner,
        phase,
        await standalonePhasePass(context, phase, application),
        undefined,
        application,
      );
    await context.observer.runCompleted({ status: "completed" });
  } catch (error) {
    await context.observer.runFailed(error);
    throw error;
  }
}

async function standalonePhasePass(
  context: WorkflowContext,
  phase: StandaloneWorkflowPhase,
  application?: ApplicationExecution,
): Promise<number | undefined> {
  if (phase === "refine-code")
    return (
      context.fixPass ?? (await inferNextRefinementPass(context, application))
    );
  if (phase === "fix")
    return context.fixPass ?? (await inferNextFixPass(context, application));
  if (phase === "reset-baseline") return context.fixPass ?? 1;
  return undefined;
}

function deterministicDisplay(
  context: WorkflowContext,
  phaseId: string,
  phaseLabel: string,
  expectedArtifact: string,
  operation: AgentOperation,
): AgentDisplayContext {
  return {
    command: context.displayCommand ?? "issue-workflow",
    repository: context.repo,
    target: `#${context.issueNumber}`,
    phaseId,
    phaseLabel,
    expectedArtifact,
    operation,
  };
}
