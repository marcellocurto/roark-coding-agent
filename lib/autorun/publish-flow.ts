import { fromLegacyPromise } from "../runtime/application.ts";
import { runApplicationPromise } from "../runtime/application.ts";
import type { ApplicationExecution } from "../runtime/application.ts";
import path from "node:path";
import { presenter } from "../presentation/presenter.ts";
import {
  artifactRelativePath,
  fixLogRef,
  verificationBeforeFixRef,
  type WorkflowContext,
} from "../workflow/artifacts.ts";
import {
  artifactExistsPromise as artifactExists,
  inferNextFixPassPromise as inferNextFixPass,
} from "../workflow/artifacts-promise.ts";
import { readArtifactPromise as readArtifact } from "../workflow/artifacts-promise.ts";
import {
  createIssuesFromCurationPlan,
  type IssueCreationResults,
} from "../issue-curation/create-issues.ts";
import { issueCurationPhase } from "../workflow/issue-curation.ts";
import { buildRoarkMarker } from "../github/comments.ts";
import { formatFailureComment, markIssueFailed } from "./failure.ts";
import {
  publishAutorunResult,
  updatePrBody as updatePublishedPrBody,
  type AutorunPublishOptions,
  type FormatPrBodyFollowUpIssue,
} from "./publish.ts";
import { decidePublish, type PublishGateDecision } from "./publish-gate.ts";
import { parseReadinessResultJson } from "../workflow/readiness.ts";
import {
  classifyVerificationFailure,
  runVerificationPromise,
  verificationFailureReason,
  writeVerificationArtifact,
  writeVerificationBeforeFixArtifact,
  type VerificationResult,
} from "./verification.ts";
import { recordAttemptIssueComment, type AttemptMetadata } from "./attempts.ts";
import {
  formatPrCreatedComment,
  formatReadinessLedgerComment,
  publishIssueLedgerComment,
} from "./ledger-comments.ts";
import type { AutorunBranchPlan } from "./branch.ts";
import type { AutorunIssueCandidate } from "./selection.ts";
import {
  refreshCopyToWorktree,
  runLifecycleHookPromise,
  type LifecycleHooksConfig,
  type WorkspaceConfig,
} from "./workspace.ts";
import { labelsToRemoveForAutorunTransition } from "./labels.ts";
import { runPrReviewPromise } from "../pr-review/workflow.ts";

export type AutorunGateOptions = AutorunPublishOptions & {
  verifyCommand: string;
  hooks?: LifecycleHooksConfig | undefined;
  workspace?: WorkspaceConfig | undefined;
};

export type PublishGateOutcome =
  | {
      outcome: "published" | "failed-readiness" | "failed-verification";
      outcomeDetail: string | null;
    }
  | { outcome: "verification-needs-fix"; outcomeDetail: string; pass: number };

type AutomaticPrReviewRunner = (
  ...args: Parameters<typeof runPrReviewPromise>
) => Promise<{
  outcome: "completed" | "blocked";
  context: { reviewDirRelative: string };
}>;

export interface RunPublishGateInjected {
  refreshCopyToWorktree?: typeof refreshCopyToWorktree | undefined;
  runLifecycleHookPromise?: typeof runLifecycleHookPromise | undefined;
  runVerificationPromise?: typeof runVerificationPromise | undefined;
  writeVerificationArtifact?: typeof writeVerificationArtifact | undefined;
  handleNonPublish?: typeof handleNonPublish | undefined;
  publishAutorunResult?: typeof publishAutorunResult | undefined;
  postPrIssueCreation?:
    | ((
        ...args: Parameters<typeof createReviewerIssuesAfterPr>
      ) => Promise<IssueCreationResults | undefined>)
    | undefined;
  publishIssueLedgerComment?: typeof publishIssueLedgerComment | undefined;
  updatePrBody?: typeof updatePublishedPrBody | undefined;
  runPrReviewPromise?: AutomaticPrReviewRunner | undefined;
}

