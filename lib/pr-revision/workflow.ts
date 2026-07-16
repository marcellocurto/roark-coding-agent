import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { runProcess, runProcessOrThrow } from "../cli/process.ts";
import type { RevisePrCliOptions } from "../cli/args.ts";
import type { WorkflowThinkingStage } from "../workflow/thinking.ts";
import { effectiveModelForStage } from "../workflow/model-routing.ts";
import { artifactOutcome } from "../workflow/markdown-token.ts";
import { buildCommitArgv } from "../autorun/publish.ts";
import {
  classifyVerificationFailure,
  formatCompleteVerificationArtifact,
  formatVerificationArtifact,
  runVerification,
  verificationFailureReason,
  type VerificationResult,
  type VerificationRunner,
} from "../autorun/verification.ts";
import { fetchPullRequestFeedback, type PullRequestFeedback } from "../github/pr.ts";
import { runPiAgent } from "../pi/agent.ts";
import { sharedSystemPrompt } from "../prompts/workflow-prompts.ts";
import { noopAsync } from "../utils/async.ts";
import type { AgentRunner } from "../workflow/agent-runner.ts";
import { presenter, type AgentDisplayContext } from "../presentation/presenter.ts";
import { runPresentedPhase } from "../presentation/phase.ts";
import { assertCleanGitTree, gitDirtyLines } from "../workflow/git.ts";
import {
  createPrRevisionContext,
  formatPrFeedbackMarkdown,
  inferIssueFromPrBody,
  prRevisionArtifactRelativePath,
  removeAgentPrRevisionArtifacts,
  type PrRevisionContext,
  writePrRevisionArtifact,
  writePrRevisionJsonArtifact,
} from "./artifacts.ts";
import {
  defaultLifecycleHooks,
  defaultWorkspaceConfig,
  preparePrRevisionWorkspace,
  runLifecycleHook,
  type PreparedPrRevisionWorkspace,
} from "../autorun/workspace.ts";
import { validatePrBranchSafety } from "./branch.ts";
import type { checkoutPrHeadBranch } from "./branch.ts";
import { postPrRevisionSummaryComment } from "./comments.ts";
import { revisionImplementationPrompt, revisionPlanPrompt, revisionReviewPrompt } from "./prompts.ts";
import { isUnblockedCurrentFix, reviewDisposition, type ReviewResult } from "../review/result.ts";
import { reviewArtifactDefinition } from "../review/artifact.ts";
import {
  revisionPlanArtifactDefinition,
  type RevisionPlanResult,
  type RevisionPlanStatus,
} from "./plan.ts";
import {
  revisionFeedbackDispositions,
  revisionExecutionArtifactDefinition,
  type RevisionExecutionResult,
} from "./execution.ts";
import { runStructuredArtifact } from "../structured-output/runner.ts";

export type PrRevisionOutcome =
  | "no-action-needed"
  | "needs-human"
  | "review-blocked"
  | "verification-failed"
  | "no-code-changes"
  | "published";

export interface PrRevisionResult {
  outcome: PrRevisionOutcome;
  context: PrRevisionContext;
  planStatus?: RevisionPlanStatus | undefined;
  reviewVerdict?: RevisionReviewVerdict | undefined;
  verification?: VerificationResult | undefined;
}

type RevisionReviewVerdict = "approve" | "fixes-required" | "blocked";

export interface RunPrRevisionDependencies {
  fetchFeedback?: typeof fetchPullRequestFeedback | undefined;
  checkout?: typeof checkoutPrHeadBranch | undefined;
  prepareWorkspace?: typeof preparePrRevisionWorkspace | undefined;
  runLifecycleHook?: typeof runLifecycleHook | undefined;
  agentRunner?: AgentRunner | undefined;
  verificationRunner?: VerificationRunner | undefined;
  postSummaryComment?: typeof postPrRevisionSummaryComment | undefined;
}

