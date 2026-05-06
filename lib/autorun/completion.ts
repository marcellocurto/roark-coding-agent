import { artifactRelativePath, type WorkflowContext } from "../workflow/artifacts.ts";
import type { WorkflowRunResult } from "../workflow/phases.ts";
import type { AttemptMetadata } from "./attempts.ts";
import type { AutorunBranchPlan } from "./branch.ts";
import { runPublishGate, type AutorunGateOptions, type PublishGateOutcome } from "./publish-flow.ts";
import type { AutorunIssueCandidate } from "./selection.ts";
import {
  isTriageNoopWorkflowResult,
  markIssueTriageNoop,
  triageNoopOutcomeDetail,
  type MarkIssueTriageNoopOptions,
} from "./triage-noop.ts";

export type AutorunCompletionOutcome =
  | PublishGateOutcome
  | { outcome: "noop-triage"; outcomeDetail: string | null };

export type CompleteAutorunWorkflowInput = {
  workflowResult: WorkflowRunResult;
  options: AutorunGateOptions;
  issue: AutorunIssueCandidate;
  branchPlan: AutorunBranchPlan;
  workflowContext: WorkflowContext;
  attemptMetadata: AttemptMetadata;
  attemptMetadataPath: string;
  recoveryCommand?: string;
};

export type CompleteAutorunWorkflowInjected = {
  publishGate?: typeof runPublishGate;
  markTriageNoop?: (options: MarkIssueTriageNoopOptions) => Promise<void>;
};

export async function completeAutorunWorkflow(
  input: CompleteAutorunWorkflowInput,
  injected: CompleteAutorunWorkflowInjected = {},
): Promise<AutorunCompletionOutcome> {
  const publishGate = injected.publishGate ?? runPublishGate;
  const markTriageNoop = injected.markTriageNoop ?? markIssueTriageNoop;

  if (isTriageNoopWorkflowResult(input.workflowResult)) {
    await markTriageNoop({
      cwd: input.options.cwd,
      repo: input.options.repo,
      issue: input.issue,
      verdict: input.workflowResult.verdict,
      inProgressLabel: input.options.inProgressLabel,
      failureLabel: input.options.failureLabel,
      triageArtifactPath: artifactRelativePath(input.workflowContext, "triage"),
      attemptMetadataPath: input.attemptMetadataPath,
    });
    return {
      outcome: "noop-triage",
      outcomeDetail: triageNoopOutcomeDetail(input.workflowResult.verdict),
    };
  }

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