export async function runPublishGate(
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
  application?: ApplicationExecution,
): Promise<PublishGateOutcome> {
  if (!application)
    return runApplicationPromise(
      fromLegacyPromise((application) =>
        runPublishGate(input, injected, application),
      ),
      application,
    );

  const {
    options,
    issue,
    branchPlan,
    workflowContext,
    attemptMetadata,
    attemptMetadataPath,
    recoveryCommand,
  } = input;
  const refreshWorkspace =
    injected.refreshCopyToWorktree ?? refreshCopyToWorktree;
  const runHook = injected.runLifecycleHookPromise ?? runLifecycleHookPromise;
  const verify = injected.runVerificationPromise ?? runVerificationPromise;
  const writeVerification =
    injected.writeVerificationArtifact ?? writeVerificationArtifact;
  const nonPublish = injected.handleNonPublish ?? handleNonPublish;
  const publishResult = injected.publishAutorunResult ?? publishAutorunResult;
  const postPrIssueCreation =
    injected.postPrIssueCreation ?? createReviewerIssuesAfterPr;
  const publishLedger =
    injected.publishIssueLedgerComment ?? publishIssueLedgerComment;
  const editPrBody = injected.updatePrBody ?? updatePublishedPrBody;
  const reviewPr = injected.runPrReviewPromise ?? runPrReviewPromise;

  const readinessResult = await readReadinessResult(
    workflowContext,
    application,
  );
  const readinessStatus = readinessResult?.decision.status;
  const readinessMarkdown = await readReadinessMarkdown(
    workflowContext,
    application,
  );

  let verification: VerificationResult | undefined;
  if (readinessStatus === "ready-for-pr") {
    await refreshWorkspace(
      {
        controlCwd: options.cwd,
        worktreePath: workflowContext.agentCwd,
        copyToWorktree: options.workspace?.copyToWorktree,
      },
      application,
    );
    await runHook(
      "beforeVerify",
      options.hooks,
      workflowContext.agentCwd,
      undefined,
      application,
    );
    verification = await verify(
      {
        command: options.verifyCommand,
        cwd: workflowContext.agentCwd,
        display: {
          target: `#${workflowContext.issueNumber}`,
          repository: workflowContext.repo,
        },
      },
      application,
    );
    await writeVerification(workflowContext, verification, application);
    presenter(application).artifact(
      artifactRelativePath(workflowContext, "verification"),
    );
  }

  let decision = decidePublish({ readinessStatus, verification });

  if (decision.publish) {
    const publishedPr = await publishResult(
      {
        options,
        issue,
        branchPlan,
        workflowContext,
        verification,
        attemptMetadata,
        attemptMetadataPath,
      },
      application,
    );
    await publishLedger(
      {
        cwd: options.cwd,
        repo: options.repo,
        issueNumber: issue.number,
        attemptMetadata,
        phase: "readiness",
        body: formatReadinessLedgerComment({
          issueNumber: issue.number,
          attempt: attemptMetadata.attempt,
          artifactContent: readinessMarkdown ?? "",
        }),
      },
      application,
    );
    await publishLedger(
      {
        cwd: options.cwd,
        repo: options.repo,
        issueNumber: issue.number,
        attemptMetadata,
        phase: "pr-created",
        body: formatPrCreatedComment({
          issueNumber: issue.number,
          attempt: attemptMetadata.attempt,
          prUrl: publishedPr.url,
        }),
      },
      application,
    );
    let issueCreationResults: IssueCreationResults | undefined;
    try {
      issueCreationResults =
        (await postPrIssueCreation(
          { workflowContext, prUrl: publishedPr.url },
          application,
        )) ?? undefined;
    } catch (error) {
      presenter(application).warning(
        `reviewer-generated issue creation failed after PR publication: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    try {
      await editPrBody(
        {
          cwd: options.cwd,
          repo: options.repo,
          pr: publishedPr.url,
          issueNumber: issue.number,
          workflowContext,
          verification,
          attemptMetadata,
          followUpIssues: issueCreationResultsToFollowUps(issueCreationResults),
        },
        application,
      );
    } catch (error) {
      presenter(application).warning(
        `failed to update PR body with final Roark ledger details: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    try {
      const review = await reviewPr(
        {
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
        },
        undefined,
        application,
      );
      presenter(application).artifact(review.context.reviewDirRelative);
      if (review.outcome === "blocked") {
        presenter(application).warning(
          `automatic PR review for #${publishedPr.number} was blocked because the PR changed during review; review artifacts were preserved`,
        );
      }
    } catch (error) {
      presenter(application).warning(
        `automatic PR review failed after PR #${publishedPr.number} was published: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return { outcome: "published", outcomeDetail: null };
  }

  if (decision.phase === "verification" && verification) {
    const classification = classifyVerificationFailure(verification);
    const repair = await planVerificationRepair(
      workflowContext,
      verification,
      application,
    );
    if (repair) {
      presenter(application).line(
        `Verification failed; scheduling fix pass ${repair.pass} before terminal failure`,
      );
      presenter(application).artifact(
        artifactRelativePath(
          workflowContext,
          verificationBeforeFixRef(repair.pass),
        ),
      );
      return {
        outcome: "verification-needs-fix",
        outcomeDetail: decision.reason,
        pass: repair.pass,
      };
    }
    decision = {
      ...decision,
      reason: classification.repairable
        ? `Verification failed after ${workflowContext.maxFixPasses} fix passes: ${verificationFailureReason(verification)}`
        : verificationFailureReason(verification),
    };
    presenter(application).line(
      `ACTION user action required: ${classification.recoveryGuidance ?? decision.reason}`,
    );
  }

  if (decision.phase === "verification") {
    await publishLedger(
      {
        cwd: options.cwd,
        repo: options.repo,
        issueNumber: issue.number,
        attemptMetadata,
        phase: "readiness",
        body: formatReadinessLedgerComment({
          issueNumber: issue.number,
          attempt: attemptMetadata.attempt,
          artifactContent: readinessMarkdown ?? "",
          recoveryCommand,
        }),
      },
      application,
    );
  }

  await nonPublish(
    {
      options,
      issue,
      workflowContext,
      decision,
      attemptMetadata,
      attemptMetadataPath,
      recoveryCommand,
    },
    application,
  );
  return {
    outcome:
      decision.phase === "verification"
        ? "failed-verification"
        : "failed-readiness",
    outcomeDetail: decision.reason,
  };
}

export async function createReviewerIssuesAfterPr(
  input: {
    workflowContext: WorkflowContext;
    prUrl: string;
  },
  application?: ApplicationExecution,
): Promise<IssueCreationResults> {
  if (!application)
    return runApplicationPromise(
      fromLegacyPromise((application) =>
        createReviewerIssuesAfterPr(input, application),
      ),
      application,
    );

  await issueCurationPhase(
    input.workflowContext,
    undefined,
    { prUrl: input.prUrl },
    application,
  );
  const result = await createIssuesFromCurationPlan(
    {
      context: input.workflowContext,
      approved: true,
      approvalReason: "Roark opened the autorun pull request successfully",
    },
    application,
  );
  if (result.failed.length > 0) {
    presenter(application).warning(
      `reviewer-generated issue creation reported ${result.failed.length} failure(s)`,
    );
    presenter(application).artifact(
      artifactRelativePath(input.workflowContext, "issueCreationResults"),
    );
  }
  return result;
}

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

export async function planVerificationRepair(
  context: WorkflowContext,
  verification: VerificationResult,
  application?: ApplicationExecution,
): Promise<{ pass: number } | undefined> {
  if (!classifyVerificationFailure(verification).repairable) return undefined;
  const pass = await inferNextVerificationRepairPass(context, application);
  if (pass > context.maxFixPasses) return undefined;
  await writeVerificationBeforeFixArtifact(
    context,
    pass,
    verification,
    application,
  );
  return { pass };
}

async function inferNextVerificationRepairPass(
  context: WorkflowContext,
  application?: ApplicationExecution,
): Promise<number> {
  try {
    return await inferNextFixPass(context, application);
  } catch {
    for (let pass = 1; ; pass++) {
      if (!(await artifactExists(context, fixLogRef(pass), application)))
        return pass;
    }
  }
}

export async function handleNonPublish(
  input: {
    options: AutorunGateOptions;
    issue: AutorunIssueCandidate;
    workflowContext: WorkflowContext;
    decision: Extract<PublishGateDecision, { publish: false }>;
    attemptMetadata: AttemptMetadata;
    attemptMetadataPath: string;
    recoveryCommand?: string | undefined;
  },
  application?: ApplicationExecution,
): Promise<void> {
  if (!application)
    return runApplicationPromise(
      fromLegacyPromise((application) => handleNonPublish(input, application)),
      application,
    );

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
  const artifactContent = await readDecisionArtifact(
    workflowContext,
    decision.phase,
    application,
  );

  presenter(application).line(
    `Not publishing #${issue.number}: ${decision.phase} — ${decision.reason}.`,
  );
  presenter(application).artifact(artifactPath);
  presenter(application).artifact(attemptMetadataPath);
  if (recoveryCommand) presenter(application).recovery(recoveryCommand);

  const comment =
    decision.phase === "readiness"
      ? formatReadinessLedgerComment({
          issueNumber: issue.number,
          attempt: attemptMetadata.attempt,
          artifactContent: artifactContent ?? "",
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
    phase: decision.phase,
  });
  const ref = await markIssueFailed(
    {
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
        attemptMetadata.githubComments?.issue?.[decision.phase]?.id,
    },
    application,
  );
  if (ref) recordAttemptIssueComment(attemptMetadata, decision.phase, ref);
}

async function readReadinessResult(
  context: WorkflowContext,
  application?: ApplicationExecution,
) {
  try {
    return parseReadinessResultJson(
      await readArtifact(context, "readiness", application),
    );
  } catch {
    return undefined;
  }
}

async function readReadinessMarkdown(
  context: WorkflowContext,
  application?: ApplicationExecution,
): Promise<string | undefined> {
  try {
    return await readArtifact(context, "readinessMarkdown", application);
  } catch {
    return undefined;
  }
}

async function readDecisionArtifact(
  context: WorkflowContext,
  phase: Extract<PublishGateDecision, { publish: false }>["phase"],
  application?: ApplicationExecution,
): Promise<string | undefined> {
  try {
    return await readArtifact(
      context,
      phase === "verification" ? "verification" : "readinessMarkdown",
      application,
    );
  } catch {
    return undefined;
  }
}