export async function runPrRevision(
  options: RevisePrCliOptions,
  deps: RunPrRevisionDependencies = {},
): Promise<PrRevisionResult> {
  const controlCwd = options.cwd;
  await assertCleanGitTree({ cwd: controlCwd, yes: options.yes });

  const fetchFeedback = deps.fetchFeedback ?? fetchPullRequestFeedback;
  const feedback = await fetchFeedback({ cwd: controlCwd, repo: options.repo, prNumber: options.prNumber });
  if (feedback.reviewThreadsTruncated === true) {
    throw new Error(`PR #${options.prNumber} has more review threads than Roark can fetch safely in one request. Refusing a partial revision plan.`);
  }
  const repo = feedback.repo;
  validatePrBranchSafety(feedback.pr, repo);

  presenter().transition("Revision preparation", `PR #${feedback.pr.number}`, { operation: "edit" });
  const preparedWorkspace = await prepareRevisionWorkspace({ options, repo, feedback, deps });
  const hookRunner = deps.runLifecycleHook ?? runLifecycleHook;
  const hooks = options.hooks ?? defaultLifecycleHooks;

  try {
    const context = await createPrRevisionContext({ ...options, repo, controlCwd, agentCwd: preparedWorkspace.path });
    presenter().transition("Revision preparation", `PR #${context.prNumber}`, { revision: context.revision, operation: "edit" });
    presenter().line(`Run directory: ${context.revisionDirRelative}`);
    if (context.agentCwd !== context.controlCwd) presenter().line(`Revision workspace: ${path.basename(context.agentCwd)}`);

    await hookRunner("beforeRun", hooks, context.agentCwd);
    await writeInitialArtifacts(context, feedback);

    const runner = deps.agentRunner ?? runPiAgent;
    const postSummary = deps.postSummaryComment ?? postPrRevisionSummaryComment;

    const plan = await runRevisionPlanPhase(context, runner, revisionFeedbackSources(feedback));
    const planStatus = plan.status;
    await updateMetadata(context, feedback, { outcome: "planned", planStatus });

    if (planStatus === "no-action-needed") {
      await updateMetadata(context, feedback, { outcome: "no-action-needed", planStatus, endedAt: new Date().toISOString() });
      presenter().line(context.comment
        ? "No action needed; not mutating code, committing, or pushing. Posting summary comment."
        : "No action needed; not mutating code, committing, pushing, or commenting.");
      if (context.comment) {
        await postSummary({
          context,
          outcome: "no-action-needed",
          dispositions: revisionFeedbackDispositions(plan),
        });
      }
      await removeAgentPrRevisionArtifacts(context);
      return { outcome: "no-action-needed", context, planStatus };
    }

    if (planStatus === "needs-human") {
      await updateMetadata(context, feedback, { outcome: "needs-human", planStatus, endedAt: new Date().toISOString() });
      await removeAgentPrRevisionArtifacts(context);
      await postSummary({
        context,
        outcome: "needs-human",
        dispositions: revisionFeedbackDispositions(plan),
      });
      return { outcome: "needs-human", context, planStatus };
    }

    let execution = await runRevisionExecutionPhase(context, runner, {
      plan,
      phaseId: "revision-implementation",
      label: "Revision implementation",
      artifact: "revision-log.json",
      title: "Revision Log",
      thinkingStage: "revisionImplementation",
      prompt: revisionImplementationPrompt(context, 0),
    });

    let review = await runRevisionReviewAgent(context, runner, {
      phaseId: "revision-review",
      label: "Revision review",
      artifact: "revision-review.json",
      prompt: revisionReviewPrompt(context, 0),
    });
    let reviewVerdict = revisionReviewVerdict(review);
    let fixPassesUsed = 0;
    let verification: VerificationResult | undefined;

    for (;;) {
      if (reviewVerdict === "fixes-required") {
        if (fixPassesUsed >= context.maxFixPasses) {
          await updateMetadata(context, feedback, { outcome: "review-blocked", planStatus, reviewVerdict, fixPassesUsed, endedAt: new Date().toISOString() });
          await removeAgentPrRevisionArtifacts(context);
          await postSummary({
            context,
            outcome: "review-blocked",
            reviewVerdict,
            dispositions: revisionFeedbackDispositions(plan, execution),
          });
          return { outcome: "review-blocked", context, planStatus, reviewVerdict };
        }

        const pass = ++fixPassesUsed;
        const logArtifact = `revision-log-fix-pass-${pass}.json`;
        execution = await runRevisionExecutionPhase(context, runner, {
          plan,
          phaseId: `revision-fix-${pass}`,
          pass,
          label: `Revision fix pass ${pass}`,
          artifact: logArtifact,
          title: `Revision Log Fix Pass ${pass}`,
          thinkingStage: "revisionFix",
          prompt: revisionImplementationPrompt(context, pass),
        });

        const reviewArtifact = `revision-review-pass-${pass}.json`;
        review = await runRevisionReviewAgent(context, runner, {
          phaseId: `revision-review-${pass}`,
          pass,
          label: `Revision review pass ${pass}`,
          artifact: reviewArtifact,
          prompt: revisionReviewPrompt(context, pass),
        });
        reviewVerdict = revisionReviewVerdict(review);
        continue;
      }

      if (reviewVerdict === "blocked") {
        await updateMetadata(context, feedback, { outcome: "review-blocked", planStatus, reviewVerdict, fixPassesUsed, endedAt: new Date().toISOString() });
        await removeAgentPrRevisionArtifacts(context);
        await postSummary({
          context,
          outcome: "review-blocked",
          reviewVerdict,
          dispositions: revisionFeedbackDispositions(plan, execution),
        });
        return { outcome: "review-blocked", context, planStatus, reviewVerdict };
      }

      await hookRunner("beforeVerify", hooks, context.agentCwd);
      verification = await runVerification({
        command: context.verifyCommand,
        cwd: context.agentCwd,
        runner: deps.verificationRunner,
        display: {
          target: `PR #${context.prNumber}`,
          repository: context.repo,
          revision: context.revision,
          ...(fixPassesUsed > 0 ? { pass: fixPassesUsed } : {}),
        },
      });
      await writePrRevisionArtifact(context, "verification.md", formatVerificationArtifact(verification));
      await writePrRevisionArtifact(context, "verification-full.md", formatCompleteVerificationArtifact(verification));
      presenter().artifact(prRevisionArtifactRelativePath(context, "verification.md"));

      if (verification.ok) break;

      const classification = classifyVerificationFailure(verification);
      const failedReason = classification.repairable
        ? `Verification failed after ${context.maxFixPasses} fix passes: ${verificationFailureReason(verification)}`
        : verificationFailureReason(verification);

      if (!classification.repairable || fixPassesUsed >= context.maxFixPasses) {
        presenter().line(`ACTION user action required: ${classification.recoveryGuidance ?? failedReason}`);
        await updateMetadata(context, feedback, {
          outcome: "verification-failed",
          planStatus,
          reviewVerdict,
          verification,
          verificationFailureReason: failedReason,
          fixPassesUsed,
          endedAt: new Date().toISOString(),
        });
        await removeAgentPrRevisionArtifacts(context);
        await postSummary({
          context,
          outcome: "verification-failed",
          reviewVerdict,
          verification,
          dispositions: revisionFeedbackDispositions(plan, execution),
        });
        return { outcome: "verification-failed", context, planStatus, reviewVerdict, verification };
      }

      const pass = ++fixPassesUsed;
      presenter().line(`Verification repair will run as fix pass ${pass}`);
      const verificationBeforeFixArtifact = `verification-before-fix-${pass}.md`;
      await writePrRevisionArtifact(context, verificationBeforeFixArtifact, formatVerificationArtifact(verification));
      await writePrRevisionArtifact(context, `verification-before-fix-${pass}-full.md`, formatCompleteVerificationArtifact(verification));
      presenter().artifact(prRevisionArtifactRelativePath(context, verificationBeforeFixArtifact));

      const logArtifact = `revision-log-fix-pass-${pass}.json`;
      execution = await runRevisionExecutionPhase(context, runner, {
        plan,
        phaseId: `revision-fix-${pass}`,
        pass,
        label: `Revision fix pass ${pass}`,
        artifact: logArtifact,
        title: `Revision Log Fix Pass ${pass}`,
        thinkingStage: "revisionFix",
        prompt: revisionImplementationPrompt(context, pass),
      });

      const reviewArtifact = `revision-review-pass-${pass}.json`;
      review = await runRevisionReviewAgent(context, runner, {
        phaseId: `revision-review-${pass}`,
        pass,
        label: `Revision review pass ${pass}`,
        artifact: reviewArtifact,
        prompt: revisionReviewPrompt(context, pass),
      });
      reviewVerdict = revisionReviewVerdict(review);
    }

    if ((await dirtyLinesOutsideRoark(context.agentCwd)).length === 0) {
      await updateMetadata(context, feedback, { outcome: "no-code-changes", planStatus, reviewVerdict, verification, endedAt: new Date().toISOString() });
      await removeAgentPrRevisionArtifacts(context);
      await postSummary({
        context,
        outcome: "no-code-changes",
        reviewVerdict,
        verification,
        dispositions: revisionFeedbackDispositions(plan, execution),
      });
      return { outcome: "no-code-changes", context, planStatus, reviewVerdict, verification };
    }

    const changedFiles = await changedFilesOutsideRoark(context.agentCwd);
    await updateMetadata(context, feedback, { outcome: "published", planStatus, reviewVerdict, verification, endedAt: new Date().toISOString() });
    const publishDisplay: AgentDisplayContext = {
      command: "revise-pr",
      repository: context.repo,
      target: `PR #${context.prNumber}`,
      phaseId: "pr-revision-publish",
      phaseLabel: "Commit and push revision",
      revision: context.revision,
      operation: "publish",
    };
    const commitSha = await runPresentedPhase(
      publishDisplay,
      () => commitAndPushRevision(context, feedback.pr.headRefName),
      (sha) => ({ outcome: sha ? `pushed ${sha.slice(0, 12)}` : "pushed" }),
    );
    await postSummary({
      context,
      outcome: "published",
      reviewVerdict,
      verification,
      dispositions: revisionFeedbackDispositions(plan, execution),
      changedFiles,
      commitSha,
    });

    return { outcome: "published", context, planStatus, reviewVerdict, verification };
  } finally {
    try {
      await hookRunner("afterRun", hooks, preparedWorkspace.path);
    } finally {
      await preparedWorkspace.releaseLock();
    }
  }
}

