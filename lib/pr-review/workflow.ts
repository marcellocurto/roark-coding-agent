import path from "node:path";
import type { ReviewPrCliOptions } from "../cli/args.ts";
import {
  classifyVerificationFailure,
  formatCompleteVerificationArtifact,
  formatVerificationArtifact,
  runVerification,
  type VerificationResult,
  type VerificationRunner,
} from "../autorun/verification.ts";
import {
  defaultLifecycleHooks,
  defaultWorkspaceConfig,
  assertPinnedPrReviewWorkspace,
  preparePrReviewWorkspace,
  runLifecycleHook,
  type PreparedPrReviewWorkspace,
} from "../autorun/workspace.ts";
import { sanitizePublicMarkdown } from "../autorun/public-output.ts";
import { fetchPullRequestFeedback, isRoarkGeneratedPrSummaryComment, type PullRequestClosingIssue, type PullRequestFeedback } from "../github/pr.ts";
import { postIssueComment, truncateGitHubIssueComment } from "../github/comments.ts";
import { runPiAgent } from "../pi/agent.ts";
import { sharedSystemPrompt } from "../prompts/workflow-prompts.ts";
import { correctnessReviewLens, maintainabilityReviewLens, type ReviewLensDefinition } from "../review/contract.ts";
import type { AgentRunner } from "../workflow/agent-runner.ts";
import { presenter, type AgentDisplayContext } from "../presentation/presenter.ts";
import { runPresentedPhase } from "../presentation/phase.ts";
import { effectiveModelForStage } from "../workflow/model-routing.ts";
import {
  createPrReviewContext,
  removeAgentPrReviewArtifacts,
  type PrReviewContext,
  writePrReviewArtifact,
  writePrReviewInputArtifact,
  writePrReviewInputJson,
  writePrReviewJson,
} from "./artifacts.ts";
import { prReviewPrompt } from "./prompts.ts";

export interface PrReviewResult {
  outcome: "completed" | "blocked";
  context: PrReviewContext;
  verification?: VerificationResult | undefined;
  published: boolean;
  stale: boolean;
}

export interface RunPrReviewDependencies {
  fetchFeedback?: typeof fetchPullRequestFeedback | undefined;
  prepareWorkspace?: typeof preparePrReviewWorkspace | undefined;
  runLifecycleHook?: typeof runLifecycleHook | undefined;
  agentRunner?: AgentRunner | undefined;
  verificationRunner?: VerificationRunner | undefined;
  postComment?: typeof postIssueComment | undefined;
  assertWorkspace?: typeof assertPinnedPrReviewWorkspace | undefined;
}

