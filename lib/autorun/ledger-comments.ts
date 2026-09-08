import { GitHub } from "../github/service.ts";
import { Presentation } from "../runtime/services.ts";
import { Effect } from "effect";
import {
  reviewARef,
  reviewBRef,
  type ArtifactRef,
  type WorkflowContext,
} from "../workflow/artifacts.ts";
import {
  artifactExists,
  latestCompleteReviewCycle,
} from "../workflow/artifacts.ts";
import { readArtifact } from "../workflow/artifacts.ts";
import { validateAgentArtifact } from "../workflow/artifact-validation.ts";
import { buildRoarkMarker } from "../github/comments.ts";
import { recordAttemptIssueComment, type AttemptMetadata } from "./attempts.ts";
import { sanitizePublicMarkdown } from "./public-output.ts";
import type { AutorunIssueCandidate } from "./selection.ts";
import {
  formatReviewResultMarkdown,
  parseReviewResultJson,
  type ReviewFindingSource,
} from "../review/result.ts";
export type LedgerCommentPhase = string;
export interface LedgerCommentArtifactInput {
  issueNumber: number;
  attempt: number;
  artifactContent: string;
}
export type ReadinessLedgerCommentInput = Pick<
  LedgerCommentArtifactInput,
  "issueNumber" | "attempt" | "artifactContent"