async function prepareRevisionWorkspace(input: {
  options: RevisePrCliOptions;
  repo: string;
  feedback: PullRequestFeedback;
  deps: RunPrRevisionDependencies;
}): Promise<PreparedPrRevisionWorkspace> {
  const { options, repo, feedback, deps } = input;
  if (deps.prepareWorkspace) {
    return deps.prepareWorkspace({
      controlCwd: options.cwd,
      repo,
      prNumber: options.prNumber,
      headRefName: feedback.pr.headRefName,
      workspace: options.workspace ?? defaultWorkspaceConfig,
      hooks: options.hooks ?? defaultLifecycleHooks,
    });
  }

  if (deps.checkout) {
    await deps.checkout({ cwd: options.cwd, repo, pr: feedback.pr });
    return {
      path: options.cwd,
      metadata: { path: options.cwd, strategy: "clone", cloneRemote: options.remote, createdNow: false },
      releaseLock: noopAsync,
    };
  }

  return preparePrRevisionWorkspace({
    controlCwd: options.cwd,
    repo,
    prNumber: options.prNumber,
    headRefName: feedback.pr.headRefName,
    workspace: options.workspace ?? defaultWorkspaceConfig,
    hooks: options.hooks ?? defaultLifecycleHooks,
  });
}

async function runRevisionExecutionPhase(
  context: PrRevisionContext,
  runner: AgentRunner,
  input: {
    phaseId: string;
    plan: RevisionPlanResult;
    label: string;
    artifact: string;
    title: string;
    thinkingStage: WorkflowThinkingStage;
    prompt: string;
    pass?: number | undefined;
  },
): Promise<RevisionExecutionResult> {
  const display = revisionDisplay(context, input, "edit");
  const artifact = await runPresentedPhase(display, () => runStructuredArtifact({
      cwd: context.agentCwd,
      model: effectiveModelForStage(context.model, input.thinkingStage),
      thinkingLevel: context.thinkingConfig[input.thinkingStage],
      systemPrompt: sharedSystemPrompt,
      prompt: input.prompt,
      fileEditingToolsEnabled: true,
      display,
    }, runner, revisionExecutionArtifactDefinition(input.title, input.plan), {
      writeJson: (content) => writePrRevisionArtifact(context, input.artifact, content),
      writeMarkdown: (content) => writePrRevisionArtifact(context, input.artifact.replace(/\.json$/, ".md"), content),
    }), (result) => ({ outcome: artifactOutcome(result.markdown), artifact: display.expectedArtifact }));
  return artifact.value;
}

