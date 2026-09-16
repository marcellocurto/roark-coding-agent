import type { PreparedPrReviewWorkspace } from "../autorun/workspace.ts";
import { Cause, DateTime, Effect, Exit, Schema } from "effect";
import { AgentExecution } from "../runtime/services.ts";
import { Workspace } from "../autorun/workspace-service.ts";
import { GitHub } from "../github/service.ts";
import { Presentation } from "../runtime/services.ts";

import path from "node:path";
import type { ReviewPrCliOptions } from "../cli/args.ts";
import {
  classifyVerificationFailure,
  writeVerificationArtifacts,
  type VerificationResult,
} from "../autorun/verification.ts";
import { runVerification } from "../autorun/verification.ts";
import {
  defaultLifecycleHooks,
  defaultWorkspaceConfig,
} from "../autorun/workspace.ts";

import { sanitizePublicMarkdown } from "../autorun/public-output.ts";
import {
  isRoarkGeneratedPrSummaryComment,
  type PullRequestClosingIssue,
  type PullRequestFeedback,
} from "../github/pr.ts";
import { truncateGitHubIssueComment } from "../github/comments.ts";
import { sharedSystemPrompt } from "../prompts/workflow-prompts.ts";
import {
  correctnessReviewLens,
  maintainabilityReviewLens,
  type ReviewLensDefinition,
} from "../review/contract.ts";
import { type AgentDisplayContext } from "../presentation/presenter.ts";
import { runPresentedPhase } from "../presentation/phase.ts";
import { createAgentRunRequest } from "../workflow/agent-runner.ts";
import { type PrReviewContext } from "./artifacts.ts";
import {
  createPrReviewContext,
  removeAgentPrReviewArtifacts,
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
export const runPrReview = Effect.fn("runPrReview")(function* (
  options: ReviewPrCliOptions,
) {
  const github = yield* GitHub;
  const workspaces = yield* Workspace;
  const fetchFeedback = github.fetchPullRequestFeedback;
  const initial = yield* fetchFeedback({
    cwd: options.cwd,
    repo: options.repo,
    prNumber: options.prNumber,
  });
  yield* validateReviewablePr(initial);
  (yield* Presentation).transition(
    "Review preparation",
    `PR #${initial.pr.number}`,
    { operation: "inspect" },
  );
  const hooks = options.hooks ?? defaultLifecycleHooks;
  const prepareWorkspace = workspaces.preparePrReview;
  const workspace = options.workspace ?? defaultWorkspaceConfig;
  const prepared = yield* prepareWorkspace({
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
  yield* Effect.addFinalizer(() =>
    workspaces.runHook("afterRun", hooks, prepared.path).pipe(Effect.orDie),
  );
  const hookRunner = workspaces.runHook;
  const assertWorkspace = workspaces.assertPinnedReview;
  const context = yield* createPrReviewContext({
    ...options,
    repo: initial.repo,
    agentCwd: prepared.path,
  });
  yield* Effect.addFinalizer(() =>
    removeAgentPrReviewArtifacts(context).pipe(Effect.orDie),
  );
  (yield* Presentation).transition(
    "Review preparation",
    `PR #${context.prNumber}`,
    { pass: context.generation, operation: "inspect" },
  );
  (yield* Presentation).line(`Run directory: ${context.reviewDirRelative}`);
  (yield* Presentation).line(
    `Review workspace: ${path.basename(context.agentCwd)}`,
  );
  yield* hookRunner("beforeRun", hooks, context.agentCwd);
  yield* assertWorkspace({
    cwd: context.agentCwd,
    headOid: prepared.comparison.headOid,
  });
  const closingIssues = sameRepositoryClosingIssues(initial);
  yield* writePrReviewInputJson(context, "pr-context.json", {
    ...initial,
    closingIssues,
  });
  yield* writePrReviewInputArtifact(
    context,
    "pr-context.md",
    formatPrContext(initial, closingIssues),
  );
  yield* writePrReviewInputJson(
    context,
    "comparison.json",
    prepared.comparison,
  );
  let verification: VerificationResult | undefined;
  yield* hookRunner("beforeVerify", hooks, context.agentCwd);
  yield* Effect.gen(function* () {
    verification = yield* runVerification({
      command: options.verifyCommand,
      cwd: context.agentCwd,
      display: {
        target: `PR #${context.prNumber}`,
        repository: context.repo,
        pass: context.generation,
      },
    });
    yield* writeVerificationArtifacts(verification, {
      writeSummary: (content) =>
        writePrReviewInputArtifact(context, "verification.md", content),
      writeFull: (content) =>
        writePrReviewArtifact(context, "verification-full.md", content),
    });
    (yield* Presentation).artifact(
      path.join(context.reviewDirRelative, "verification.md"),
    );
    const classification = classifyVerificationFailure(verification);
    if (!verification.ok) {
      (yield* Presentation).line(
        `ACTION user action required for verification: ${classification.recoveryGuidance ?? classification.reason}`,
      );
    }
  }).pipe(
    Effect.catch(
      Effect.fnUntraced(function* (error) {
        const reason = `Verification could not run: ${errorMessage(error)}`;
        yield* writePrReviewInputArtifact(
          context,
          "verification.md",
          `# Verification\n\n## Status\nUnavailable\n\n## Reason\n${reason}\n`,
        );
      }),
    ),
  );
  yield* assertWorkspace({
    cwd: context.agentCwd,
    headOid: prepared.comparison.headOid,
  });
  yield* writePrReviewJson(
    context,
    "metadata.json",
    metadata(context, initial, prepared, {
      outcome: "reviewing",
      verificationCommand: options.verifyCommand,
    }),
  );
  const [reviewAResult, reviewBResult] = yield* Effect.all(
    [
      Effect.exit(
        runReviewer(context, prepared, correctnessReviewLens, "reviewA"),
      ),
      Effect.exit(
        runReviewer(context, prepared, maintainabilityReviewLens, "reviewB"),
      ),
    ],
    { concurrency: "unbounded" },
  );
  if (Exit.isFailure(reviewAResult) && Exit.isFailure(reviewBResult))
    return yield* Effect.failCause(
      Cause.combine(reviewAResult.cause, reviewBResult.cause),
    );
  if (Exit.isFailure(reviewAResult))
    return yield* Effect.failCause(reviewAResult.cause);
  if (Exit.isFailure(reviewBResult))
    return yield* Effect.failCause(reviewBResult.cause);
  const reviewA = reviewAResult.value;
  const reviewB = reviewBResult.value;
  yield* assertWorkspace({
    cwd: context.agentCwd,
    headOid: prepared.comparison.headOid,
  });
  const latest = yield* fetchFeedback({
    cwd: options.cwd,
    repo: initial.repo,
    prNumber: options.prNumber,
  });
  const staleReasons = prIdentityChanges(initial, latest);
  if (staleReasons.length > 0) {
    yield* writePrReviewJson(
      context,
      "metadata.json",
      metadata(context, initial, prepared, {
        outcome: "blocked" as const,
        stale: true,
        staleReason: `PR changed during review (${staleReasons.join("; ")}); review comments were not published.`,
        latestPr: latest.pr,
        endedAt: DateTime.formatIso(yield* DateTime.now),
      }),
    );
    return {
      outcome: "blocked" as const,
      context,
      verification,
      published: false,
      stale: true,
    };
  }
  yield* writePrReviewJson(
    context,
    "metadata.json",
    metadata(context, initial, prepared, {
      outcome: "completed" as const,
      stale: false,
      endedAt: DateTime.formatIso(yield* DateTime.now),
    }),
  );
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
    (yield* Presentation).phaseStarted(publishDisplay);
    yield* Effect.gen(function* () {
      const postComment = github.postIssueComment;
      yield* postComment({
        cwd: context.controlCwd,
        repo: context.repo,
        issueNumber: context.prNumber,
        body: publicReviewComment(context, "a", reviewA),
      });
      yield* postComment({
        cwd: context.controlCwd,
        repo: context.repo,
        issueNumber: context.prNumber,
        body: publicReviewComment(context, "b", reviewB),
      });
      published = true;
      (yield* Presentation).phaseCompleted(publishDisplay, {
        outcome: "published 2 reviewer comments",
      });
    }).pipe(
      Effect.catch(
        Effect.fnUntraced(function* (error) {
          yield* writePrReviewJson(
            context,
            "metadata.json",
            metadata(context, initial, prepared, {
              outcome: "completed" as const,
              publication: "failed",
              publicationError: errorMessage(error),
              endedAt: DateTime.formatIso(yield* DateTime.now),
            }),
          );
          const publicationError = new PrReviewError({
            message: `PR review completed, but reviewer comment publishing failed: ${errorMessage(error)}`,
          });
          (yield* Presentation).phaseCompleted(publishDisplay, {
            outcome: publicationError.message,
            failed: true,
          });
          return yield* Effect.fail(publicationError);
        }),
      ),
    );
  }
  return {
    outcome: "completed" as const,
    context,
    verification,
    published,
    stale: false,
  };
}, Effect.scoped);
const validateReviewablePr = Effect.fn("validateReviewablePr")(function* (
  feedback: PullRequestFeedback,
) {
  if (feedback.pr.state !== "OPEN")
    return yield* new PrReviewError({
      message: `PR #${feedback.pr.number} must be open. Current state: ${feedback.pr.state}.`,
    });
  if (!feedback.pr.baseRefOid || !feedback.pr.headRefOid)
    return yield* new PrReviewError({
      message: `PR #${feedback.pr.number} metadata did not include immutable base and head commit identifiers.`,
    });
});
function prIdentityChanges(
  initial: PullRequestFeedback,
  latest: PullRequestFeedback,
): string[] {
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
    if (before !== after)
      changes.push(
        `${label} changed from ${before ?? "(unknown)"} to ${after ?? "(unknown)"}`,
      );
  }
  return changes;
}
const runReviewer = Effect.fn("runReviewer")(function* (
  context: PrReviewContext,
  prepared: PreparedPrReviewWorkspace,
  lens: ReviewLensDefinition,
  stage: "reviewA" | "reviewB",
) {
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
  return yield* runPresentedPhase(
    display,
    Effect.fnUntraced(function* () {
      const markdown = (yield* (yield* AgentExecution).run(
        createAgentRunRequest(context, stage, {
          cwd: context.agentCwd,
          systemPrompt: sharedSystemPrompt,
          prompt: prReviewPrompt({
            context,
            comparison: prepared.comparison,
            lens,
          }),
          fileEditingToolsEnabled: false,
          display,
        }),
      )).trim();
      if (!markdown)
        return yield* Effect.fail(
          new PrReviewError({
            message: `${lens.role} returned an empty PR review comment.`,
          }),
        );
      yield* writePrReviewArtifact(context, `${artifactName}.md`, markdown);
      return markdown;
    }),
    () => ({
      outcome: "completed" as const,
      artifact: display.expectedArtifact,
    }),
    { manageTitle: false },
  );
});
function publicReviewComment(
  context: PrReviewContext,
  reviewer: "a" | "b",
  markdown: string,
): string {
  const marker = `<!-- roark:pr=${context.prNumber} phase=pr-review reviewer=${reviewer} -->`;
  const body = sanitizePublicMarkdown(markdown, {
    localRoots: [
      context.controlCwd,
      context.agentCwd,
      context.outDir,
      context.reviewDir,
    ],
  });
  return truncateGitHubIssueComment(`${marker}\n${body.trim()}\n`);
}
export function sameRepositoryClosingIssues(
  feedback: PullRequestFeedback,
): PullRequestClosingIssue[] {
  return (feedback.closingIssues ?? []).filter(
    (issue) => issue.repository?.toLowerCase() === feedback.repo.toLowerCase(),
  );
}
function formatPrContext(
  feedback: PullRequestFeedback,
  closingIssues: PullRequestClosingIssue[],
): string {
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
    ...listOrNone(
      feedback.comments
        .filter((comment) => !isRoarkGeneratedPrSummaryComment(comment.body))
        .map((comment) => `${comment.author ?? "unknown"}: ${comment.body}`),
    ),
    "",
    "## Review Threads (secondary context)",
    ...(feedback.reviewThreadsTruncated === true
      ? [
          "- Context incomplete: GitHub reported additional review threads beyond this fetch. Treat the listed threads as partial secondary context and review the pinned diff independently.",
        ]
      : []),
    ...listOrNone(
      feedback.reviewThreads.flatMap((thread) => {
        const resolution = thread.isResolved ? "resolved" : "unresolved";
        const freshness =
          thread.isOutdated === true
            ? "outdated"
            : thread.isOutdated === false
              ? "current"
              : "freshness unknown";
        return thread.comments.map(
          (comment) =>
            `[${resolution}, ${freshness}] ${thread.path ?? "unknown"}:${thread.line ?? thread.originalLine ?? "?"} ${comment.author ?? "unknown"}: ${comment.body}`,
        );
      }),
    ),
  ];
  return `${lines.join("\n")}\n`;
}
function listOrNone(values: string[]): string[] {
  return values.length === 0 ? ["None."] : values.map((value) => `- ${value}`);
}
function metadata(
  context: PrReviewContext,
  feedback: PullRequestFeedback,
  prepared: PreparedPrReviewWorkspace,
  update: Record<string, unknown>,
): Record<string, unknown> {
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

export class PrReviewError extends Schema.TaggedError<PrReviewError>()(
  "PrReviewError",
  { message: Schema.String },
) {}
