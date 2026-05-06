import path from "node:path";
import { readArtifact, type WorkflowContext } from "../workflow/artifacts.ts";
import { formatFailureComment, markIssueFailed } from "./failure.ts";
import { publishAutorunResult, type AutorunPublishOptions } from "./publish.ts";
import { decidePublish, parseReadinessStatus, type PublishGateDecision } from "./publish-gate.ts";
import {
  runVerification,
  writeVerificationArtifact,
  type VerificationResult,
} from "./verification.ts";
import type { AttemptMetadata } from "./attempts.ts";
import type { AutorunBranchPlan } from "./branch.ts";
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
    verification = await runVerification({ command: options.verifyCommand, cwd: workflowContext.cwd });
    await writeVerificationArtifact(workflowContext, verification);
  }

  const decision = decidePublish({ readinessStatus, verification });

  if (decision.publish) {
    await publishAutorunResult({
      options,
      issue,
      branchPlan,
      workflowContext,
      verification,
      attemptMetadata,
      attemptMetadataPath,
    });
    return { outcome: "published", outcomeDetail: null };
  }

  await handleNonPublish({ options, issue, workflowContext, decision, attemptMetadataPath, recoveryCommand });
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
  attemptMetadataPath: string;
  recoveryCommand?: string;
}): Promise<void> {
  const { options, issue, workflowContext, decision, attemptMetadataPath, recoveryCommand } = input;
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

  await markIssueFailed({
    cwd: options.cwd,
    repo: options.repo,
    issueNumber: issue.number,
    label: options.failureLabel,
    comment,
    removeLabels: [options.inProgressLabel],
  });
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