async function runRevisionPlanPhase(
  context: PrRevisionContext,
  runner: AgentRunner,
  feedbackSources: readonly RevisionFeedbackSource[],
): Promise<RevisionPlanResult> {
  const input = { phaseId: "revision-plan", label: "Revision plan", artifact: "revision-plan.json" };
  const display = revisionDisplay(context, input, "inspect");
  const artifact = await runPresentedPhase(display, () => runStructuredArtifact({
      cwd: context.agentCwd,
      model: effectiveModelForStage(context.model, "revisionPlan"),
      thinkingLevel: context.thinkingConfig.revisionPlan,
      systemPrompt: sharedSystemPrompt,
      prompt: revisionPlanPrompt(context),
      fileEditingToolsEnabled: false,
      display,
    }, runner, revisionPlanArtifactDefinition(new Set(feedbackSources.map((source) => source.id))), {
      writeJson: (content) => writePrRevisionArtifact(context, "revision-plan.json", content),
      writeMarkdown: (content) => writePrRevisionArtifact(context, "revision-plan.md", content),
    }), (result) => ({ outcome: artifactOutcome(result.markdown), artifact: display.expectedArtifact }));
  return artifact.value;
}

async function runRevisionReviewAgent(
  context: PrRevisionContext,
  runner: AgentRunner,
  input: { phaseId: string; label: string; artifact: string; prompt: string; pass?: number | undefined },
): Promise<ReviewResult> {
  const display = revisionDisplay(context, input, "review");
  const artifact = await runPresentedPhase(display, () => runStructuredArtifact({
      cwd: context.agentCwd,
      model: effectiveModelForStage(context.model, "revisionReview"),
      thinkingLevel: context.thinkingConfig.revisionReview,
      systemPrompt: sharedSystemPrompt,
      prompt: input.prompt,
      fileEditingToolsEnabled: false,
      display,
    }, runner, reviewArtifactDefinition({
      allowRestart: false,
      title: input.label,
      source: "revision-review",
    }), {
      writeJson: (content) => writePrRevisionArtifact(context, input.artifact, content),
      writeMarkdown: (content) => writePrRevisionArtifact(context, input.artifact.replace(/\.json$/, ".md"), content),
    }), (result) => ({ outcome: artifactOutcome(result.markdown), artifact: display.expectedArtifact }));
  return artifact.value;
}

