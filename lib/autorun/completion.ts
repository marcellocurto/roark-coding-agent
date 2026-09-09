import {
  parseContinuationResult,
  formatContinuationReview,
} from "../issue-continuation/result.ts";
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
import {
  mapStopVerdictToLabel,
  markIssueWorkflowStopped,
} from "./workflow-stop.ts";
import {
  formatImplementationPlanMarkdown,
  parseImplementationPlanResultJson,
} from "../implementation-plan/result.ts";
import {
  formatChangeReportMarkdown,
  parseChangeReportJson,
} from "../change-report/result.ts";
import type { TriageVerdict } from "../triage/result.ts";
import { labelsToRemoveForAutorunTransition } from "./labels.ts";
export type AutorunCompletionOutcome =
  | PublishGateOutcome
  | {
      outcome:
        | "triage-stopped"
        | "planning-stopped"
        | "execution-stopped"
        | "continuation-stopped";
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
  markWorkflowStopped?: typeof markIssueWorkflowStopped | undefined;
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
    const markWorkflowStopped =
      injected.markWorkflowStopped ?? markIssueWorkflowStopped;
    const publishPlanning =
      injected.publishPlanningLedgerComments ?? publishPlanningLedgerComments;
    const result = input.workflowResult;
    if (
      result.status === "continuation-stopped" ||
      result.status === "triage-stopped" ||
      result.status === "planning-stopped" ||
      result.status === "execution-stopped"
    ) {
      const stop = yield* workflowStopDetails(input.workflowContext, result);
      const { phase, verdict, artifactContent } = stop;
      const marker = buildRoarkMarker({
        issueNumber: input.issue.number,
        attempt: input.attemptMetadata.attempt,
        phase,
      });
      const ref = yield* markWorkflowStopped({
        cwd: input.options.cwd,
        repo: input.options.repo,
        issueNumber: input.issue.number,
        issueUrl: input.issue.url,
        verdict,
        artifactContent,
        recoveryCommand: input.recoveryCommand,
        removeLabels: labelsToRemoveForAutorunTransition({
          issueLabels: input.issue.labels,
          workflow: input.options,
          nextLabel: mapStopVerdictToLabel(verdict),
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
        outcome: result.status,
        outcomeDetail: `${phase} verdict is "${verdict}"`,
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

const workflowStopDetails = Effect.fn("workflowStopDetails")(function* (
  context: WorkflowContext,
  result: Extract<
    WorkflowRunResult,
    {
      status:
        | "triage-stopped"
        | "planning-stopped"
        | "execution-stopped"
        | "continuation-stopped";
    }
  >,
) {
  if (result.status === "continuation-stopped") {
    const review = yield* parseContinuationResult(
      yield* readArtifact(context, "continuationReview"),
    );
    return {
      phase: "continuation",
      verdict:
        review.blockingQuestions.length > 0 ||
        review.resolutions.some((item) => item.status === "unresolved")
          ? ("needs-human-decision" as const)
          : ("blocked" as const),
      artifactContent: formatContinuationReview(review),
    };
  }
  if (result.status === "triage-stopped")
    return {
      phase: "triage",
      verdict: result.triageVerdict,
      artifactContent: yield* readArtifactIfExists(context, "triageMarkdown"),
    };
  if (result.status === "planning-stopped") {
    const artifact = result.planningArtifact ?? "implementationPlan";
    const plan = yield* parseImplementationPlanResultJson(
      yield* readArtifact(context, artifact),
    );
    return {
      phase:
        artifact === "implementationPlanDraft"
          ? "implementation-plan-draft"
          : "implementation-plan",
      verdict: stopVerdict(plan),
      artifactContent: formatImplementationPlanMarkdown(
        plan,
        artifact === "implementationPlanDraft" ? "draft" : "final",
      ),
    };
  }
  const report = yield* parseChangeReportJson(
    yield* readArtifact(context, result.artifact),
  );
  return {
    phase:
      typeof result.artifact === "string"
        ? "implementation"
        : `${result.artifact.name}-${result.artifact.pass}`,
    verdict: stopVerdict(report),
    artifactContent: formatChangeReportMarkdown(report, "Execution Stopped"),
  };
});
function stopVerdict(result: {
  blockingQuestions: readonly string[];
}): Exclude<TriageVerdict, "proceed" | "reject"> {
  return result.blockingQuestions.length > 0
    ? "needs-human-decision"
    : "blocked";
}
