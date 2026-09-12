import type { OutcomeReport } from "../presentation/presenter.ts";
import { sanitizePublicMarkdown } from "./public-output.ts";
import { DateTime } from "effect";
import { Workspace } from "./workspace-service.ts";
import { Presentation } from "../runtime/services.ts";
import { Effect } from "effect";
import path from "node:path";
import {
  artifactRelativePath,
  fixLogRef,
  verificationBeforeFixRef,
  type WorkflowContext,
} from "../workflow/artifacts.ts";
import { artifactExists, inferNextFixPass } from "../workflow/artifacts.ts";
import { readArtifact } from "../workflow/artifacts.ts";
import { type IssueCreationResults } from "../issue-curation/create-issues.ts";
import { createIssuesFromCurationPlan } from "../issue-curation/create-issues.ts";
import { issueCurationPhase } from "../workflow/issue-curation.ts";
import { buildRoarkMarker } from "../github/comments.ts";
import { formatFailureComment } from "./failure.ts";
import { markIssueFailed } from "./failure.ts";
import {
  type AutorunPublishOptions,
  type FormatPrBodyFollowUpIssue,
} from "./publish.ts";
import {
  publishAutorunResult,
  updatePrBody as updatePublishedPrBody,
} from "./publish.ts";
import { decidePublish, type PublishGateDecision } from "./publish-gate.ts";
import { parseReadinessResultJson } from "../workflow/readiness.ts";
import {
  classifyVerificationFailure,
  verificationFailureReason,
  type VerificationResult,
} from "./verification.ts";
import {
  runVerification,
  writeVerificationArtifact,
  writeVerificationBeforeFixArtifact,
} from "./verification.ts";
import { recordAttemptIssueComment, type AttemptMetadata } from "./attempts.ts";
import {
  formatPrCreatedComment,
  formatReadinessLedgerComment,
} from "./ledger-comments.ts";
import { publishIssueLedgerComment } from "./ledger-comments.ts";
import type { AutorunBranchPlan } from "./branch.ts";
import type { AutorunIssueCandidate } from "./selection.ts";
import {
  type LifecycleHooksConfig,
  type WorkspaceConfig,
} from "./workspace.ts";
import { type runLifecycleHook } from "./workspace.ts";
import { type refreshCopyToWorktree } from "./workspace.ts";
import { labelsToRemoveForAutorunTransition } from "./labels.ts";
import { runPrReview } from "../pr-review/workflow.ts";
export type AutorunGateOptions = AutorunPublishOptions & {
  verifyCommand: string;
  hooks?: LifecycleHooksConfig | undefined;
  workspace?: WorkspaceConfig | undefined;
};
export type PublishGateOutcome =
  | {
      outcome: "published" | "failed-readiness" | "failed-verification";
      outcomeDetail: string | null;
      report?: OutcomeReport;
    }
  | {
      outcome: "verification-needs-fix";
      outcomeDetail: string;
      pass: number;
    };
