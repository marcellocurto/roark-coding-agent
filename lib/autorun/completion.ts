import { artifactRelativePath, type WorkflowContext } from "../workflow/artifacts.ts";
import type { WorkflowRunResult } from "../workflow/phases.ts";
import type { AttemptMetadata } from "./attempts.ts";
import type { AutorunBranchPlan } from "./branch.ts";
import { runPublishGate, type AutorunGateOptions, type PublishGateOutcome } from "./publish-flow.ts";
import type { AutorunIssueCandidate } from "./selection.ts";
import { markIssueTriageStopped, type MarkIssueTriageStoppedOptions } from "./triage-stop.ts";

export type AutorunCompletionOutcome =
  | PublishGateOutcome
  | { outcome: "triage-stopped"; outcomeDetail: string | null };

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
  markTriageStopped?: (options: MarkIssueTriageStoppedOptions) => Promise<void>;
};

export async function completeAutorunWorkflow(
  input: CompleteAutorunWorkflowInput,
  injected: CompleteAutorunWorkflowInjected = {},
): Promise<AutorunCompletionOutcome> {
  const publishGate = injected.publishGate ?? runPublishGate;
  const markTriageStopped = injected.markTriageStopped ?? markIssueTriageStopped;

  if (input.workflowResult.status === "triage-stopped") {
    await markTriageStopped({
      cwd: input.options.cwd,
      repo: input.options.repo,
      issueNumber: input.issue.number,
      issueUrl: input.issue.url,
      triageVerdict: input.workflowResult.triageVerdict,
      triageArtifactPath: artifactRelativePath(input.workflowContext, "triage"),
      attemptMetadataPath: input.attemptMetadataPath,
      removeLabels: [input.options.inProgressLabel, input.options.failureLabel],
    });
    return {
      outcome: "triage-stopped",
      outcomeDetail: `triage verdict is "${input.workflowResult.triageVerdict}"`,
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