function revisionDisplay(
  context: PrRevisionContext,
  input: { phaseId: string; label: string; artifact: string; pass?: number | undefined },
  operation: AgentDisplayContext["operation"],
): AgentDisplayContext {
  return {
    command: "revise-pr",
    repository: context.repo,
    target: `PR #${context.prNumber}`,
    phaseId: `pr-revision-${input.phaseId}`,
    phaseLabel: input.label,
    revision: context.revision,
    ...(input.pass === undefined ? {} : { pass: input.pass }),
    expectedArtifact: prRevisionArtifactRelativePath(context, input.artifact.replace(/\.json$/, ".md")),
    operation,
  };
}

async function writeInitialArtifacts(context: PrRevisionContext, feedback: PullRequestFeedback): Promise<void> {
  await writePrRevisionJsonArtifact(context, "pr-feedback.json", plannerFacingFeedback(feedback));
  await writePrRevisionArtifact(context, "pr-feedback.md", formatPrFeedbackMarkdown(feedback));
  await updateMetadata(context, feedback, { outcome: "started" });
}

interface RevisionFeedbackSource {
  id: string;
  kind: "pr-description" | "review-thread" | "pr-comment" | "closing-issue" | "closing-issue-comment";
  url?: string | undefined;
}

function plannerFacingFeedback(feedback: PullRequestFeedback): PullRequestFeedback & { feedbackSources: RevisionFeedbackSource[] } {
  return {
    ...feedback,
    comments: feedback.plannerComments,
    feedbackSources: revisionFeedbackSources(feedback),
  };
}

