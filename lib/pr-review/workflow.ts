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

  try {
    const context = await createPrReviewContext({ ...options, repo: initial.repo, agentCwd: prepared.path });
    console.log(`Run directory: ${context.reviewDirRelative}`);
    console.log(`Review workspace: ${context.agentCwd}`);
    await hookRunner("beforeRun", hooks, context.agentCwd);

    const linkedIssueNumber = inferIssueFromPrBody(initial.pr.body);
    const linkedIssue = linkedIssueNumber === undefined
      ? undefined
      : await fetchOptionalLinkedIssue({ cwd: options.cwd, repo: initial.repo, issueNumber: linkedIssueNumber }, deps.fetchLinkedIssue);
    await writePrReviewJson(context, "pr-context.json", { ...initial, linkedIssue });
    await writePrReviewArtifact(context, "pr-context.md", formatPrContext(initial, linkedIssue));
    await writePrReviewJson(context, "comparison.json", prepared.comparison);

    const resolvedVerification = await resolvePrReviewVerification({
      cwd: context.agentCwd,
      command: context.verifyCommand,
      source: options.verificationSource,
    });
    context.verifyCommand = resolvedVerification.command;
    context.verificationSource = resolvedVerification.source;

    let verification: VerificationResult | undefined;
    let verificationUnavailable: string | undefined;
    let verificationStatus = "not configured";
    if (resolvedVerification.command) {
      await hookRunner("beforeVerify", hooks, context.agentCwd);
      try {
        verification = await runVerification({ command: resolvedVerification.command, cwd: context.agentCwd, runner: deps.verificationRunner });
        await writePrReviewArtifact(context, "verification.md", formatVerificationArtifact(verification));
        const classification = classifyVerificationFailure(verification);
        if (!verification.ok && !classification.repairable) verificationUnavailable = classification.recoveryGuidance ?? classification.reason;
        verificationStatus = `${verification.ok ? "passed" : "failed"} (${resolvedVerification.source}, \`${resolvedVerification.command}\`, exit ${verification.exitCode})`;
      } catch (error) {
        verificationUnavailable = `Verification could not run: ${errorMessage(error)}`;
        verificationStatus = verificationUnavailable;
        await writePrReviewArtifact(context, "verification.md", `# Verification\n\n## Status\nUnavailable\n\n## Reason\n${verificationUnavailable}\n`);
      }
    } else {
      await writePrReviewArtifact(context, "verification.md", "# Verification\n\n## Status\nNot configured\n");
    }

    await writePrReviewJson(context, "metadata.json", metadata(context, initial, prepared, {
      outcome: "reviewing",
      verificationSource: resolvedVerification.source,
      verificationCommand: resolvedVerification.command,
    }));

    const runner = deps.agentRunner ?? runPiAgent;
    const [reviewA, reviewB] = await Promise.all([
      runReviewer(context, prepared, runner, correctnessReviewLens, "reviewA"),
      runReviewer(context, prepared, runner, maintainabilityReviewLens, "reviewB"),
    ]);
    await writePrReviewArtifact(context, "review-a.md", reviewA);
    await writePrReviewArtifact(context, "review-b.md", reviewB);

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
    const stale = latest.pr.headRefOid !== initial.pr.headRefOid;
    if (stale) {
      decision = blockedPrReviewDecision(`PR head changed from ${initial.pr.headRefOid} to ${latest.pr.headRefOid} during review; findings were retained but not published as current.`);
      await writePrReviewJson(context, "summary.json", { ...decision, verificationStatus, stale: true });
      await writePrReviewJson(context, "metadata.json", metadata(context, initial, prepared, { outcome: "blocked", stale: true, latestHeadOid: latest.pr.headRefOid, endedAt: new Date().toISOString() }));
      await removeAgentPrReviewArtifacts(context);
      return { outcome: "blocked", context, decision, verification, published: false, stale: true };
    }

    await writePrReviewJson(context, "metadata.json", metadata(context, initial, prepared, { outcome: decision.outcome, stale: false, endedAt: new Date().toISOString() }));
    let published = false;
    if (context.comment) {
      try {
        await (deps.publishComment ?? publishPrReviewComment)({
          context,
          headOid: initial.pr.headRefOid,
          decision,
          verification,
          verificationStatus,
          reviewA,
          reviewB,
        });
        published = true;
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
    await removeAgentPrReviewArtifacts(context);
    return { outcome: decision.outcome, context, decision, verification, published, stale: false };
  } finally {
    try {
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
    "## PR Body (primary requirements)",
    feedback.pr.body || "None.",
    "",
    "## Linked Issue Context",
    linkedIssue === undefined ? "Not available." : `\`\`\`json\n${JSON.stringify(linkedIssue, null, 2)}\n\`\`\``,
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
