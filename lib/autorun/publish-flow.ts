import path from "node:path";
import { presenter } from "../presentation/presenter.ts";
import { artifactExists, artifactRelativePath, fixLogRef, inferNextFixPass, readArtifact, verificationBeforeFixRef, type WorkflowContext } from "../workflow/artifacts.ts";
import { createIssuesFromCurationPlan, type IssueCreationResults } from "../issue-curation/create-issues.ts";
import { issueCurationPhase } from "../workflow/issue-curation.ts";
import { buildRoarkMarker } from "../github/comments.ts";
import { formatFailureComment, markIssueFailed } from "./failure.ts";
import { publishAutorunResult, updatePrBody as updatePublishedPrBody, type AutorunPublishOptions, type FormatPrBodyFollowUpIssue } from "./publish.ts";
import { decidePublish, type PublishGateDecision } from "./publish-gate.ts";
import { parseReadinessResultJson } from "../workflow/readiness.ts";
import {
  classifyVerificationFailure,
  runVerification,
  verificationFailureReason,
  writeVerificationArtifact,
  writeVerificationBeforeFixArtifact,
  type VerificationResult,
} from "./verification.ts";
import { recordAttemptIssueComment, type AttemptMetadata } from "./attempts.ts";
import { formatPrCreatedComment, formatReadinessLedgerComment, publishIssueLedgerComment } from "./ledger-comments.ts";
import type { AutorunBranchPlan } from "./branch.ts";
import type { AutorunIssueCandidate } from "./selection.ts";
import { refreshCopyToWorktree, runLifecycleHook, type LifecycleHooksConfig, type WorkspaceConfig } from "./workspace.ts";
import { labelsToRemoveForAutorunTransition } from "./labels.ts";

export type AutorunGateOptions = AutorunPublishOptions & {
  verifyCommand: string;
  hooks?: LifecycleHooksConfig | undefined  ;
  workspace?: WorkspaceConfig | undefined  ;
};

export type PublishGateOutcome =
  | { outcome: "published" | "failed-readiness" | "failed-verification"; outcomeDetail: string | null }
  | { outcome: "verification-needs-fix"; outcomeDetail: string; pass: number };

export interface RunPublishGateInjected {
  refreshCopyToWorktree?: typeof refreshCopyToWorktree | undefined;
  runLifecycleHook?: typeof runLifecycleHook | undefined;
  runVerification?: typeof runVerification | undefined;
  writeVerificationArtifact?: typeof writeVerificationArtifact | undefined;
  handleNonPublish?: typeof handleNonPublish | undefined;
  publishAutorunResult?: typeof publishAutorunResult | undefined;
  postPrIssueCreation?: ((input: { workflowContext: WorkflowContext; prUrl: string }) => Promise<IssueCreationResults | undefined>) | undefined;
  publishIssueLedgerComment?: typeof publishIssueLedgerComment | undefined;
  updatePrBody?: typeof updatePublishedPrBody | undefined;
}

