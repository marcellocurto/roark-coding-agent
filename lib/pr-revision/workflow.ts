import { Workspace } from "../autorun/workspace-service.ts";
import { GitHub } from "../github/service.ts";
import { Presentation } from "../runtime/services.ts";
import { Cause, DateTime, Effect, Exit, FileSystem, Schema } from "effect";
import path from "node:path";
import { runProcess, runProcessOrThrow } from "../cli/process.ts";
import { type RevisePrCliOptions } from "../cli/args.ts";
import { type WorkflowThinkingStage } from "../workflow/thinking.ts";
import { createAgentRunRequest } from "../workflow/agent-runner.ts";
import { buildCommitArgv } from "../autorun/publish.ts";
import {
  classifyVerificationFailure,
  writeVerificationArtifacts,
  verificationFailureReason,
  type VerificationResult,
  runVerification,
} from "../autorun/verification.ts";
import { type PullRequestFeedback } from "../github/pr.ts";
import { sharedSystemPrompt } from "../prompts/workflow-prompts.ts";
import { type AgentDisplayContext } from "../presentation/presenter.ts";
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
} from "../autorun/workspace.ts";
import { validatePrBranchSafety } from "./branch.ts";
import { RevisionReporting } from "./comments.ts";
import {
  revisionImplementationPrompt,
  revisionPlanPrompt,
  revisionReviewPrompt,
} from "./prompts.ts";
import {
  isUnblockedCurrentFix,
  reviewDisposition,
  type ReviewResult,
} from "../review/result.ts";
import { reviewArtifactDefinition } from "../review/artifact.ts";
import {
  revisionPlanArtifactDefinition,
  type RevisionPlanResult,
  type RevisionPlanStatus,
} from "./plan.ts";
import {
  revisionFeedbackDispositions,
  revisionExecutionArtifactDefinition,
} from "./execution.ts";
import {
  runStructuredArtifact,
  type StructuredArtifactDefinition,
} from "../structured-output/runner.ts";
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
export const runPrRevision = Effect.fn("runPrRevision")(function* (
  options: RevisePrCliOptions,
) {
  const controlCwd = options.cwd;
  yield* assertCleanGitTree({ cwd: controlCwd, yes: options.yes });
  const fetchFeedback = (yield* GitHub).fetchPullRequestFeedback;
  const workspaces = yield* Workspace;
  const feedback = yield* fetchFeedback({
    cwd: controlCwd,
    repo: options.repo,
    prNumber: options.prNumber,
  });
  if (feedback.reviewThreadsTruncated === true) {
    return yield* Effect.fail(
      new PrRevisionError({
        message: `PR #${options.prNumber} has more review threads than Roark can fetch safely in one request. Refusing a partial revision plan.`,
      }),
    );
  }
  const repo = feedback.repo;
  yield* validatePrBranchSafety(feedback.pr, repo);
  (yield* Presentation).transition(
    "Revision preparation",
    `PR #${feedback.pr.number}`,
    { operation: "edit" },
  );
  const preparedWorkspace = yield* workspaces.preparePrRevision({
    controlCwd: options.cwd,
    repo,
    prNumber: options.prNumber,
    headRefName: feedback.pr.headRefName,
    workspace: options.workspace ?? defaultWorkspaceConfig,
    hooks: options.hooks ?? defaultLifecycleHooks,
  });
  const hookRunner = workspaces.runHook;
  const hooks = options.hooks ?? defaultLifecycleHooks;
  yield* Effect.addFinalizer(() =>
    workspaces
      .runHook("afterRun", hooks, preparedWorkspace.path)
      .pipe(Effect.orDie),
  );
  const context = yield* createPrRevisionContext({
    ...options,
    repo,
    controlCwd,
    agentCwd: preparedWorkspace.path,
  });
  yield* Effect.addFinalizer((exit) =>
    finalizeRevision(context, feedback, exit).pipe(Effect.orDie),
  );
  (yield* Presentation).transition(
    "Revision preparation",
    `PR #${context.prNumber}`,
    { revision: context.revision, operation: "edit" },
  );
  (yield* Presentation).line(`Run directory: ${context.revisionDirRelative}`);
  if (context.agentCwd !== context.controlCwd)
    (yield* Presentation).line(
      `Revision workspace: ${path.basename(context.agentCwd)}`,
    );
  yield* hookRunner("beforeRun", hooks, context.agentCwd);
  yield* writeInitialArtifacts(context, feedback);
  const postSummary = (yield* RevisionReporting).postSummary;
  const plan = yield* runRevisionPlanPhase(
    context,
    revisionFeedbackSources(feedback),
  );
  const planStatus = plan.status;
  yield* updateMetadata(context, feedback, { outcome: "planned", planStatus });
  if (planStatus === "no-action-needed") {
    yield* updateMetadata(context, feedback, {
      outcome: "no-action-needed",
      planStatus,
      endedAt: DateTime.formatIso(yield* DateTime.now),
    });
    (yield* Presentation).line(
      context.comment
        ? "No action needed; not mutating code, committing, or pushing. Posting summary comment."
        : "No action needed; not mutating code, committing, pushing, or commenting.",
    );
    if (context.comment) {
      yield* postSummary({
        context,
        outcome: "no-action-needed",
        dispositions: revisionFeedbackDispositions(plan),
      });
    }
    return {
      outcome: "no-action-needed",
      context,
      planStatus,
    } satisfies PrRevisionResult;
  }
  if (planStatus === "needs-human") {
    yield* updateMetadata(context, feedback, {
      outcome: "needs-human",
      planStatus,
      endedAt: DateTime.formatIso(yield* DateTime.now),
    });
    yield* postSummary({
      context,
      outcome: "needs-human",
      dispositions: revisionFeedbackDispositions(plan),
    });
    return {
      outcome: "needs-human",
      context,
      planStatus,
    } satisfies PrRevisionResult;
  }
  let execution = yield* runRevisionExecutionPhase(context, {
    plan,
    phaseId: "revision-implementation",
    label: "Revision implementation",
    artifact: "revision-log.json",
    title: "Revision Log",
    thinkingStage: "revisionImplementation",
    prompt: revisionImplementationPrompt(context, 0),
  });
  let review = yield* runRevisionReviewAgent(context, {
    phaseId: "revision-review",
    label: "Revision review",
    artifact: "revision-review.json",
    prompt: revisionReviewPrompt(context, 0),
  });
  let reviewVerdict = yield* revisionReviewVerdict(review);
  let fixPassesUsed = 0;
  let verification: VerificationResult | undefined;
  for (;;) {
    if (reviewVerdict === "fixes-required") {
      if (fixPassesUsed >= context.maxFixPasses) {
        yield* updateMetadata(context, feedback, {
          outcome: "review-blocked",
          planStatus,
          reviewVerdict,
          fixPassesUsed,
          endedAt: DateTime.formatIso(yield* DateTime.now),
        });
        yield* postSummary({
          context,
          outcome: "review-blocked",
          reviewVerdict,
          dispositions: revisionFeedbackDispositions(plan, execution),
        });
        return {
          outcome: "review-blocked",
          context,
          planStatus,
          reviewVerdict,
        } satisfies PrRevisionResult;
      }
      const pass = ++fixPassesUsed;
      const logArtifact = `revision-log-fix-pass-${pass}.json`;
      execution = yield* runRevisionExecutionPhase(context, {
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
      review = yield* runRevisionReviewAgent(context, {
        phaseId: `revision-review-${pass}`,
        pass,
        label: `Revision review pass ${pass}`,
        artifact: reviewArtifact,
        prompt: revisionReviewPrompt(context, pass),
      });
      reviewVerdict = yield* revisionReviewVerdict(review);
      continue;
    }
    if (reviewVerdict === "blocked") {
      yield* updateMetadata(context, feedback, {
        outcome: "review-blocked",
        planStatus,
        reviewVerdict,
        fixPassesUsed,
        endedAt: DateTime.formatIso(yield* DateTime.now),
      });
      yield* postSummary({
        context,
        outcome: "review-blocked",
        reviewVerdict,
        dispositions: revisionFeedbackDispositions(plan, execution),
      });
      return {
        outcome: "review-blocked",
        context,
        planStatus,
        reviewVerdict,
      } satisfies PrRevisionResult;
    }
    yield* hookRunner("beforeVerify", hooks, context.agentCwd);
    verification = yield* runVerification({
      command: context.verifyCommand,
      cwd: context.agentCwd,
      display: {
        target: `PR #${context.prNumber}`,
        repository: context.repo,
        revision: context.revision,
        ...(fixPassesUsed > 0 ? { pass: fixPassesUsed } : {}),
      },
    });
    yield* writeVerificationArtifacts(verification, {
      writeSummary: (content) =>
        writePrRevisionArtifact(context, "verification.md", content),
      writeFull: (content) =>
        writePrRevisionArtifact(context, "verification-full.md", content),
    });
    (yield* Presentation).artifact(
      prRevisionArtifactRelativePath(context, "verification.md"),
    );
    if (verification.ok) break;
    const classification = classifyVerificationFailure(verification);
    const failedReason = classification.repairable
      ? `Verification failed after ${context.maxFixPasses} fix passes: ${verificationFailureReason(verification)}`
      : verificationFailureReason(verification);
    if (!classification.repairable || fixPassesUsed >= context.maxFixPasses) {
      (yield* Presentation).line(
        `ACTION user action required: ${classification.recoveryGuidance ?? failedReason}`,
      );
      yield* updateMetadata(context, feedback, {
        outcome: "verification-failed",
        planStatus,
        reviewVerdict,
        verification,
        verificationFailureReason: failedReason,
        fixPassesUsed,
        endedAt: DateTime.formatIso(yield* DateTime.now),
      });
      yield* postSummary({
        context,
        outcome: "verification-failed",
        reviewVerdict,
        verification,
        dispositions: revisionFeedbackDispositions(plan, execution),
      });
      return {
        outcome: "verification-failed",
        context,
        planStatus,
        reviewVerdict,
        verification,
      } satisfies PrRevisionResult;
    }
    const pass = ++fixPassesUsed;
    (yield* Presentation).line(
      `Verification repair will run as fix pass ${pass}`,
    );
    const verificationBeforeFixArtifact = `verification-before-fix-${pass}.md`;
    yield* writeVerificationArtifacts(verification, {
      writeSummary: (content) =>
        writePrRevisionArtifact(
          context,
          verificationBeforeFixArtifact,
          content,
        ),
      writeFull: (content) =>
        writePrRevisionArtifact(
          context,
          `verification-before-fix-${pass}-full.md`,
          content,
        ),
    });
    (yield* Presentation).artifact(
      prRevisionArtifactRelativePath(context, verificationBeforeFixArtifact),
    );
    const logArtifact = `revision-log-fix-pass-${pass}.json`;
    execution = yield* runRevisionExecutionPhase(context, {
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
    review = yield* runRevisionReviewAgent(context, {
      phaseId: `revision-review-${pass}`,
      pass,
      label: `Revision review pass ${pass}`,
      artifact: reviewArtifact,
      prompt: revisionReviewPrompt(context, pass),
    });
    reviewVerdict = yield* revisionReviewVerdict(review);
  }
  if ((yield* dirtyLinesOutsideRoark(context.agentCwd)).length === 0) {
    yield* updateMetadata(context, feedback, {
      outcome: "no-code-changes",
      planStatus,
      reviewVerdict,
      verification,
      endedAt: DateTime.formatIso(yield* DateTime.now),
    });
    yield* postSummary({
      context,
      outcome: "no-code-changes",
      reviewVerdict,
      verification,
      dispositions: revisionFeedbackDispositions(plan, execution),
    });
    return {
      outcome: "no-code-changes",
      context,
      planStatus,
      reviewVerdict,
      verification,
    } satisfies PrRevisionResult;
  }
  const changedFiles = yield* changedFilesOutsideRoark(context.agentCwd);
  const publishDisplay: AgentDisplayContext = {
    command: "revise-pr",
    repository: context.repo,
    target: `PR #${context.prNumber}`,
    phaseId: "pr-revision-publish",
    phaseLabel: "Commit and push revision",
    revision: context.revision,
    operation: "publish",
  };
  const commitSha = yield* runPresentedPhase(
    publishDisplay,
    () =>
      Effect.uninterruptibleMask((restore) =>
        restore(commitAndPushRevision(context, feedback.pr.headRefName)).pipe(
          // Once the push is acknowledged, persist publication before accepting interruption.
          Effect.tap(() =>
            Effect.gen(function* () {
              yield* updateMetadata(context, feedback, {
                outcome: "published",
                planStatus,
                reviewVerdict,
                verification,
                endedAt: DateTime.formatIso(yield* DateTime.now),
              });
            }),
          ),
        ),
      ),
    (sha) => ({ outcome: sha ? `pushed ${sha.slice(0, 12)}` : "pushed" }),
  );
  yield* postSummary({
    context,
    outcome: "published",
    reviewVerdict,
    verification,
    dispositions: revisionFeedbackDispositions(plan, execution),
    changedFiles,
    commitSha,
  });
  return {
    outcome: "published",
    context,
    planStatus,
    reviewVerdict,
    verification,
  } satisfies PrRevisionResult;
}, Effect.scoped);
const runRevisionArtifactPhase = Effect.fn("runRevisionArtifactPhase")(
  function* <T>(
    context: PrRevisionContext,
    input: {
      phaseId: string;
      label: string;
      artifact: string;
      thinkingStage: WorkflowThinkingStage;
      operation: AgentDisplayContext["operation"];
      prompt: string;
      pass?: number | undefined;
    },
    definition: StructuredArtifactDefinition<T>,
    outcomeFor?: (value: T) => string,
  ) {
    const display = revisionDisplay(context, input, input.operation);
    const artifact = yield* runPresentedPhase(
      display,
      () =>
        runStructuredArtifact(
          createAgentRunRequest(context, input.thinkingStage, {
            cwd: context.agentCwd,
            systemPrompt: sharedSystemPrompt,
            prompt: input.prompt,
            fileEditingToolsEnabled: input.operation === "edit",
            display,
          }),
          definition,
          {
            writeJson: (content) =>
              writePrRevisionArtifact(context, input.artifact, content),
            writeMarkdown: (content) =>
              writePrRevisionArtifact(
                context,
                input.artifact.replace(/\.json$/, ".md"),
                content,
              ),
          },
        ),
      (result) => ({
        outcome: outcomeFor?.(result.value) ?? "completed",
        artifact: display.expectedArtifact,
      }),
    );
    return artifact.value;
  },
);
const runRevisionExecutionPhase = Effect.fn("runRevisionExecutionPhase")(
  function* (
    context: PrRevisionContext,
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
  ) {
    return yield* runRevisionArtifactPhase(
      context,
      { ...input, operation: "edit" },
      revisionExecutionArtifactDefinition(input.title, input.plan),
    );
  },
);
const runRevisionPlanPhase = Effect.fn("runRevisionPlanPhase")(function* (
  context: PrRevisionContext,
  feedbackSources: readonly RevisionFeedbackSource[],
) {
  return yield* runRevisionArtifactPhase(
    context,
    {
      phaseId: "revision-plan",
      label: "Revision plan",
      artifact: "revision-plan.json",
      thinkingStage: "revisionPlan",
      operation: "inspect",
      prompt: revisionPlanPrompt(context),
    },
    revisionPlanArtifactDefinition(
      new Set(feedbackSources.map((source) => source.id)),
    ),
    (plan) => plan.status,
  );
});
const runRevisionReviewAgent = Effect.fn("runRevisionReviewAgent")(function* (
  context: PrRevisionContext,
  input: {
    phaseId: string;
    label: string;
    artifact: string;
    prompt: string;
    pass?: number | undefined;
  },
) {
  return yield* runRevisionArtifactPhase(
    context,
    { ...input, thinkingStage: "revisionReview", operation: "review" },
    reviewArtifactDefinition({
      allowRestart: false,
      title: input.label,
      source: "revision-review",
    }),
    reviewDisposition,
  );
});
function revisionDisplay(
  context: PrRevisionContext,
  input: {
    phaseId: string;
    label: string;
    artifact: string;
    pass?: number | undefined;
  },
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
    expectedArtifact: prRevisionArtifactRelativePath(
      context,
      input.artifact.replace(/\.json$/, ".md"),
    ),
    operation,
  };
}
const writeInitialArtifacts = Effect.fn("writeInitialArtifacts")(function* (
  context: PrRevisionContext,
  feedback: PullRequestFeedback,
) {
  yield* writePrRevisionJsonArtifact(
    context,
    "pr-feedback.json",
    plannerFacingFeedback(feedback),
  );
  yield* writePrRevisionArtifact(
    context,
    "pr-feedback.md",
    formatPrFeedbackMarkdown(feedback),
  );
  yield* updateMetadata(context, feedback, { outcome: "started" });
});
interface RevisionFeedbackSource {
  id: string;
  kind:
    | "pr-description"
    | "review-thread"
    | "pr-comment"
    | "closing-issue"
    | "closing-issue-comment";
  url?: string | undefined;
}
function plannerFacingFeedback(
  feedback: PullRequestFeedback,
): PullRequestFeedback & {
  feedbackSources: RevisionFeedbackSource[];
} {
  return {
    ...feedback,
    comments: feedback.plannerComments,
    feedbackSources: revisionFeedbackSources(feedback),
  };
}
function revisionFeedbackSources(
  feedback: PullRequestFeedback,
): RevisionFeedbackSource[] {
  return [
    {
      id: `pr:${feedback.pr.number}`,
      kind: "pr-description" as const,
      url: feedback.pr.url,
    },
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
      {
        id: `issue:${issue.number}`,
        kind: "closing-issue" as const,
        url: issue.url,
      },
      ...(issue.comments ?? []).map((comment, index) => ({
        id: `issue-comment:${issue.number}:${comment.databaseId ?? comment.id ?? index + 1}`,
        kind: "closing-issue-comment" as const,
        url: comment.url,
      })),
    ]),
  ];
}
const updateMetadata = Effect.fn("updateMetadata")(function* (
  context: PrRevisionContext,
  feedback: PullRequestFeedback,
  update: Record<string, unknown>,
) {
  yield* writePrRevisionJsonArtifact(context, "metadata.json", {
    prNumber: context.prNumber,
    revision: context.revision,
    repo: feedback.repo,
    startedAt: feedback.fetchedAt,
    inferredIssue: yield* inferIssueForRevision(context, feedback),
    pr: feedback.pr,
    excludedRoarkSummaryCommentIds: feedback.excludedRoarkSummaryCommentIds,
    ...update,
  });
});
const inferIssueForRevision = Effect.fn("inferIssueForRevision")(function* (
  context: PrRevisionContext,
  feedback: PullRequestFeedback,
) {
  return (
    inferIssueFromPrBody(feedback.pr.body) ??
    (yield* inferIssueFromAttemptMetadata(context, feedback.pr.headRefName))
  );
});
const historicalAttempt = Schema.Struct({
  branch: Schema.String,
  issueNumber: Schema.Int.check(Schema.isGreaterThan(0)),
});
const decodeHistoricalAttempt = Schema.decodeUnknownEffect(
  Schema.fromJsonString(historicalAttempt),
);
const inferIssueFromAttemptMetadata = Effect.fnUntraced(function* (
  context: PrRevisionContext,
  headRefName: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const root = path.join(context.outDir, "issue");
  const issues = yield* fs
    .readDirectory(root)
    .pipe(Effect.catch(() => Effect.succeed([])));
  for (const issue of issues) {
    const dir = path.join(root, issue, "attempts");
    const attempts = yield* fs
      .readDirectory(dir)
      .pipe(Effect.catch(() => Effect.succeed([])));
    for (const attempt of attempts) {
      const metadata = yield* fs
        .readFileString(path.join(dir, attempt, "attempt.json"))
        .pipe(
          Effect.flatMap(decodeHistoricalAttempt),
          Effect.catch(() => Effect.succeed(undefined)),
        );
      if (metadata?.branch === headRefName) return metadata.issueNumber;
    }
  }
  return undefined;
});
const revisionReviewVerdict = Effect.fnUntraced(function* (
  review: ReviewResult,
) {
  if (review.restartRecommendation !== undefined) {
    return yield* new PrRevisionError({
      message: "Revision reviews cannot request an implementation restart.",
    });
  }
  if (review.findings.some(isUnblockedCurrentFix)) return "fixes-required";
  const disposition = reviewDisposition(review);
  if (disposition === "restart-required")
    return yield* new PrRevisionError({
      message: "Revision reviews cannot request an implementation restart.",
    });
  return disposition;
});
const dirtyLinesOutsideRoark = Effect.fn("dirtyLinesOutsideRoark")(function* (
  cwd: string,
) {
  return (yield* gitDirtyLines(cwd)).filter(
    (line) => !statusLinePaths(line).every(isRoarkPath),
  );
});
function statusLinePaths(line: string): string[] {
  const pathPart = line.slice(3).trim();
  if (!pathPart) return [];
  return pathPart
    .split(" -> ")
    .map((filePath) => filePath.replace(/^"|"$/g, ""));
}
function isRoarkPath(filePath: string): boolean {
  return filePath === ".roark" || filePath.startsWith(".roark/");
}
const commitAndPushRevision = Effect.fn("commitAndPushRevision")(function* (
  context: PrRevisionContext,
  branchName: string,
) {
  yield* ensurePushRemote(context);
  yield* runProcessOrThrow(
    ["git", "add", "-A", "--", ".", ":(exclude).roark"],
    { cwd: context.agentCwd, label: "git add revision changes" },
  );
  yield* runProcessOrThrow(
    buildCommitArgv({
      message: `roark: revise PR #${context.prNumber} (revision ${context.revision})`,
    }),
    {
      cwd: context.agentCwd,
      label: "git commit",
    },
  );
  const commitSha = yield* runProcessOrThrow(
    ["git", "rev-parse", "--short", "HEAD"],
    { cwd: context.agentCwd, label: "git rev-parse HEAD" },
  ).pipe(
    Effect.map((value) => value.trim()),
    Effect.catch(() => Effect.succeed(undefined)),
  );
  yield* runProcessOrThrow(
    ["git", "push", context.remote, `HEAD:${branchName}`],
    { cwd: context.agentCwd, label: `git push ${context.remote}` },
  );
  return commitSha;
});
const changedFilesOutsideRoark = Effect.fn("changedFilesOutsideRoark")(
  function* (cwd: string) {
    const paths = (yield* gitDirtyLines(cwd))
      .flatMap(statusLinePaths)
      .filter((filePath) => !isRoarkPath(filePath));
    return [...new Set(paths)];
  },
);
const ensurePushRemote = Effect.fn("ensurePushRemote")(function* (
  context: PrRevisionContext,
) {
  const agentRemote = yield* runProcess(
    ["git", "remote", "get-url", context.remote],
    { cwd: context.agentCwd },
  );
  if (path.resolve(context.agentCwd) === path.resolve(context.controlCwd)) {
    if (agentRemote.exitCode === 0 && agentRemote.stdout.trim()) return;
    return yield* Effect.fail(
      new PrRevisionError({
        message: `Git remote '${context.remote}' is not configured in '${context.agentCwd}'.`,
      }),
    );
  }
  const fetchUrl = (yield* runProcessOrThrow(
    ["git", "remote", "get-url", context.remote],
    {
      cwd: context.controlCwd,
      label: `git remote get-url ${context.remote}`,
    },
  )).trim();
  const pushUrl = (yield* runProcessOrThrow(
    ["git", "remote", "get-url", "--push", context.remote],
    {
      cwd: context.controlCwd,
      label: `git remote get-url --push ${context.remote}`,
    },
  )).trim();
  if (agentRemote.exitCode !== 0 || !agentRemote.stdout.trim()) {
    yield* runProcessOrThrow(
      ["git", "remote", "add", context.remote, fetchUrl],
      { cwd: context.agentCwd, label: `git remote add ${context.remote}` },
    );
  }
  const agentPushUrl = yield* runProcess(
    ["git", "remote", "get-url", "--push", context.remote],
    { cwd: context.agentCwd },
  );
  if (
    pushUrl &&
    (agentPushUrl.exitCode !== 0 || agentPushUrl.stdout.trim() !== pushUrl)
  ) {
    yield* runProcessOrThrow(
      ["git", "remote", "set-url", "--push", context.remote, pushUrl],
      {
        cwd: context.agentCwd,
        label: `git remote set-url --push ${context.remote}`,
      },
    );
  }
});
const metadataSchema = Schema.fromJsonString(
  Schema.Record(Schema.String, Schema.Unknown),
);
const terminalOutcome = Schema.Literals([
  "no-action-needed",
  "needs-human",
  "review-blocked",
  "verification-failed",
  "no-code-changes",
  "published",
]);
const finalizeRevision = Effect.fnUntraced(function* (
  context: PrRevisionContext,
  feedback: PullRequestFeedback,
  exit: Exit.Exit<unknown, unknown>,
) {
  const fs = yield* FileSystem.FileSystem;
  const saved = yield* fs
    .readFileString(path.join(context.revisionDir, "metadata.json"))
    .pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(metadataSchema)),
      Effect.catch(() => Effect.succeed<Record<string, unknown>>({})),
    );
  const terminal = Schema.is(terminalOutcome)(saved["outcome"]);
  yield* Effect.gen(function* () {
    if (Exit.isSuccess(exit)) return;
    yield* updateMetadata(context, feedback, {
      ...saved,
      ...(terminal
        ? {}
        : {
            outcome: Cause.hasInterruptsOnly(exit.cause)
              ? "interrupted"
              : "errored",
          }),
      error:
        Cause.prettyErrors(exit.cause)
          .map((error) => error.message)
          .join("\n") || "Interrupted.",
      endedAt: DateTime.formatIso(yield* DateTime.now),
    });
  }).pipe(
    Effect.ensuring(
      terminal && saved["outcome"] !== "published"
        ? removeAgentPrRevisionArtifacts(context).pipe(Effect.orDie)
        : Effect.void,
    ),
  );
});
export class PrRevisionError extends Schema.TaggedError<PrRevisionError>()(
  "PrRevisionError",
  { message: Schema.String },
) {}