function revisionFeedbackSources(feedback: PullRequestFeedback): RevisionFeedbackSource[] {
  return [
    { id: `pr:${feedback.pr.number}`, kind: "pr-description" as const, url: feedback.pr.url },
    ...feedback.reviewThreads.map((thread, index) => ({
      id: `thread:${thread.id || index + 1}`,
      kind: "review-thread" as const,
      url: thread.comments.find((comment) => comment.url)?.url,
    })),
    ...feedback.plannerComments.map((comment, index) => ({
      id: `comment:${comment.databaseId ?? comment.id ?? index + 1}`,
      kind: "pr-comment" as const,
      url: comment.url,
    })),
    ...(feedback.closingIssues ?? []).flatMap((issue) => [
      { id: `issue:${issue.number}`, kind: "closing-issue" as const, url: issue.url },
      ...(issue.comments ?? []).map((comment, index) => ({
        id: `issue-comment:${issue.number}:${comment.databaseId ?? comment.id ?? index + 1}`,
        kind: "closing-issue-comment" as const,
        url: comment.url,
      })),
    ]),
  ];
}

async function updateMetadata(
  context: PrRevisionContext,
  feedback: PullRequestFeedback,
  update: Record<string, unknown>,
): Promise<void> {
  await writePrRevisionJsonArtifact(context, "metadata.json", {
    prNumber: context.prNumber,
    revision: context.revision,
    repo: feedback.repo,
    startedAt: feedback.fetchedAt,
    inferredIssue: await inferIssueForRevision(context, feedback),
    pr: feedback.pr,
    excludedRoarkSummaryCommentIds: feedback.excludedRoarkSummaryCommentIds,
    ...update,
  });
}

async function inferIssueForRevision(context: PrRevisionContext, feedback: PullRequestFeedback): Promise<number | undefined> {
  return inferIssueFromPrBody(feedback.pr.body) ?? await inferIssueFromAttemptMetadata(context, feedback.pr.headRefName);
}

async function inferIssueFromAttemptMetadata(context: PrRevisionContext, headRefName: string): Promise<number | undefined> {
  const issueRoot = path.join(context.outDir, "issue");
  let issueDirs: string[];
  try {
    issueDirs = await readdir(issueRoot);
  } catch {
    return undefined;
  }

  for (const issueDir of issueDirs) {
    const attemptsDir = path.join(issueRoot, issueDir, "attempts");
    let attempts: string[];
    try {
      attempts = await readdir(attemptsDir);
    } catch {
      continue;
    }
    for (const attempt of attempts) {
      try {
        const raw = await readFile(path.join(attemptsDir, attempt, "attempt.json"), "utf8");
        const metadata = JSON.parse(raw) as { branch?: unknown; issueNumber?: unknown };
        if (metadata.branch === headRefName && typeof metadata.issueNumber === "number") return metadata.issueNumber;
      } catch {
        // Ignore malformed or missing historical metadata; this inference is best-effort.
      }
    }
  }

  return undefined;
}