export async function runPublishGate(input: {
  options: AutorunGateOptions;
  issue: AutorunIssueCandidate;
  branchPlan: AutorunBranchPlan;
  workflowContext: WorkflowContext;
  attemptMetadata: AttemptMetadata;
  attemptMetadataPath: string;
  recoveryCommand?: string | undefined  ;
}, injected: RunPublishGateInjected = {}): Promise<PublishGateOutcome> {
  const { options, issue, branchPlan, workflowContext, attemptMetadata, attemptMetadataPath, recoveryCommand } = input;
  const refreshWorkspace = injected.refreshCopyToWorktree ?? refreshCopyToWorktree;
  const runHook = injected.runLifecycleHook ?? runLifecycleHook;
  const verify = injected.runVerification ?? runVerification;
  const writeVerification = injected.writeVerificationArtifact ?? writeVerificationArtifact;
  const nonPublish = injected.handleNonPublish ?? handleNonPublish;
  const publishResult = injected.publishAutorunResult ?? publishAutorunResult;
  const postPrIssueCreation = injected.postPrIssueCreation ?? createReviewerIssuesAfterPr;
  const publishLedger = injected.publishIssueLedgerComment ?? publishIssueLedgerComment;
  const editPrBody = injected.updatePrBody ?? updatePublishedPrBody;

  const readinessResult = await readReadinessResult(workflowContext);
  const readinessStatus = readinessResult?.decision.status;
  const readinessMarkdown = await readReadinessMarkdown(workflowContext);

  let verification: VerificationResult | undefined;
  if (readinessStatus === "ready-for-pr") {
    await refreshWorkspace({ controlCwd: options.cwd, worktreePath: workflowContext.agentCwd, copyToWorktree: options.workspace?.copyToWorktree });
    await runHook("beforeVerify", options.hooks, workflowContext.agentCwd);
    verification = await verify({
      command: options.verifyCommand,
      cwd: workflowContext.agentCwd,
      display: { target: `#${workflowContext.issueNumber}`, repository: workflowContext.repo },
    });
    await writeVerification(workflowContext, verification);
    presenter().artifact(artifactRelativePath(workflowContext, "verification"));
  }

  let decision = decidePublish({ readinessStatus, verification });

  if (decision.publish) {
    const prUrl = await publishResult({
      options,
      issue,
      branchPlan,
      workflowContext,
      verification,
      attemptMetadata,
      attemptMetadataPath,
    });
    if (prUrl) {
      await publishLedger({
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
      });
      await publishLedger({
        cwd: options.cwd,
        repo: options.repo,
        issueNumber: issue.number,
        attemptMetadata,
        phase: "pr-created",
        body: formatPrCreatedComment({
          issueNumber: issue.number,
          attempt: attemptMetadata.attempt,
          prUrl,
          attemptMetadataPath,
        }),
      });
      let issueCreationResults: IssueCreationResults | undefined;
      try {
        issueCreationResults = await postPrIssueCreation({ workflowContext, prUrl }) ?? undefined;
      } catch (error) {
        presenter().warning(`reviewer-generated issue creation failed after PR publication: ${error instanceof Error ? error.message : String(error)}`);
      }
      try {
        await editPrBody({
          cwd: options.cwd,
          repo: options.repo,
          pr: prUrl,
          issueNumber: issue.number,
          workflowContext,
          verification,
          attemptMetadata,
          followUpIssues: issueCreationResultsToFollowUps(issueCreationResults),
        });
      } catch (error) {
        presenter().warning(`failed to update PR body with final Roark ledger details: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return { outcome: "published", outcomeDetail: null };
  }

  if (decision.phase === "verification" && verification) {
    const classification = classifyVerificationFailure(verification);
    const repair = await planVerificationRepair(workflowContext, verification);
    if (repair) {
      presenter().line(`Verification failed; scheduling fix pass ${repair.pass} before terminal failure`);
      presenter().artifact(artifactRelativePath(workflowContext, verificationBeforeFixRef(repair.pass)));
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
    presenter().line(`ACTION user action required: ${classification.recoveryGuidance ?? decision.reason}`);
  }

  if (decision.phase === "verification") {
    await publishLedger({
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
    });
  }

  await nonPublish({ options, issue, workflowContext, decision, attemptMetadata, attemptMetadataPath, recoveryCommand });
  return {
    outcome: decision.phase === "verification" ? "failed-verification" : "failed-readiness",
    outcomeDetail: decision.reason,
  };
}

export async function createReviewerIssuesAfterPr(input: {
  workflowContext: WorkflowContext;
  prUrl: string;
}): Promise<IssueCreationResults> {
  await issueCurationPhase(input.workflowContext, undefined, { prUrl: input.prUrl });
  const result = await createIssuesFromCurationPlan({
    context: input.workflowContext,
    approved: true,
    approvalReason: "Roark opened the autorun pull request successfully",
  });
  if (result.failed.length > 0) {
    presenter().warning(`reviewer-generated issue creation reported ${result.failed.length} failure(s)`);
    presenter().artifact(artifactRelativePath(input.workflowContext, "issueCreationResults"));
  }
  return result;
}

function issueCreationResultsToFollowUps(result: IssueCreationResults | undefined): FormatPrBodyFollowUpIssue[] | undefined {
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
): Promise<{ pass: number } | undefined> {
  if (!classifyVerificationFailure(verification).repairable) return undefined;
  const pass = inferNextVerificationRepairPass(context);
  if (pass > context.maxFixPasses) return undefined;
  await writeVerificationBeforeFixArtifact(context, pass, verification);
  return { pass };
}

function inferNextVerificationRepairPass(context: WorkflowContext): number {
  try {
    return inferNextFixPass(context);
  } catch {
    for (let pass = 1; ; pass++) {
      if (!artifactExists(context, fixLogRef(pass))) return pass;
    }
  }
}

export async function handleNonPublish(input: {
  options: AutorunGateOptions;
  issue: AutorunIssueCandidate;
  workflowContext: WorkflowContext;
  decision: Extract<PublishGateDecision, { publish: false }>;
  attemptMetadata: AttemptMetadata;
  attemptMetadataPath: string;
  recoveryCommand?: string | undefined  ;
}): Promise<void> {
  const { options, issue, workflowContext, decision, attemptMetadata, attemptMetadataPath, recoveryCommand } = input;
  const artifactPath = path.join(workflowContext.runDirRelative, decision.artifactPath);
  const artifactContent = await readDecisionArtifact(workflowContext, decision.phase);

  presenter().line(`Not publishing #${issue.number}: ${decision.phase} — ${decision.reason}.`);
  presenter().artifact(artifactPath);
  presenter().artifact(attemptMetadataPath);
  if (recoveryCommand) presenter().recovery(recoveryCommand);

  const comment = decision.phase === "readiness"
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
      artifactPath,
      artifactContent,
      attemptMetadataPath,
      recoveryCommand,
    });

  const marker = buildRoarkMarker({ issueNumber: issue.number, attempt: attemptMetadata.attempt, phase: decision.phase });
  const ref = await markIssueFailed({
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
    existingCommentId: attemptMetadata.githubComments?.issue?.[decision.phase]?.id,
  });
  if (ref) recordAttemptIssueComment(attemptMetadata, decision.phase, ref);
}

async function readReadinessResult(context: WorkflowContext) {
  try {
    return parseReadinessResultJson(await readArtifact(context, "readiness"));
  } catch {
    return undefined;
  }
}

async function readReadinessMarkdown(context: WorkflowContext): Promise<string | undefined> {
  try {
    return await readArtifact(context, "readinessMarkdown");
  } catch {
    return undefined;
  }
}

async function readDecisionArtifact(
  context: WorkflowContext,
  phase: Extract<PublishGateDecision, { publish: false }>["phase"],
): Promise<string | undefined> {
  try {
    return await readArtifact(context, phase === "verification" ? "verification" : "readinessMarkdown");
  } catch {
    return undefined;
  }
}