export interface RunPublishGateInjected {
  refreshCopyToWorktree?: typeof refreshCopyToWorktree | undefined;
  runLifecycleHook?: typeof runLifecycleHook | undefined;
  runVerification?: typeof runVerification | undefined;
  writeVerificationArtifact?: typeof writeVerificationArtifact | undefined;
  handleNonPublish?: typeof handleNonPublish | undefined;
  publishAutorunResult?: typeof publishAutorunResult | undefined;
  postPrIssueCreation?:
    | ((
        input: Parameters<typeof createReviewerIssuesAfterPr>[0],
      ) => Effect.Effect<
        IssueCreationResults | undefined,
        Effect.Error<ReturnType<typeof createReviewerIssuesAfterPr>>,
        Effect.Services<ReturnType<typeof createReviewerIssuesAfterPr>>
      >)
    | undefined;
  publishIssueLedgerComment?: typeof publishIssueLedgerComment | undefined;
  updatePrBody?: typeof updatePublishedPrBody | undefined;
  runPrReview?:
    | ((
        options: Parameters<typeof runPrReview>[0],
      ) => Effect.Effect<
        Pick<AwaitedPrReview, "outcome" | "context">,
        Effect.Error<ReturnType<typeof runPrReview>>,
        Effect.Services<ReturnType<typeof runPrReview>>
      >)
    | undefined;
}
interface AwaitedPrReview {
  outcome: "completed" | "blocked";
  context: {
    reviewDirRelative: string;
  };
}
export const runPublishGate = Effect.fn("runPublishGate")(function* (
  input: {
    options: AutorunGateOptions;
    issue: AutorunIssueCandidate;
    branchPlan: AutorunBranchPlan;
    workflowContext: WorkflowContext;
    attemptMetadata: AttemptMetadata;
    attemptMetadataPath: string;
    recoveryCommand?: string | undefined;
  },
  injected: RunPublishGateInjected = {},
) {
  const {
    options,
    issue,
    branchPlan,
    workflowContext,
    attemptMetadata,
    attemptMetadataPath,
    recoveryCommand,
  } = input;
  const workspaces = yield* Workspace;
  const refreshWorkspace =
    injected.refreshCopyToWorktree ?? workspaces.refreshCopy;
  const runHook = injected.runLifecycleHook ?? workspaces.runHook;
  const verify = injected.runVerification ?? runVerification;
  const writeVerification =
    injected.writeVerificationArtifact ?? writeVerificationArtifact;
  const nonPublish = injected.handleNonPublish ?? handleNonPublish;
  const publishResult = injected.publishAutorunResult ?? publishAutorunResult;
  const postPrIssueCreation =
    injected.postPrIssueCreation ?? createReviewerIssuesAfterPr;
  const publishLedger =
    injected.publishIssueLedgerComment ?? publishIssueLedgerComment;
  const editPrBody = injected.updatePrBody ?? updatePublishedPrBody;
  const reviewPr = injected.runPrReview ?? runPrReview;
  const readinessResult = yield* readReadinessResult(workflowContext);
  const readinessStatus = readinessResult?.decision.status;
  const readinessMarkdown = yield* readReadinessMarkdown(workflowContext);
  let verification: VerificationResult | undefined;
  if (readinessStatus === "ready-for-pr") {
    yield* refreshWorkspace({
      controlCwd: options.cwd,
      worktreePath: workflowContext.agentCwd,
      copyToWorktree: options.workspace?.copyToWorktree,
    });
    yield* runHook("beforeVerify", options.hooks, workflowContext.agentCwd);
    verification = yield* verify({
      command: options.verifyCommand,
      cwd: workflowContext.agentCwd,
      display: {
        target: `#${workflowContext.issueNumber}`,
        repository: workflowContext.repo,
      },
    });
    yield* writeVerification(workflowContext, verification);
    (yield* Presentation).artifact(
      artifactRelativePath(workflowContext, "verification"),
    );
  }
  let decision = decidePublish({ readinessStatus, verification });
  if (decision.publish) {
    const publishedPr = yield* publishResult({
      options,
      issue,
      branchPlan,
      workflowContext,
      verification,
      attemptMetadata,
      attemptMetadataPath,
    });
    yield* publishLedger({
      cwd: options.cwd,
      repo: options.repo,
      issueNumber: issue.number,
      attemptMetadata,
      phase: "attempt-status",
      body:
        formatPrCreatedComment({
          issueNumber: issue.number,
          attempt: attemptMetadata.attempt,
          prUrl: publishedPr.url,
        }) +
        "\n" +
        sanitizePublicMarkdown(readinessMarkdown ?? ""),
    });
    let issueCreationResults: IssueCreationResults | undefined;
    yield* Effect.gen(function* () {
      issueCreationResults =
        (yield* postPrIssueCreation({
          workflowContext,
          prUrl: publishedPr.url,
        })) ?? undefined;
    }).pipe(
      Effect.catch(
        Effect.fnUntraced(function* (error) {
          (yield* Presentation).warning(
            `reviewer-generated issue creation failed after PR publication: ${error instanceof Error ? error.message : String(error)}`,
          );
        }),
      ),
    );
    yield* Effect.gen(function* () {
      yield* editPrBody({
        cwd: options.cwd,
        repo: options.repo,
        pr: publishedPr.url,
        issueNumber: issue.number,
        workflowContext,
        verification,
        attemptMetadata,
        followUpIssues: issueCreationResultsToFollowUps(issueCreationResults),
      });
    }).pipe(
      Effect.catch(
        Effect.fnUntraced(function* (error) {
          (yield* Presentation).warning(
            `failed to update PR body with final Roark ledger details: ${error instanceof Error ? error.message : String(error)}`,
          );
        }),
      ),
    );
    yield* Effect.gen(function* () {
      const review = yield* reviewPr({
        command: "review-pr",
        prNumber: publishedPr.number,
        cwd: options.cwd,
        outDir: workflowContext.outDir,
        repo: options.repo ?? workflowContext.repo,
        model: workflowContext.model,
        thinkingLevel: workflowContext.thinkingLevel,
        thinkingProfile: workflowContext.thinkingProfile,
        verifyCommand: options.verifyCommand,
        comment: true,
        workspace: options.workspace,
        hooks: options.hooks,
      });
      (yield* Presentation).artifact(review.context.reviewDirRelative);
      if (review.outcome === "blocked") {
        (yield* Presentation).warning(
          `automatic PR review for #${publishedPr.number} was blocked because the PR changed during review; review artifacts were preserved`,
        );
      }
    }).pipe(
      Effect.catch(
        Effect.fnUntraced(function* (error) {
          (yield* Presentation).warning(
            `automatic PR review failed after PR #${publishedPr.number} was published: ${error instanceof Error ? error.message : String(error)}`,
          );
        }),
      ),
    );
    return {
      outcome: "published" as const,
      outcomeDetail: null,
    } satisfies PublishGateOutcome;
  }
  if (decision.phase === "verification" && verification) {
    const classification = classifyVerificationFailure(verification);
    const repair = yield* planVerificationRepair(workflowContext, verification);
    if (repair) {
      (yield* Presentation).line(
        `Verification failed; scheduling fix pass ${repair.pass} before terminal failure`,
      );
      (yield* Presentation).artifact(
        artifactRelativePath(
          workflowContext,
          verificationBeforeFixRef(repair.pass),
        ),
      );
      return {
        outcome: "verification-needs-fix" as const,
        outcomeDetail: decision.reason,
        pass: repair.pass,
      } satisfies PublishGateOutcome;
    }
    decision = {
      ...decision,
      reason: classification.repairable
        ? `Verification failed after ${workflowContext.maxFixPasses} fix passes: ${verificationFailureReason(verification)}`
        : verificationFailureReason(verification),
    };
    (yield* Presentation).line(
      `ACTION user action required: ${classification.recoveryGuidance ?? decision.reason}`,
    );
  }
  const report = yield* nonPublish({
    options,
    issue,
    workflowContext,
    decision,
    attemptMetadata,
    attemptMetadataPath,
    recoveryCommand,
  });
  return {
    outcome:
      decision.phase === "verification"
        ? "failed-verification"
        : "failed-readiness",
    outcomeDetail: decision.reason,
    report,
  } satisfies PublishGateOutcome;
});
export const createReviewerIssuesAfterPr = Effect.fn(
  "createReviewerIssuesAfterPr",
)(function* (input: { workflowContext: WorkflowContext; prUrl: string }) {
  yield* issueCurationPhase(input.workflowContext, {
    prUrl: input.prUrl,
  });
  const result = yield* createIssuesFromCurationPlan({
    context: input.workflowContext,
    approved: true,
    approvalReason: "Roark opened the autorun pull request successfully",
  });
  if (result.failed.length > 0) {
    (yield* Presentation).warning(
      `reviewer-generated issue creation reported ${result.failed.length} failure(s)`,
    );
    (yield* Presentation).artifact(
      artifactRelativePath(input.workflowContext, "issueCreationResults"),
    );
  }
  return result;
});
function issueCreationResultsToFollowUps(
  result: IssueCreationResults | undefined,
): FormatPrBodyFollowUpIssue[] | undefined {
  if (!result || result.created.length === 0) return undefined;
  return result.created.map((created) => ({
    title: created.title,
    url: created.url,
    number: created.number,
  }));
}
export const planVerificationRepair = Effect.fn("planVerificationRepair")(
  function* (context: WorkflowContext, verification: VerificationResult) {
    if (!classifyVerificationFailure(verification).repairable) return undefined;
    const pass = yield* inferNextVerificationRepairPass(context);
    if (pass > context.maxFixPasses) return undefined;
    yield* writeVerificationBeforeFixArtifact(context, pass, verification);
    return { pass };
  },
);
const inferNextVerificationRepairPass = Effect.fn(
  "inferNextVerificationRepairPass",
)(function* (context: WorkflowContext) {
  return yield* Effect.gen(function* () {
    return yield* inferNextFixPass(context);
  }).pipe(
    Effect.catch(
      Effect.fnUntraced(function* () {
        for (let pass = 1; ; pass++) {
          if (!(yield* artifactExists(context, fixLogRef(pass)))) return pass;
        }
      }),
    ),
  );
});
export const handleNonPublish = Effect.fn("handleNonPublish")(
  function* (input: {
    options: AutorunGateOptions;
    issue: AutorunIssueCandidate;
    workflowContext: WorkflowContext;
    decision: Extract<
      PublishGateDecision,
      {
        publish: false;
      }
    >;
    attemptMetadata: AttemptMetadata;
    attemptMetadataPath: string;
    recoveryCommand?: string | undefined;
  }) {
    const {
      options,
      issue,
      workflowContext,
      decision,
      attemptMetadata,
      attemptMetadataPath,
      recoveryCommand,
    } = input;
    const artifactPath = path.join(
      workflowContext.runDirRelative,
      decision.artifactPath,
    );
    const artifactContent = yield* readDecisionArtifact(
      workflowContext,
      decision.phase,
    );
    (yield* Presentation).line(
      `Not publishing #${issue.number}: ${decision.phase} — ${decision.reason}.`,
    );
    (yield* Presentation).artifact(artifactPath);
    (yield* Presentation).artifact(attemptMetadataPath);
    if (recoveryCommand) (yield* Presentation).recovery(recoveryCommand);
    const comment =
      decision.phase === "readiness"
        ? formatReadinessLedgerComment({
            issueNumber: issue.number,
            attempt: attemptMetadata.attempt,
            artifactContent: artifactContent?.trim()
              ? artifactContent
              : `## ${decision.phase} stopped\n\n${decision.reason}`,
            recoveryCommand,
          })
        : formatFailureComment({
            issueNumber: issue.number,
            issueUrl: issue.url,
            phase: decision.phase,
            reason: decision.reason,
            branchName: attemptMetadata.branch,
            worktreePath: attemptMetadata.worktreePath,
            workspacePath: attemptMetadata.workspace?.path,
            artifactContent,
            recoveryCommand,
          });
    const marker = buildRoarkMarker({
      issueNumber: issue.number,
      attempt: attemptMetadata.attempt,
      phase: "attempt-status",
    });
    const ref = yield* markIssueFailed({
      cwd: options.cwd,
      repo: options.repo,
      issueNumber: issue.number,
      label: options.failureLabel,
      comment,
      removeLabels: labelsToRemoveForAutorunTransition({
        issueLabels: issue.labels,
        workflow: options,
        nextLabel: options.failureLabel,
        knownPresent: [options.inProgressLabel],
      }),
      marker,
      existingCommentId:
        attemptMetadata.githubComments?.issue?.["attempt-status"]?.id,
    });
    if (ref)
      recordAttemptIssueComment(
        attemptMetadata,
        "attempt-status",
        ref,
        DateTime.formatIso(yield* DateTime.now),
      );
    return {
      issueUrl: issue.url,
      commentUrl: ref?.url,
      published: ref !== undefined,
      reason: decision.reason,
      artifactPath,
      runDirectory: workflowContext.runDirRelative,
    } satisfies OutcomeReport;
  },
);
const readReadinessResult = Effect.fn("readReadinessResult")(function* (
  context: WorkflowContext,
) {
  return yield* Effect.gen(function* () {
    return yield* parseReadinessResultJson(
      yield* readArtifact(context, "readiness"),
    );
  }).pipe(
    Effect.catch(
      Effect.fnUntraced(function* () {
        return undefined;
      }),
    ),
  );
});
const readReadinessMarkdown = Effect.fn("readReadinessMarkdown")(function* (
  context: WorkflowContext,
) {
  return yield* Effect.gen(function* () {
    return yield* readArtifact(context, "readinessMarkdown");
  }).pipe(
    Effect.catch(
      Effect.fnUntraced(function* () {
        return undefined;
      }),
    ),
  );
});
const readDecisionArtifact = Effect.fn("readDecisionArtifact")(function* (
  context: WorkflowContext,
  phase: Extract<
    PublishGateDecision,
    {
      publish: false;
    }
  >["phase"],
) {
  return yield* Effect.gen(function* () {
    return yield* readArtifact(
      context,
      phase === "verification" ? "verification" : "readinessMarkdown",
    );
  }).pipe(
    Effect.catch(
      Effect.fnUntraced(function* () {
        return undefined;
      }),
    ),
  );
});