export async function runPrReview(options: ReviewPrCliOptions, deps: RunPrReviewDependencies = {}): Promise<PrReviewResult> {
  const fetchFeedback = deps.fetchFeedback ?? fetchPullRequestFeedback;
  const initial = await fetchFeedback({ cwd: options.cwd, repo: options.repo, prNumber: options.prNumber });
  validateReviewablePr(initial);
  presenter().transition("Review preparation", `PR #${initial.pr.number}`, { operation: "inspect" });
  const hooks = options.hooks ?? defaultLifecycleHooks;
  const prepareWorkspace = deps.prepareWorkspace ?? preparePrReviewWorkspace;
  const workspace = options.workspace ?? defaultWorkspaceConfig;
  const prepared = await prepareWorkspace({
    controlCwd: options.cwd,
    repo: initial.repo,
    repositoryUrl: initial.pr.baseRepositoryUrl,
    prNumber: options.prNumber,
    baseRefName: initial.pr.baseRefName,
    baseRefOid: initial.pr.baseRefOid,
    headRefOid: initial.pr.headRefOid,
    workspace,
    hooks,
  });
  const hookRunner = deps.runLifecycleHook ?? runLifecycleHook;
  const assertWorkspace = deps.assertWorkspace ?? assertPinnedPrReviewWorkspace;
  let context: PrReviewContext | undefined;

  try {
    context = await createPrReviewContext({ ...options, repo: initial.repo, agentCwd: prepared.path });
    presenter().transition("Review preparation", `PR #${context.prNumber}`, { pass: context.generation, operation: "inspect" });
    presenter().line(`Run directory: ${context.reviewDirRelative}`);
    presenter().line(`Review workspace: ${path.basename(context.agentCwd)}`);
    await hookRunner("beforeRun", hooks, context.agentCwd);
    await assertWorkspace({ cwd: context.agentCwd, headOid: prepared.comparison.headOid });

    const closingIssues = sameRepositoryClosingIssues(initial);
    await writePrReviewInputJson(context, "pr-context.json", { ...initial, closingIssues });
    await writePrReviewInputArtifact(context, "pr-context.md", formatPrContext(initial, closingIssues));
    await writePrReviewInputJson(context, "comparison.json", prepared.comparison);

    let verification: VerificationResult | undefined;
    await hookRunner("beforeVerify", hooks, context.agentCwd);
    try {
      verification = await runVerification({
        command: options.verifyCommand,
        cwd: context.agentCwd,
        runner: deps.verificationRunner,
        display: { target: `PR #${context.prNumber}`, repository: context.repo, pass: context.generation },
      });
      await writePrReviewInputArtifact(context, "verification.md", formatVerificationArtifact(verification));
      await writePrReviewArtifact(context, "verification-full.md", formatCompleteVerificationArtifact(verification));
      presenter().artifact(path.join(context.reviewDirRelative, "verification.md"));
      const classification = classifyVerificationFailure(verification);
      if (!verification.ok) {
        presenter().line(`ACTION user action required for verification: ${classification.recoveryGuidance ?? classification.reason}`);
      }
    } catch (error) {
      const reason = `Verification could not run: ${errorMessage(error)}`;
      await writePrReviewInputArtifact(context, "verification.md", `# Verification\n\n## Status\nUnavailable\n\n## Reason\n${reason}\n`);
    }
    await assertWorkspace({ cwd: context.agentCwd, headOid: prepared.comparison.headOid });

    await writePrReviewJson(context, "metadata.json", metadata(context, initial, prepared, {
      outcome: "reviewing",
      verificationCommand: options.verifyCommand,
    }));

    const runner = deps.agentRunner ?? runPiAgent;
    const [reviewAResult, reviewBResult] = await Promise.allSettled([
      runReviewer(context, prepared, runner, correctnessReviewLens, "reviewA"),
      runReviewer(context, prepared, runner, maintainabilityReviewLens, "reviewB"),
    ]);
    if (reviewAResult.status === "rejected" || reviewBResult.status === "rejected") {
      const failures = [reviewAResult, reviewBResult]
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => errorMessage(result.reason));
      throw new Error(`PR reviewer failed: ${failures.join("; ")}`);
    }
    const reviewA = reviewAResult.value;
    const reviewB = reviewBResult.value;
    await assertWorkspace({ cwd: context.agentCwd, headOid: prepared.comparison.headOid });

    const latest = await fetchFeedback({ cwd: options.cwd, repo: initial.repo, prNumber: options.prNumber });
    const staleReasons = prIdentityChanges(initial, latest);
    if (staleReasons.length > 0) {
      await writePrReviewJson(context, "metadata.json", metadata(context, initial, prepared, {
        outcome: "blocked",
        stale: true,
        staleReason: `PR changed during review (${staleReasons.join("; ")}); review comments were not published.`,
        latestPr: latest.pr,
        endedAt: new Date().toISOString(),
      }));
      return { outcome: "blocked", context, verification, published: false, stale: true };
    }

    await writePrReviewJson(context, "metadata.json", metadata(context, initial, prepared, { outcome: "completed", stale: false, endedAt: new Date().toISOString() }));
    let published = false;
    if (context.comment) {
      const publishDisplay: AgentDisplayContext = {
        command: "review-pr",
        repository: context.repo,
        target: `PR #${context.prNumber}`,
        phaseId: "pr-review-publication",
        phaseLabel: "Publish PR review",
        pass: context.generation,
        operation: "publish",
      };
      presenter().phaseStarted(publishDisplay);
      try {
        const postComment = deps.postComment ?? postIssueComment;
        await postComment({
          cwd: context.controlCwd,
          repo: context.repo,
          issueNumber: context.prNumber,
          body: publicReviewComment(context, "a", reviewA),
        });
        await postComment({
          cwd: context.controlCwd,
          repo: context.repo,
          issueNumber: context.prNumber,
          body: publicReviewComment(context, "b", reviewB),
        });
        published = true;
        presenter().phaseCompleted(publishDisplay, { outcome: "published 2 reviewer comments" });
      } catch (error) {
        await writePrReviewJson(context, "metadata.json", metadata(context, initial, prepared, {
          outcome: "completed",
          publication: "failed",
          publicationError: errorMessage(error),
          endedAt: new Date().toISOString(),
        }));
        const publicationError = new Error(`PR review completed, but reviewer comment publishing failed: ${errorMessage(error)}`);
        presenter().phaseCompleted(publishDisplay, { outcome: publicationError.message, failed: true });
        throw publicationError;
      }
    }
    return { outcome: "completed", context, verification, published, stale: false };
  } finally {
    try {
      if (context) await removeAgentPrReviewArtifacts(context);
      await hookRunner("afterRun", hooks, prepared.path);
    } finally {
      await prepared.releaseLock();
    }
  }
}

function validateReviewablePr(feedback: PullRequestFeedback): void {
  if (feedback.pr.state !== "OPEN") throw new Error(`PR #${feedback.pr.number} must be open. Current state: ${feedback.pr.state}.`);
  if (!feedback.pr.baseRefOid || !feedback.pr.headRefOid) throw new Error(`PR #${feedback.pr.number} metadata did not include immutable base and head commit identifiers.`);
}

