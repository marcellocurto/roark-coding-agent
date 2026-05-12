import path from "node:path";
import { artifactExists, artifactRelativePath, fixLogRef, inferNextFixPass, readArtifact, verificationBeforeFixRef, type WorkflowContext } from "../workflow/artifacts.ts";
import { createIssuesFromCurationPlan } from "../issue-curation/create-issues.ts";
import { issueCurationPhase } from "../workflow/issue-curation.ts";
import { buildRoarkMarker } from "../github/comments.ts";
import { formatFailureComment, markIssueFailed } from "./failure.ts";
import { publishAutorunResult, type AutorunPublishOptions } from "./publish.ts";
import { decidePublish, parseReadinessStatus, type PublishGateDecision } from "./publish-gate.ts";
import {
  classifyVerificationFailure,
  runVerification,
  verificationFailureReason,
  writeVerificationArtifact,
  writeVerificationBeforeFixArtifact,
  type VerificationResult,
} from "./verification.ts";
import { recordAttemptIssueComment, type AttemptMetadata } from "./attempts.ts";
import { formatPrCreatedComment, publishIssueLedgerComment } from "./ledger-comments.ts";
import type { AutorunBranchPlan } from "./branch.ts";
import type { AutorunIssueCandidate } from "./selection.ts";
import { refreshCopyToWorktree, runLifecycleHook, type LifecycleHooksConfig, type WorkspaceConfig } from "./workspace.ts";

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
  postPrIssueCreation?: typeof createReviewerIssuesAfterPr | undefined;
  publishIssueLedgerComment?: typeof publishIssueLedgerComment | undefined;
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

  const readinessMarkdown = await readReadinessArtifact(workflowContext);
  const readinessStatus = readinessMarkdown ? parseReadinessStatus(readinessMarkdown) : undefined;

  let verification: VerificationResult | undefined;
  if (readinessStatus === "ready-for-pr") {
    await refreshWorkspace({ controlCwd: options.cwd, worktreePath: workflowContext.agentCwd, copyToWorktree: options.workspace?.copyToWorktree });
    await runHook("beforeVerify", options.hooks, workflowContext.agentCwd);
    verification = await verify({ command: options.verifyCommand, cwd: workflowContext.agentCwd });
    await writeVerification(workflowContext, verification);
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
        phase: "pr-created",
        body: formatPrCreatedComment({
          issueNumber: issue.number,
          attempt: attemptMetadata.attempt,
          prUrl,
          attemptMetadataPath,
        }),
      });
      try {
        await postPrIssueCreation({ workflowContext, prUrl });
      } catch (error) {
        console.warn(`Reviewer-generated issue creation failed after PR publication: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return { outcome: "published", outcomeDetail: null };
  }

  if (decision.phase === "verification" && verification) {
    const classification = classifyVerificationFailure(verification);
    const repair = await planVerificationRepair(workflowContext, verification);
    if (repair) {
      console.log(`\nVerification failed; scheduling fix pass ${repair.pass} before terminal failure.`);
      console.log(`Archived failure: ${artifactRelativePath(workflowContext, verificationBeforeFixRef(repair.pass))}`);
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
}): Promise<void> {
  await issueCurationPhase(input.workflowContext, undefined, { prUrl: input.prUrl });
  const result = await createIssuesFromCurationPlan({
    context: input.workflowContext,
    approved: true,
    approvalReason: "Roark opened the autorun pull request successfully",
  });
  if (result.failed.length > 0) {
    console.warn(`Reviewer-generated issue creation reported ${result.failed.length} failure(s). See ${artifactRelativePath(input.workflowContext, "issueCreationResults")}.`);
  }
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

  console.log(`\nNot publishing #${issue.number}: ${decision.phase} — ${decision.reason}.`);
  console.log(`Artifact: ${artifactPath}`);
  console.log(`Attempt: ${attemptMetadataPath}`);
  if (recoveryCommand) console.log(`Continue: ${recoveryCommand}`);

  const comment = formatFailureComment({
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
    removeLabels: [options.inProgressLabel],
    marker,
    existingCommentId: attemptMetadata.githubComments?.issue?.[decision.phase]?.id,
  });
  if (ref) recordAttemptIssueComment(attemptMetadata, decision.phase, ref);
}

async function readReadinessArtifact(context: WorkflowContext): Promise<string | undefined> {
  try {
    return await readArtifact(context, "readiness");
  } catch {
    return undefined;
  }
}

async function readDecisionArtifact(
  context: WorkflowContext,
  phase: Extract<PublishGateDecision, { publish: false }>["phase"],
): Promise<string | undefined> {
  try {
    return await readArtifact(context, phase === "verification" ? "verification" : "readiness");
  } catch {
    return undefined;
  }
}