function revisionReviewVerdict(review: ReviewResult): RevisionReviewVerdict {
  if (review.restartRecommendation !== undefined) {
    throw new Error("Revision reviews cannot request an implementation restart.");
  }
  if (review.findings.some(isUnblockedCurrentFix)) return "fixes-required";
  const disposition = reviewDisposition(review);
  if (disposition === "restart-required") throw new Error("Revision reviews cannot request an implementation restart.");
  return disposition;
}

async function dirtyLinesOutsideRoark(cwd: string): Promise<string[]> {
  return (await gitDirtyLines(cwd)).filter((line) => !statusLinePaths(line).every(isRoarkPath));
}

function statusLinePaths(line: string): string[] {
  const pathPart = line.slice(3).trim();
  if (!pathPart) return [];
  return pathPart.split(" -> ").map((filePath) => filePath.replace(/^"|"$/g, ""));
}

function isRoarkPath(filePath: string): boolean {
  return filePath === ".roark" || filePath.startsWith(".roark/");
}

async function commitAndPushRevision(context: PrRevisionContext, branchName: string): Promise<string | undefined> {
  await ensurePushRemote(context);
  await runProcessOrThrow(["git", "add", "-A", "--", ".", ":(exclude).roark"], { cwd: context.agentCwd, label: "git add revision changes" });
  await runProcessOrThrow(buildCommitArgv({ message: `roark: revise PR #${context.prNumber} (revision ${context.revision})` }), {
    cwd: context.agentCwd,
    label: "git commit",
  });
  await runProcessOrThrow(["git", "push", context.remote, `HEAD:${branchName}`], { cwd: context.agentCwd, label: `git push ${context.remote}` });
  try {
    return (await runProcessOrThrow(["git", "rev-parse", "--short", "HEAD"], { cwd: context.agentCwd, label: "git rev-parse HEAD" })).trim();
  } catch {
    return undefined;
  }
}

async function changedFilesOutsideRoark(cwd: string): Promise<string[]> {
  const paths = (await gitDirtyLines(cwd))
    .flatMap(statusLinePaths)
    .filter((filePath) => !isRoarkPath(filePath));
  return [...new Set(paths)];
}

async function ensurePushRemote(context: PrRevisionContext): Promise<void> {
  const agentRemote = await runProcess(["git", "remote", "get-url", context.remote], { cwd: context.agentCwd });
  if (path.resolve(context.agentCwd) === path.resolve(context.controlCwd)) {
    if (agentRemote.exitCode === 0 && agentRemote.stdout.trim()) return;
    throw new Error(`Git remote '${context.remote}' is not configured in '${context.agentCwd}'.`);
  }

  const fetchUrl = (await runProcessOrThrow(["git", "remote", "get-url", context.remote], {
    cwd: context.controlCwd,
    label: `git remote get-url ${context.remote}`,
  })).trim();
  const pushUrl = (await runProcessOrThrow(["git", "remote", "get-url", "--push", context.remote], {
    cwd: context.controlCwd,
    label: `git remote get-url --push ${context.remote}`,
  })).trim();

  if (agentRemote.exitCode !== 0 || !agentRemote.stdout.trim()) {
    await runProcessOrThrow(["git", "remote", "add", context.remote, fetchUrl], { cwd: context.agentCwd, label: `git remote add ${context.remote}` });
  }

  const agentPushUrl = await runProcess(["git", "remote", "get-url", "--push", context.remote], { cwd: context.agentCwd });
  if (pushUrl && (agentPushUrl.exitCode !== 0 || agentPushUrl.stdout.trim() !== pushUrl)) {
    await runProcessOrThrow(["git", "remote", "set-url", "--push", context.remote, pushUrl], { cwd: context.agentCwd, label: `git remote set-url --push ${context.remote}` });
  }
}
