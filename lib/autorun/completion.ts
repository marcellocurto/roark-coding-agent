import { DateTime } from "effect";
import { Effect } from "effect";
import { type WorkflowContext } from "../workflow/artifacts.ts";
import { readArtifact } from "../workflow/artifacts.ts";
import { buildRoarkMarker } from "../github/comments.ts";
import type { WorkflowRunResult } from "../workflow/phases.ts";
import { recordAttemptIssueComment, type AttemptMetadata } from "./attempts.ts";
import type { AutorunBranchPlan } from "./branch.ts";
import {
  runPublishGate,
  type AutorunGateOptions,
  type PublishGateOutcome,
} from "./publish-flow.ts";
import {
  publishPlanningLedgerComments,
  publishReviewLedgerComments,
} from "./ledger-comments.ts";
import type { AutorunIssueCandidate } from "./selection.ts";
import { mapTriageVerdictToLabel } from "./triage-stop.ts";
import { markIssueTriageStopped } from "./triage-stop.ts";
import { labelsToRemoveForAutorunTransition } from "./labels.ts";
export type AutorunCompletionOutcome =
  | PublishGateOutcome
  | {
      outcome: "triage-stopped";
      outcomeDetail: string | null;
    };
export interface CompleteAutorunWorkflowInput {
  workflowResult: WorkflowRunResult;
  options: AutorunGateOptions;
  issue: AutorunIssueCandidate;
  branchPlan: AutorunBranchPlan;
  workflowContext: WorkflowContext;
  attemptMetadata: AttemptMetadata;
  attemptMetadataPath: string;
  recoveryCommand?: string | undefined;
}
export interface CompleteAutorunWorkflowInjected {
  publishGate?: typeof runPublishGate | undefined;
  markTriageStopped?: typeof markIssueTriageStopped | undefined;
  publishPlanningLedgerComments?:
    | typeof publishPlanningLedgerComments
    | undefined;
}
export const completeAutorunWorkflow = Effect.fn("completeAutorunWorkflow")(
  function* (
    input: CompleteAutorunWorkflowInput,
    injected: CompleteAutorunWorkflowInjected = {},
  ) {
    const publishGate = injected.publishGate ?? runPublishGate;
    const markTriageStopped =
      injected.markTriageStopped ?? markIssueTriageStopped;
    const publishPlanning =
      injected.publishPlanningLedgerComments ?? publishPlanningLedgerComments;
    if (input.workflowResult.status === "triage-stopped") {
      const phase = "triage";
      const marker = buildRoarkMarker({
        issueNumber: input.issue.number,
        attempt: input.attemptMetadata.attempt,
        phase,
      });
      const ref = yield* markTriageStopped({
        cwd: input.options.cwd,
        repo: input.options.repo,
        issueNumber: input.issue.number,
        issueUrl: input.issue.url,
        triageVerdict: input.workflowResult.triageVerdict,
        triageArtifactContent: yield* readArtifactIfExists(
          input.workflowContext,
          "triageMarkdown",
        ),
        removeLabels: labelsToRemoveForAutorunTransition({
          issueLabels: input.issue.labels,
          workflow: input.options,
          nextLabel: mapTriageVerdictToLabel(
            input.workflowResult.triageVerdict,
          ),
          knownPresent: [
            input.options.inProgressLabel,
            input.options.failureLabel,
          ],
        }),
        marker,
        existingCommentId:
          input.attemptMetadata.githubComments?.issue?.[phase]?.id,
      });
      if (ref !== undefined)
        recordAttemptIssueComment(
          input.attemptMetadata,
          phase,
          ref,
          DateTime.formatIso(yield* DateTime.now),
        );
      return {
        outcome: "triage-stopped" as const,
        outcomeDetail: `triage verdict is "${input.workflowResult.triageVerdict}"`,
      } satisfies AutorunCompletionOutcome;
    }
    yield* publishPlanning(
      {
        cwd: input.options.cwd,
        repo: input.options.repo,
        issue: input.issue,
        workflowContext: input.workflowContext,
        attemptMetadata: input.attemptMetadata,
      },
      undefined,
    );
    yield* publishReviewLedgerComments(
      {
        cwd: input.options.cwd,
        repo: input.options.repo,
        issue: input.issue,
        workflowContext: input.workflowContext,
        attemptMetadata: input.attemptMetadata,
      },
      undefined,
    );
    return yield* publishGate(
      {
        options: input.options,
        issue: input.issue,
        branchPlan: input.branchPlan,
        workflowContext: input.workflowContext,
        attemptMetadata: input.attemptMetadata,
        attemptMetadataPath: input.attemptMetadataPath,
        recoveryCommand: input.recoveryCommand,
      },
      undefined,
    );
  },
);
const readArtifactIfExists = Effect.fn("readArtifactIfExists")(function* (
  context: WorkflowContext,
  artifact: "triageMarkdown",
) {
  return yield* Effect.gen(function* () {
    return yield* readArtifact(context, artifact);
  }).pipe(
    Effect.catch(
      Effect.fnUntraced(function* () {
        return undefined;
      }),
    ),
  );
});
