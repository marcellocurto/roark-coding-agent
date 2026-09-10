import { artifactContract } from "../structured-output/contract.ts";
import { Effect } from "effect";
import { Schema } from "effect";
import { reviewARef, reviewBRef, type WorkflowContext } from "./artifacts.ts";
import { artifactExists, latestCompleteReviewCycle } from "./artifacts.ts";
import { readArtifact } from "./artifacts.ts";
import { decideReadiness } from "./verdicts.ts";
import {
  escapeReviewMarkdownText,
  normalizedReviewBlockerSchema,
  normalizedReviewerFindingSchema,
  type NormalizedReviewBlocker,
  parseReviewResultJson,
  type NormalizedReviewerFinding,
} from "../review/result.ts";
import { parseTriageResultJson } from "../triage/result.ts";
import { parseImplementationPlanResultJson } from "../implementation-plan/result.ts";
import { planWorkflowProgression } from "./progression.ts";
const readinessDecisionSchema = Schema.Struct({
  pendingWork: Schema.optional(Schema.Boolean),
  executionBlocked: Schema.optional(Schema.Boolean),
  status: Schema.Union([
    Schema.Literal("ready-for-pr"),
    Schema.Literal("not-ready"),
  ]),
  triageVerdict: Schema.Union([
    Schema.Literal("proceed"),
    Schema.Literal("blocked"),
    Schema.Literal("reject"),
    Schema.Literal("needs-human-decision"),
    Schema.Literal("missing"),
  ]),
  reviewAVerdict: Schema.Union([
    Schema.Literal("approve"),
    Schema.Literal("fixes-required"),
    Schema.Literal("restart-required"),
    Schema.Literal("blocked"),
    Schema.Literal("missing"),
  ]),
  reviewBVerdict: Schema.Union([
    Schema.Literal("approve"),
    Schema.Literal("fixes-required"),
    Schema.Literal("restart-required"),
    Schema.Literal("blocked"),
    Schema.Literal("missing"),
  ]),
  planReady: Schema.Boolean,
  fixesWereNeeded: Schema.Boolean,
  restartRequired: Schema.Boolean,
  blockedByReview: Schema.Boolean,
  currentIssueBlockingFindings: Schema.mutable(
    Schema.Array(normalizedReviewerFindingSchema),
  ),
  externalBlockers: Schema.mutable(Schema.Array(normalizedReviewBlockerSchema)),
  followUpFindings: Schema.mutable(
    Schema.Array(normalizedReviewerFindingSchema),
  ),
  suggestions: Schema.mutable(Schema.Array(normalizedReviewerFindingSchema)),
});
export const readinessResultSchema = Schema.Struct({
  version: Schema.Literal(2),
  issueNumber: Schema.String.check(Schema.isMinLength(1)),
  runDirectory: Schema.String.check(Schema.isMinLength(1)),
  latestReviewCycle: Schema.Union([
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    Schema.Null,
  ]),
  maxFixPasses: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  decision: readinessDecisionSchema,
});
export type ReadinessResult = (typeof readinessResultSchema)["Type"];
export type ReadinessStatus = ReadinessResult["decision"]["status"];
const readinessContract = artifactContract(
  "Readiness",
  readinessResultSchema.check(
    Schema.makeFilter((parsed) => {
      const expectedStatus: ReadinessStatus =
        parsed.decision.pendingWork !== true &&
        parsed.decision.executionBlocked !== true &&
        parsed.decision.triageVerdict === "proceed" &&
        parsed.decision.planReady &&
        parsed.decision.reviewAVerdict === "approve" &&
        parsed.decision.reviewBVerdict === "approve"
          ? "ready-for-pr"
          : "not-ready";
      if (parsed.decision.status !== expectedStatus) {
        return `Readiness status '${parsed.decision.status}' conflicts with its decision inputs; expected '${expectedStatus}'.`;
      }
      if (
        parsed.decision.fixesWereNeeded !==
        parsed.decision.currentIssueBlockingFindings.length > 0
      ) {
        return "Readiness fixesWereNeeded conflicts with currentIssueBlockingFindings.";
      }
      if (
        parsed.decision.blockedByReview !==
        parsed.decision.externalBlockers.length > 0
      ) {
        return "Readiness blockedByReview conflicts with externalBlockers.";
      }
    }),
  ),
);
export const parseReadinessResultJson = readinessContract.parse;