> & {
  recoveryCommand?: string | undefined;
};
export function formatAttemptStartComment(input: {
  issueNumber: number;
  attempt: number;
  branchName: string;
  assignee?: string | undefined;
}): string {
  const marker = buildRoarkMarker({
    issueNumber: input.issueNumber,
    attempt: input.attempt,
    phase: "attempt-start",
  });
  const actor = input.assignee ? `@${input.assignee}` : "Roark";
  const lines = [
    marker,
    `## Roark attempt ${input.attempt} started`,
    "",
    `${actor} is attempting this issue in branch \`${input.branchName}\`.`,
  ];
  return `${lines.join("\n")}\n`;
}
export type PublishIssueLedgerCommentFn = typeof publishIssueLedgerComment;
export const publishPlanningLedgerComments = Effect.fn(
  "publishPlanningLedgerComments",
)(function* (
  input: {
    cwd: string;
    repo?: string | undefined;
    issue: AutorunIssueCandidate;
    workflowContext: WorkflowContext;
    attemptMetadata: AttemptMetadata;
  },
  injected: {
    publishIssueLedgerComment?: PublishIssueLedgerCommentFn;
  } = {},
) {
  const publishLedgerComment =
    injected.publishIssueLedgerComment ?? publishIssueLedgerComment;
  yield* publishArtifactLedgerComment({
    ...input,
    artifact: "triage",
    renderedArtifact: "triageMarkdown",
    phase: "triage",
    formatBody: (artifactContent) =>
      formatTriageLedgerComment({
        issueNumber: input.issue.number,
        attempt: input.attemptMetadata.attempt,
        artifactContent,
      }),
    publishLedgerComment,
  });
  yield* publishArtifactLedgerComment({
    ...input,
    artifact: "implementationPlan",
    renderedArtifact: "implementationPlanMarkdown",
    phase: "implementation-plan",
    formatBody: (artifactContent) =>
      formatImplementationPlanLedgerComment({
        issueNumber: input.issue.number,
        attempt: input.attemptMetadata.attempt,
        artifactContent,
      }),
    publishLedgerComment,
  });
});
export const publishReviewLedgerComments = Effect.fn(
  "publishReviewLedgerComments",
)(function* (
  input: {
    cwd: string;
    repo?: string | undefined;
    issue: AutorunIssueCandidate;
    workflowContext: WorkflowContext;
    attemptMetadata: AttemptMetadata;
  },
  injected: {
    publishIssueLedgerComment?: PublishIssueLedgerCommentFn;
  } = {},
) {
  const publishLedgerComment =
    injected.publishIssueLedgerComment ?? publishIssueLedgerComment;
  const latestCycle = yield* latestCompleteReviewCycle(input.workflowContext);
  if (latestCycle === undefined) return;
  yield* publishReviewLedgerComment({
    ...input,
    artifact: reviewARef(latestCycle),
    phase: `review-a-${latestCycle}`,
    title: `Review A pass ${latestCycle}`,
    markerPhase: "review-a",
    publishLedgerComment,
  });
  yield* publishReviewLedgerComment({
    ...input,
    artifact: reviewBRef(latestCycle),
    phase: `review-b-${latestCycle}`,
    title: `Review B pass ${latestCycle}`,
    markerPhase: "review-b",
    publishLedgerComment,
  });
});
export const publishIssueLedgerComment = Effect.fn("publishIssueLedgerComment")(
  function* (input: {
    cwd: string;
    repo?: string | undefined;
    issueNumber: number;
    attemptMetadata: AttemptMetadata;
    phase: LedgerCommentPhase;
    body: string;
  }) {
    const marker = buildRoarkMarker({
      issueNumber: input.issueNumber,
      attempt: input.attemptMetadata.attempt,
      phase: input.phase,
    });
    yield* Effect.gen(function* () {
      const ref = yield* (yield* GitHub).postOrUpdateIssueCommentByMarker({
        cwd: input.cwd,
        repo: input.repo,
        issueNumber: input.issueNumber,
        marker,
        body: input.body,
        existingCommentId:
          input.attemptMetadata.githubComments?.issue?.[input.phase]?.id,
      });
      recordAttemptIssueComment(input.attemptMetadata, input.phase, ref);
    }).pipe(
      Effect.catch(
        Effect.fnUntraced(function* (error) {
          (yield* Presentation).warning(
            `failed to publish ${input.phase} issue ledger comment: ${error.message}`,
          );
        }),
      ),
    );
  },
);
export function formatTriageLedgerComment(
  input: LedgerCommentArtifactInput,
): string {
  const marker = buildRoarkMarker({
    issueNumber: input.issueNumber,
    attempt: input.attempt,
    phase: "triage",
  });
  const lines = [
    marker,
    "",
    sanitizePublicMarkdown(input.artifactContent).trimEnd(),
  ];
  return `${lines.join("\n")}\n`;
}
export function formatImplementationPlanLedgerComment(
  input: LedgerCommentArtifactInput,
): string {
  const marker = buildRoarkMarker({
    issueNumber: input.issueNumber,
    attempt: input.attempt,
    phase: "implementation-plan",
  });
  const content = sanitizePublicMarkdown(input.artifactContent);
  const lines = [marker, "", content.trimEnd()];
  return `${lines.join("\n")}\n`;
}
export function formatReadinessLedgerComment(
  input: ReadinessLedgerCommentInput,
): string {
  const marker = buildRoarkMarker({
    issueNumber: input.issueNumber,
    attempt: input.attempt,
    phase: "readiness",
  });
  const lines = [marker];
  if (input.recoveryCommand) {
    lines.push(
      "",
      "## Recovery",
      "",
      formatFencedBlock(sanitizePublicMarkdown(input.recoveryCommand), "bash"),
    );
  }
  const readiness = sanitizePublicMarkdown(input.artifactContent).trimEnd();
  if (readiness) lines.push("", readiness);
  return `${lines.join("\n")}\n`;
}
export function formatReviewLedgerComment(input: {
  issueNumber: number;
  attempt: number;
  phase: string;
  markerPhase?: "review-a" | "review-b" | undefined;
  title: string;
  artifactContent: string;
}): string {
  const marker = buildRoarkMarker({
    issueNumber: input.issueNumber,
    attempt: input.attempt,
    phase: input.markerPhase ?? input.phase,
  });
  const source: ReviewFindingSource = (
    input.markerPhase ?? input.phase
  ).startsWith("review-a")
    ? "review-a"
    : "review-b";
  const review = parseReviewResultJson(input.artifactContent, {
    allowRestart: true,
  });
  const content = sanitizePublicMarkdown(
    formatReviewResultMarkdown(review, { title: input.title, source }),
  );
  return [marker, "", content.trimEnd()].join("\n") + "\n";
}
export function formatPrCreatedComment(input: {
  issueNumber: number;
  attempt: number;
  prUrl: string;
}): string {
  const marker = buildRoarkMarker({
    issueNumber: input.issueNumber,
    attempt: input.attempt,
    phase: "pr-created",
  });
  const lines = [
    marker,
    `## Roark PR created — attempt ${input.attempt}`,
    "",
    `PR: ${input.prUrl}`,
  ];
  return `${lines.join("\n")}\n`;
}
const publishArtifactLedgerComment = Effect.fn("publishArtifactLedgerComment")(
  function* (input: {
    cwd: string;
    repo?: string | undefined;
    issue: AutorunIssueCandidate;
    workflowContext: WorkflowContext;
    attemptMetadata: AttemptMetadata;
    artifact: ArtifactRef;
    renderedArtifact: ArtifactRef;
    phase: string;
    attemptMetadataPath?: string | undefined;
    formatBody: (artifactContent: string) => string;
    publishLedgerComment: PublishIssueLedgerCommentFn;
  }) {
    if (!(yield* artifactExists(input.workflowContext, input.artifact))) return;
    const artifactContent = yield* readArtifact(
      input.workflowContext,
      input.artifact,
    );
    const validation = validateAgentArtifact(input.artifact, artifactContent);
    if (!validation.ok) return;
    if (!(yield* artifactExists(input.workflowContext, input.renderedArtifact)))
      return;
    const renderedContent = yield* readArtifact(
      input.workflowContext,
      input.renderedArtifact,
    );
    yield* input.publishLedgerComment({
      cwd: input.cwd,
      repo: input.repo,
      issueNumber: input.issue.number,
      attemptMetadata: input.attemptMetadata,
      phase: input.phase,
      body: input.formatBody(renderedContent),
    });
  },
);
const publishReviewLedgerComment = Effect.fn("publishReviewLedgerComment")(
  function* (input: {
    cwd: string;
    repo?: string | undefined;
    issue: AutorunIssueCandidate;
    workflowContext: WorkflowContext;
    attemptMetadata: AttemptMetadata;
    artifact: ArtifactRef;
    phase: string;
    markerPhase?: "review-a" | "review-b" | undefined;
    title: string;
    publishLedgerComment: PublishIssueLedgerCommentFn;
  }) {
    if (!(yield* artifactExists(input.workflowContext, input.artifact))) return;
    const artifactContent = yield* readArtifact(
      input.workflowContext,
      input.artifact,
    );
    const validation = validateAgentArtifact(input.artifact, artifactContent);
    if (!validation.ok) return;
    const body = formatReviewLedgerComment({
      issueNumber: input.issue.number,
      attempt: input.attemptMetadata.attempt,
      phase: input.phase,
      markerPhase: input.markerPhase,
      title: input.title,
      artifactContent,
    });
    yield* input.publishLedgerComment({
      cwd: input.cwd,
      repo: input.repo,
      issueNumber: input.issue.number,
      attemptMetadata: input.attemptMetadata,
      phase: input.phase,
      body,
    });
  },
);
function formatFencedBlock(value: string, language: string): string {
  const fence = longestBacktickRun(value) >= 4 ? "`````" : "````";
  return `${fence}${language}\n${value}\n${fence}`;
}
function longestBacktickRun(value: string): number {
  let longest = 0;
  let current = 0;
  for (const char of value) {
    if (char === "`") {
      current += 1;
      longest = Math.max(longest, current);
    } else {
      current = 0;
    }
  }
  return longest;
}
