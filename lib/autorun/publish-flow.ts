import path from "node:path";
import { readArtifact, type WorkflowContext } from "../workflow/artifacts.ts";
import { buildRoarkMarker } from "../github/comments.ts";
import { formatFailureComment, markIssueFailed } from "./failure.ts";
import { publishAutorunResult, type AutorunPublishOptions } from "./publish.ts";
import { decidePublish, parseReadinessStatus, type PublishGateDecision } from "./publish-gate.ts";
import {
  runVerification,
  writeVerificationArtifact,
  type VerificationResult,
} from "./verification.ts";
import { recordAttemptIssueComment, type AttemptMetadata } from "./attempts.ts";
import { formatPrCreatedComment, publishIssueLedgerComment } from "./ledger-comments.ts";
import { updateIssueBranchFromBase, type AutorunBranchPlan } from "./branch.ts";
import type { AutorunIssueCandidate } from "./selection.ts";

export type AutorunGateOptions = AutorunPublishOptions & {
  verifyCommand: string;
};

export type PublishGateOutcome = { outcome: "published" | "failed-readiness" | "failed-verification"; outcomeDetail: string | null };

export async function runPublishGate(input: {
  options: AutorunGateOptions;
  issue: AutorunIssueCandidate;
  branchPlan: AutorunBranchPlan;
  workflowContext: WorkflowContext;
  attemptMetadata: AttemptMetadata;
  attemptMetadataPath: string;
  recoveryCommand?: string;
}): Promise<PublishGateOutcome> {
  const { options, issue, branchPlan, workflowContext, attemptMetadata, attemptMetadataPath, recoveryCommand } = input;

  const readinessMarkdown = await readReadinessArtifact(workflowContext);
  const readinessStatus = readinessMarkdown ? parseReadinessStatus(readinessMarkdown) : undefined;

  let verification: VerificationResult | undefined;
  if (readinessStatus === "ready-for-pr") {
    await updateIssueBranchFromBase({
      agentCwd: workflowContext.agentCwd,
      baseBranch: branchPlan.baseBranch,
      preserveUncommitted: true,
    });
    verification = await runVerification({ command: options.verifyCommand, cwd: workflowContext.agentCwd });
    await writeVerificationArtifact(workflowContext, verification);
  }

  const decision = decidePublish({ readinessStatus, verification });

  if (decision.publish) {
    const prUrl = await publishAutorunResult({
      options,
      issue,
      branchPlan,
      workflowContext,
      verification,
      attemptMetadata,
      attemptMetadataPath,
    });
    if (prUrl) {
      await publishIssueLedgerComment({
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
    }
    return { outcome: "published", outcomeDetail: null };
  }

  await handleNonPublish({ options, issue, workflowContext, decision, attemptMetadata, attemptMetadataPath, recoveryCommand });
  return {
    outcome: decision.phase === "verification" ? "failed-verification" : "failed-readiness",
    outcomeDetail: decision.reason,
  };
}

export async function handleNonPublish(input: {
  options: AutorunGateOptions;
  issue: AutorunIssueCandidate;
  workflowContext: WorkflowContext;
  decision: Extract<PublishGateDecision, { publish: false }>;
  attemptMetadata: AttemptMetadata;
  attemptMetadataPath: string;
  recoveryCommand?: string;
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