function prIdentityChanges(initial: PullRequestFeedback, latest: PullRequestFeedback): string[] {
  const changes: string[] = [];
  if (latest.pr.state !== "OPEN") changes.push(`state is ${latest.pr.state}`);
  for (const [label, before, after] of [
    ["title", initial.pr.title, latest.pr.title],
    ["description", initial.pr.body, latest.pr.body],
    ["base repository", initial.pr.baseRepository, latest.pr.baseRepository],
    ["base ref", initial.pr.baseRefName, latest.pr.baseRefName],
    ["base commit", initial.pr.baseRefOid, latest.pr.baseRefOid],
    ["head repository", initial.pr.headRepository, latest.pr.headRepository],
    ["head commit", initial.pr.headRefOid, latest.pr.headRefOid],
  ] as const) {
    if (before !== after) changes.push(`${label} changed from ${before ?? "(unknown)"} to ${after ?? "(unknown)"}`);
  }
  return changes;
}

async function runReviewer(
  context: PrReviewContext,
  prepared: PreparedPrReviewWorkspace,
  runner: AgentRunner,
  lens: ReviewLensDefinition,
  stage: "reviewA" | "reviewB",
): Promise<string> {
  const artifactName = stage === "reviewA" ? "review-a" : "review-b";
  const display: AgentDisplayContext = {
    command: "review-pr",
    repository: context.repo,
    target: `PR #${context.prNumber}`,
    phaseId: `pr-review-${lens.reviewerLabel.toLowerCase()}`,
    phaseLabel: `PR review ${lens.reviewerLabel}`,
    pass: context.generation,
    expectedArtifact: `${context.reviewDirRelative}/${artifactName}.md`,
    operation: "review",
  };
  return runPresentedPhase(display, async () => {
    const markdown = (await runner({
      cwd: context.agentCwd,
      model: effectiveModelForStage(context.model, stage),
      thinkingLevel: context.thinkingConfig[stage],
      systemPrompt: sharedSystemPrompt,
      prompt: prReviewPrompt({ context, comparison: prepared.comparison, lens }),
      fileEditingToolsEnabled: false,
      display,
    })).trim();
    if (!markdown) throw new Error(`${lens.role} returned an empty PR review comment.`);
    await writePrReviewArtifact(context, `${artifactName}.md`, markdown);
    return markdown;
  }, () => ({ outcome: "completed", artifact: display.expectedArtifact }), { manageTitle: false });
}

function publicReviewComment(context: PrReviewContext, reviewer: "a" | "b", markdown: string): string {
  const marker = `<!-- roark:pr=${context.prNumber} phase=pr-review reviewer=${reviewer} -->`;
  const body = sanitizePublicMarkdown(markdown, {
    localRoots: [context.controlCwd, context.agentCwd, context.outDir, context.reviewDir],
  });
  return truncateGitHubIssueComment(`${marker}\n${body.trim()}\n`);
}

export function sameRepositoryClosingIssues(feedback: PullRequestFeedback): PullRequestClosingIssue[] {
  return (feedback.closingIssues ?? []).filter((issue) => issue.repository?.toLowerCase() === feedback.repo.toLowerCase());
}

function formatPrContext(feedback: PullRequestFeedback, closingIssues: PullRequestClosingIssue[]): string {
  const lines = [
    `# PR #${feedback.pr.number}: ${feedback.pr.title}`,
    "",
    "## Authoritative Requirements",
    closingIssues.length === 0
      ? "No closing issue in this repository was available. Use the PR title and description below as the best available requirements."
      : `Closing issues in this repository:\n\n\`\`\`json\n${JSON.stringify(closingIssues, null, 2)}\n\`\`\``,
    "",
    "## PR Description",
    feedback.pr.body || "None.",
    "",
    "## Existing PR Comments (secondary context)",
    ...listOrNone(feedback.comments
      .filter((comment) => !isRoarkGeneratedPrSummaryComment(comment.body))
      .map((comment) => `${comment.author ?? "unknown"}: ${comment.body}`)),
    "",
    "## Review Threads (secondary context)",
    ...(feedback.reviewThreadsTruncated === true
      ? ["- Context incomplete: GitHub reported additional review threads beyond this fetch. Treat the listed threads as partial secondary context and review the pinned diff independently."]
      : []),
    ...listOrNone(feedback.reviewThreads.flatMap((thread) => {
      const resolution = thread.isResolved ? "resolved" : "unresolved";
      const freshness = thread.isOutdated === true ? "outdated" : thread.isOutdated === false ? "current" : "freshness unknown";
      return thread.comments.map((comment) => `[${resolution}, ${freshness}] ${thread.path ?? "unknown"}:${thread.line ?? thread.originalLine ?? "?"} ${comment.author ?? "unknown"}: ${comment.body}`);
    })),
  ];
  return `${lines.join("\n")}\n`;
}

function listOrNone(values: string[]): string[] {
  return values.length === 0 ? ["None."] : values.map((value) => `- ${value}`);
}

function metadata(context: PrReviewContext, feedback: PullRequestFeedback, prepared: PreparedPrReviewWorkspace, update: Record<string, unknown>): Record<string, unknown> {
  return {
    prNumber: context.prNumber,
    generation: context.generation,
    repo: context.repo,
    reviewedBaseOid: prepared.comparison.baseOid,
    reviewedHeadOid: prepared.comparison.headOid,
    mergeBaseOid: prepared.comparison.mergeBaseOid,
    pr: feedback.pr,
    startedAt: feedback.fetchedAt,
    ...update,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
