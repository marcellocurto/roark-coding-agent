import { runProcess } from "../cli/process.ts";
import type { ReviewPrCliOptions } from "../cli/args.ts";
import {
  classifyVerificationFailure,
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
import { fetchPullRequestFeedback, type PullRequestFeedback } from "../github/pr.ts";
import { runPiAgent } from "../pi/agent.ts";
import { sharedSystemPrompt } from "../prompts/workflow-prompts.ts";
import { correctnessReviewLens, maintainabilityReviewLens, validateReviewOutput, type ReviewLensDefinition } from "../review/contract.ts";
import type { AgentRunner } from "../workflow/agent-runner.ts";
import { effectiveModelForStage } from "../workflow/model-routing.ts";
import { inferIssueFromPrBody } from "../pr-revision/artifacts.ts";
import {
  createPrReviewContext,
  removeAgentPrReviewArtifacts,
  type PrReviewContext,
  writePrReviewArtifact,
  writePrReviewInputArtifact,
  writePrReviewInputJson,
  writePrReviewJson,
} from "./artifacts.ts";
import { publishPrReviewComment } from "./comments.ts";
import { blockedPrReviewDecision, decidePrReview, type PrReviewDecision, type PrReviewOutcome } from "./outcome.ts";
import { prReviewPrompt } from "./prompts.ts";
import { resolvePrReviewVerification } from "./verification.ts";

export interface PrReviewResult {
  outcome: PrReviewOutcome;
  context: PrReviewContext;
  decision: PrReviewDecision;
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
  publishComment?: typeof publishPrReviewComment | undefined;
  fetchLinkedIssue?: ((input: { cwd: string; repo: string; issueNumber: number }) => Promise<unknown>) | undefined;
  assertWorkspace?: typeof assertPinnedPrReviewWorkspace | undefined;
}

export async function runPrReview(options: ReviewPrCliOptions, deps: RunPrReviewDependencies = {}): Promise<PrReviewResult> {
  const fetchFeedback = deps.fetchFeedback ?? fetchPullRequestFeedback;
  const initial = await fetchFeedback({ cwd: options.cwd, repo: options.repo, prNumber: options.prNumber });
  validateReviewablePr(initial);
  const hooks = options.hooks ?? defaultLifecycleHooks;
  const prepareWorkspace = deps.prepareWorkspace ?? preparePrReviewWorkspace;
  const prepared = await prepareWorkspace({
    controlCwd: options.cwd,
    repo: initial.repo,
    prNumber: options.prNumber,
    baseRefName: initial.pr.baseRefName,
    baseRefOid: initial.pr.baseRefOid,
    headRefOid: initial.pr.headRefOid,
    workspace: options.workspace ?? defaultWorkspaceConfig,
    hooks,
  });
  const hookRunner = deps.runLifecycleHook ?? runLifecycleHook;
  const assertWorkspace = deps.assertWorkspace ?? assertPinnedPrReviewWorkspace;
  let context: PrReviewContext | undefined;

  try {
    context = await createPrReviewContext({ ...options, repo: initial.repo, agentCwd: prepared.path });
    console.log(`Run directory: ${context.reviewDirRelative}`);
    console.log(`Review workspace: ${context.agentCwd}`);
    await hookRunner("beforeRun", hooks, context.agentCwd);
    await assertWorkspace({ cwd: context.agentCwd, headOid: prepared.comparison.headOid });

    const linkedIssueNumber = inferIssueFromPrBody(initial.pr.body);
    const linkedIssue = linkedIssueNumber === undefined
      ? undefined
      : await fetchOptionalLinkedIssue({ cwd: options.cwd, repo: initial.repo, issueNumber: linkedIssueNumber }, deps.fetchLinkedIssue);
    await writePrReviewInputJson(context, "pr-context.json", { ...initial, linkedIssue });
    await writePrReviewInputArtifact(context, "pr-context.md", formatPrContext(initial, linkedIssue));
    await writePrReviewInputJson(context, "comparison.json", prepared.comparison);

    const resolvedVerification = await resolvePrReviewVerification({
      cwd: context.agentCwd,
      command: options.verifyCommand,
      source: options.verificationSource,
    });

    let verification: VerificationResult | undefined;
    let verificationUnavailable: string | undefined;
    let verificationStatus = resolvedVerification.reason ?? "not configured";
    if (resolvedVerification.command) {
      await hookRunner("beforeVerify", hooks, context.agentCwd);
      try {
        verification = await runVerification({ command: resolvedVerification.command, cwd: context.agentCwd, runner: deps.verificationRunner });
        await writePrReviewInputArtifact(context, "verification.md", formatVerificationArtifact(verification));
        const classification = classifyVerificationFailure(verification);
        if (!verification.ok && !classification.repairable) verificationUnavailable = classification.recoveryGuidance ?? classification.reason;
        verificationStatus = `${verification.ok ? "passed" : "failed"} (${resolvedVerification.source}, \`${resolvedVerification.command}\`, exit ${verification.exitCode})`;
      } catch (error) {
        verificationUnavailable = `Verification could not run: ${errorMessage(error)}`;
        verificationStatus = verificationUnavailable;
        await writePrReviewInputArtifact(context, "verification.md", `# Verification\n\n## Status\nUnavailable\n\n## Reason\n${verificationUnavailable}\n`);
      }
      await assertWorkspace({ cwd: context.agentCwd, headOid: prepared.comparison.headOid });
    } else {
      await writePrReviewInputArtifact(context, "verification.md", [
        "# Verification",
        "",
        "## Status",
        "Not configured",
        "",
        "## Reason",
        resolvedVerification.reason ?? "No verification command was configured.",
        ...(resolvedVerification.suggestedCommand ? ["", "## Suggested Explicit Command", `\`${resolvedVerification.suggestedCommand}\``] : []),
        "",
      ].join("\n"));
    }

    await writePrReviewJson(context, "metadata.json", metadata(context, initial, prepared, {
      outcome: "reviewing",
      verificationSource: resolvedVerification.source,
      verificationCommand: resolvedVerification.command,
      suggestedVerificationCommand: resolvedVerification.suggestedCommand,
    }));

    const runner = deps.agentRunner ?? runPiAgent;
    const [reviewAResult, reviewBResult] = await Promise.allSettled([
      runReviewer(context, prepared, runner, correctnessReviewLens, "reviewA"),
      runReviewer(context, prepared, runner, maintainabilityReviewLens, "reviewB"),
    ]);
    if (reviewAResult.status === "fulfilled") await writePrReviewArtifact(context, "review-a.md", reviewAResult.value);
    if (reviewBResult.status === "fulfilled") await writePrReviewArtifact(context, "review-b.md", reviewBResult.value);
    if (reviewAResult.status === "rejected" || reviewBResult.status === "rejected") {
      const failures = [reviewAResult, reviewBResult]
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => errorMessage(result.reason));
      throw new Error(`PR reviewer failed: ${failures.join("; ")}`);
    }
    const reviewA = reviewAResult.value;
    const reviewB = reviewBResult.value;
    await assertWorkspace({ cwd: context.agentCwd, headOid: prepared.comparison.headOid });

    let decision: PrReviewDecision;
    try {
      decision = decidePrReview({
        reviewA: validateReviewOutput(reviewA, "review-a"),
        reviewB: validateReviewOutput(reviewB, "review-b"),
        verification,
        verificationUnavailable,
      });
    } catch (error) {
      decision = blockedPrReviewDecision(`Reviewer output was invalid: ${errorMessage(error)}`);
    }
    await writePrReviewJson(context, "summary.json", { ...decision, verificationStatus });

    const latest = await fetchFeedback({ cwd: options.cwd, repo: initial.repo, prNumber: options.prNumber });
    const staleReasons = prIdentityChanges(initial, latest);
    if (staleReasons.length > 0) {
      decision = blockedPrReviewDecision(`PR changed during review (${staleReasons.join("; ")}); findings were retained but not published as current.`);
      await writePrReviewJson(context, "summary.json", { ...decision, verificationStatus, stale: true });
      await writePrReviewJson(context, "metadata.json", metadata(context, initial, prepared, { outcome: "blocked", stale: true, latestPr: latest.pr, endedAt: new Date().toISOString() }));
      return { outcome: "blocked", context, decision, verification, published: false, stale: true };
    }

    await writePrReviewJson(context, "metadata.json", metadata(context, initial, prepared, { outcome: decision.outcome, stale: false, endedAt: new Date().toISOString() }));
    let published = false;
    if (context.comment) {
      try {
        const publish = deps.publishComment ?? publishPrReviewComment;
        await publish({
          context,
          headOid: initial.pr.headRefOid,
          decision,
          verificationStatus,
          reviewA,
          reviewB,
        });
        published = true;
        const afterPublish = await fetchFeedback({ cwd: options.cwd, repo: initial.repo, prNumber: options.prNumber });
        const afterPublishStaleReasons = prIdentityChanges(initial, afterPublish);
        if (afterPublishStaleReasons.length > 0) {
          decision = blockedPrReviewDecision(`PR changed while the review comment was being published (${afterPublishStaleReasons.join("; ")}); this comment is stale and must not be treated as current.`);
          await writePrReviewJson(context, "summary.json", { ...decision, verificationStatus, stale: true });
          await writePrReviewJson(context, "metadata.json", metadata(context, initial, prepared, { outcome: "blocked", stale: true, latestPr: afterPublish.pr, endedAt: new Date().toISOString() }));
          await publish({ context, headOid: initial.pr.headRefOid, decision, verificationStatus, reviewA, reviewB });
          return { outcome: "blocked", context, decision, verification, published: true, stale: true };
        }
      } catch (error) {
        await writePrReviewJson(context, "metadata.json", metadata(context, initial, prepared, {
          outcome: decision.outcome,
          publication: "failed",
          publicationError: errorMessage(error),
          endedAt: new Date().toISOString(),
        }));
        throw new Error(`PR review completed and artifacts were preserved, but comment publishing failed: ${errorMessage(error)}`);
      }
    }
    return { outcome: decision.outcome, context, decision, verification, published, stale: false };
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
  console.log(`\n=== PR Review ${lens.reviewerLabel} ===`);
  return runner({
    cwd: context.agentCwd,
    model: effectiveModelForStage(context.model, stage),
    thinkingLevel: context.thinkingConfig[stage],
    systemPrompt: sharedSystemPrompt,
    prompt: prReviewPrompt({ context, comparison: prepared.comparison, lens }),
    fileEditingToolsEnabled: false,
    phase: `pr-review-${lens.reviewerLabel.toLowerCase()}`,
  });
}

async function fetchOptionalLinkedIssue(
  input: { cwd: string; repo: string; issueNumber: number },
  fetcher?: RunPrReviewDependencies["fetchLinkedIssue"],
): Promise<unknown> {
  if (fetcher) return fetcher(input);
  const result = await runProcess(["gh", "issue", "view", String(input.issueNumber), "--repo", input.repo, "--json", "number,title,body,state,url"], { cwd: input.cwd });
  if (result.exitCode !== 0) return undefined;
  try { return JSON.parse(result.stdout) as unknown; } catch { return undefined; }
}

function formatPrContext(feedback: PullRequestFeedback, linkedIssue: unknown): string {
  const lines = [
    `# PR #${feedback.pr.number}: ${feedback.pr.title}`,
    "",
    "## Authoritative Requirements",
    linkedIssue === undefined
      ? "No linked same-repository issue was available. Use the PR title and description below as the best available requirements."
      : `Linked same-repository issue:\n\n\`\`\`json\n${JSON.stringify(linkedIssue, null, 2)}\n\`\`\``,
    "",
    "## PR Description",
    feedback.pr.body || "None.",
    "",
    "## Existing PR Comments (secondary context)",
    ...listOrNone(feedback.comments.map((comment) => `${comment.author ?? "unknown"}: ${comment.body}`)),
    "",
    "## Review Threads (secondary context)",
    ...listOrNone(feedback.reviewThreads.flatMap((thread) => thread.comments.map((comment) => `${thread.path ?? "unknown"}:${thread.line ?? thread.originalLine ?? "?"} ${comment.author ?? "unknown"}: ${comment.body}`))),
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
