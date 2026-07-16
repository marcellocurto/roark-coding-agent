import { artifactRelativePath, readArtifact, type WorkflowContext } from "../workflow/artifacts.ts";
import { buildRoarkMarker } from "../github/comments.ts";
import type { WorkflowRunResult } from "../workflow/phases.ts";
import { recordAttemptIssueComment, type AttemptMetadata } from "./attempts.ts";
import type { AutorunBranchPlan } from "./branch.ts";
import { runPublishGate, type AutorunGateOptions, type PublishGateOutcome } from "./publish-flow.ts";
import { publishPlanningLedgerComments, publishReviewLedgerComments } from "./ledger-comments.ts";
import type { AutorunIssueCandidate } from "./selection.ts";
import { mapTriageVerdictToLabel, markIssueTriageStopped, type MarkIssueTriageStoppedOptions } from "./triage-stop.ts";
import { labelsToRemoveForAutorunTransition } from "./labels.ts";

export type AutorunCompletionOutcome =
  | PublishGateOutcome
  | { outcome: "triage-stopped"; outcomeDetail: string | null };

export interface CompleteAutorunWorkflowInput {
  workflowResult: WorkflowRunResult;
  options: AutorunGateOptions;
  issue: AutorunIssueCandidate;
  branchPlan: AutorunBranchPlan;
  workflowContext: WorkflowContext;
  attemptMetadata: AttemptMetadata;
  attemptMetadataPath: string;
  recoveryCommand?: string | undefined  ;
}

export interface CompleteAutorunWorkflowInjected {
  publishGate?: typeof runPublishGate | undefined;
  markTriageStopped?: ((options: MarkIssueTriageStoppedOptions) => Promise<unknown>) | undefined;
  publishPlanningLedgerComments?: typeof publishPlanningLedgerComments | undefined;
}

export async function completeAutorunWorkflow(
  input: CompleteAutorunWorkflowInput,
  injected: CompleteAutorunWorkflowInjected = {},
): Promise<AutorunCompletionOutcome> {
  const publishGate = injected.publishGate ?? runPublishGate;
  const markTriageStopped = injected.markTriageStopped ?? markIssueTriageStopped;
  const publishPlanning = injected.publishPlanningLedgerComments ?? publishPlanningLedgerComments;

  if (input.workflowResult.status === "triage-stopped") {
    const phase = "triage";
    const marker = buildRoarkMarker({ issueNumber: input.issue.number, attempt: input.attemptMetadata.attempt, phase });
    const ref = await markTriageStopped({
      cwd: input.options.cwd,
      repo: input.options.repo,
      issueNumber: input.issue.number,
      issueUrl: input.issue.url,
      triageVerdict: input.workflowResult.triageVerdict,
      triageArtifactPath: artifactRelativePath(input.workflowContext, "triage"),
      triageArtifactContent: await readArtifactIfExists(input.workflowContext, "triageMarkdown"),
      attemptMetadataPath: input.attemptMetadataPath,
      removeLabels: labelsToRemoveForAutorunTransition({
        issueLabels: input.issue.labels,
        workflow: input.options,
        nextLabel: mapTriageVerdictToLabel(input.workflowResult.triageVerdict),
        knownPresent: [input.options.inProgressLabel, input.options.failureLabel],
      }),
      marker,
      existingCommentId: input.attemptMetadata.githubComments?.issue?.[phase]?.id,
    });
    if (isCommentRef(ref)) recordAttemptIssueComment(input.attemptMetadata, phase, ref);
    return {
      outcome: "triage-stopped",
      outcomeDetail: `triage verdict is "${input.workflowResult.triageVerdict}"`,
    };
  }

  await publishPlanning({
    cwd: input.options.cwd,
    repo: input.options.repo,
    issue: input.issue,
    workflowContext: input.workflowContext,
    attemptMetadata: input.attemptMetadata,
    attemptMetadataPath: input.attemptMetadataPath,
  });

  await publishReviewLedgerComments({
    cwd: input.options.cwd,
    repo: input.options.repo,
    issue: input.issue,
    workflowContext: input.workflowContext,
    attemptMetadata: input.attemptMetadata,
  });

  return publishGate({
    options: input.options,
    issue: input.issue,
    branchPlan: input.branchPlan,
    workflowContext: input.workflowContext,
    attemptMetadata: input.attemptMetadata,
    attemptMetadataPath: input.attemptMetadataPath,
    recoveryCommand: input.recoveryCommand,
  });
}

async function readArtifactIfExists(context: WorkflowContext, artifact: "triageMarkdown"): Promise<string | undefined> {
  try {
    return await readArtifact(context, artifact);
  } catch {
    return undefined;
  }
}

function isCommentRef(value: unknown): value is { id: number; url?: string | undefined; marker: string } {
  return typeof value === "object" && value !== null &&
    typeof (value as { id?: unknown }).id === "number" &&
    typeof (value as { marker?: unknown }).marker === "string";
}