export const buildReadinessArtifacts = Effect.fn("buildReadinessArtifacts")(
  function* (context: WorkflowContext) {
    const progression = yield* planWorkflowProgression(context);
    const stoppedBeforeImplementation =
      progression.terminalStatus?.status === "continuation-stopped" ||
      progression.terminalStatus?.status === "triage-stopped" ||
      progression.terminalStatus?.status === "planning-stopped";
    const triage = (yield* artifactExists(context, "triage"))
      ? yield* parseTriageResultJson(yield* readArtifact(context, "triage"))
      : undefined;
    const plan =
      !stoppedBeforeImplementation &&
      (yield* artifactExists(context, "implementationPlan"))
        ? yield* parseImplementationPlanResultJson(
            yield* readArtifact(context, "implementationPlan"),
          )
        : undefined;
    const latestReviewCycle = stoppedBeforeImplementation
      ? undefined
      : yield* latestCompleteReviewCycle(context);
    const reviewA =
      latestReviewCycle === undefined
        ? undefined
        : yield* parseReviewResultJson(
            yield* readArtifact(context, reviewARef(latestReviewCycle)),
            { allowRestart: true },
          );
    const reviewB =
      latestReviewCycle === undefined
        ? undefined
        : yield* parseReviewResultJson(
            yield* readArtifact(context, reviewBRef(latestReviewCycle)),
            { allowRestart: true },
          );
    const executionBlocked =
      progression.terminalStatus?.status === "execution-stopped";
    const decision = decideReadiness({
      pendingWork: progression.actions.some((action) => action.type === "run"),
      triage,
      plan,
      reviewA,
      reviewB,
      executionBlocked,
    });
    const result: ReadinessResult = {
      version: 2,
      issueNumber: context.issueNumber,
      runDirectory: context.runDirRelative,
      latestReviewCycle: latestReviewCycle ?? null,
      maxFixPasses: context.maxFixPasses,
      decision,
    };
    return { result, markdown: formatReadinessMarkdown(result) };
  },
);
export function formatReadinessMarkdown(result: ReadinessResult): string {
  const { decision } = result;
  return `# PR Readiness

## Status
${decision.status}

## Issue
#${result.issueNumber}

## Run Directory
${result.runDirectory}

## Decision Inputs
- Triage verdict: ${decision.triageVerdict}
- Plan ready for implementation: ${decision.planReady ? "yes" : "no"}
- Workflow steps still to run: ${decision.pendingWork === true ? "yes" : "no"}
- Execution stopped for questions or blockers: ${decision.executionBlocked === true ? "yes" : "no"}
- Latest review cycle: ${result.latestReviewCycle ?? "none"}
- Spec and Correctness verdict: ${decision.reviewAVerdict}
- Standards and Maintainability verdict: ${decision.reviewBVerdict}
- Fixes were needed in latest cycle: ${decision.fixesWereNeeded ? "yes" : "no"}
- Restart required in latest cycle: ${decision.restartRequired ? "yes" : "no"}
- Review blocked workflow: ${decision.blockedByReview ? "yes" : "no"}
- Maximum fix passes: ${result.maxFixPasses}

## Current-Issue Blocking Findings
${renderFindings(decision.currentIssueBlockingFindings)}

## External Blockers
${renderFindings(decision.externalBlockers)}

## Follow-Up Findings
${renderFindings(decision.followUpFindings)}

## Suggestions
${renderFindings(decision.suggestions)}

## Summary
${decision.status === "ready-for-pr" ? "The workflow considers the latest post-refinement Review A/B cycle ready for a pull request." : "The workflow does not consider this work ready for a pull request yet."}

## Recommended PR Title
Fix issue #${result.issueNumber}

## Recommended PR Body
Closes #${result.issueNumber}

See workflow artifacts in ${result.runDirectory}.
`;
}
function renderFindings(
  findings: readonly (NormalizedReviewerFinding | NormalizedReviewBlocker)[],
): string {
  if (findings.length === 0) return "None";
  return findings
    .map((finding) => {
      const details =
        "severity" in finding
          ? `classification: ${finding.classification}; severity: ${finding.severity}; confidence: ${finding.confidence}`
          : `classification: ${finding.classification}`;
      const suffixes = [
        finding.currentIssueImpact
          ? `Impact: ${escapeReviewMarkdownText(finding.currentIssueImpact)}`
          : undefined,
        finding.recommendedHandling
          ? `Handling: ${escapeReviewMarkdownText(finding.recommendedHandling)}`
          : undefined,
        finding.evidence.length > 0
          ? `Evidence: ${finding.evidence.map(escapeReviewMarkdownText).join("; ")}`
          : undefined,
        finding.suggestedIssueTitle
          ? `Suggested issue: ${escapeReviewMarkdownText(finding.suggestedIssueTitle)}`
          : undefined,
      ].filter((value): value is string => value !== undefined);
      return `- ${finding.workflowId} — ${escapeReviewMarkdownText(finding.title)} (${details})${suffixes.length > 0 ? `. ${suffixes.join(" ")}` : ""}`;
    })
    .join("\n");
}
