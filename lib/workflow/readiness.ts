import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import {
  artifactExists,
  latestCompleteReviewCycle,
  readArtifact,
  reviewARef,
  reviewBRef,
  type WorkflowContext,
} from "./artifacts.ts";
import { decideReadiness } from "./verdicts.ts";
import {
  normalizedReviewerFindingSchema,
  parseReviewResultJson,
  type NormalizedReviewerFinding,
} from "../review/result.ts";
import { parseTriageResultJson } from "../triage/result.ts";
import { parseImplementationPlanResultJson } from "../implementation-plan/result.ts";

const readinessDecisionSchema = Type.Object({
  status: Type.Union([Type.Literal("ready-for-pr"), Type.Literal("not-ready")]),
  triageVerdict: Type.Union([
    Type.Literal("proceed"),
    Type.Literal("blocked"),
    Type.Literal("reject"),
    Type.Literal("needs-human-decision"),
    Type.Literal("missing"),
  ]),
  reviewAVerdict: Type.Union([
    Type.Literal("approve"),
    Type.Literal("fixes-required"),
    Type.Literal("restart-required"),
    Type.Literal("blocked"),
    Type.Literal("missing"),
  ]),
  reviewBVerdict: Type.Union([
    Type.Literal("approve"),
    Type.Literal("fixes-required"),
    Type.Literal("restart-required"),
    Type.Literal("blocked"),
    Type.Literal("missing"),
  ]),
  planReady: Type.Boolean(),
  fixesWereNeeded: Type.Boolean(),
  restartRequired: Type.Boolean(),
  blockedByReview: Type.Boolean(),
  currentIssueBlockingFindings: Type.Array(normalizedReviewerFindingSchema),
  externalBlockers: Type.Array(normalizedReviewerFindingSchema),
  followUpFindings: Type.Array(normalizedReviewerFindingSchema),
  suggestions: Type.Array(normalizedReviewerFindingSchema),
}, { additionalProperties: false });

export const readinessResultSchema = Type.Object({
  version: Type.Literal(1),
  issueNumber: Type.String({ minLength: 1 }),
  runDirectory: Type.String({ minLength: 1 }),
  latestReviewCycle: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  maxFixPasses: Type.Integer({ minimum: 0 }),
  decision: readinessDecisionSchema,
}, { additionalProperties: false });

export type ReadinessResult = Static<typeof readinessResultSchema>;
export type ReadinessStatus = ReadinessResult["decision"]["status"];

export function parseReadinessResultJson(content: string): ReadinessResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(`Readiness artifact is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Value.Check(readinessResultSchema, parsed)) {
    const first = Value.Errors(readinessResultSchema, parsed)[0];
    const location = first?.instancePath ?? first?.schemaPath ?? "readiness result";
    throw new Error(`Readiness artifact does not satisfy the structured contract at ${location}.`);
  }
  const expectedStatus: ReadinessStatus = parsed.decision.triageVerdict === "proceed" &&
      parsed.decision.planReady &&
      parsed.decision.reviewAVerdict === "approve" &&
      parsed.decision.reviewBVerdict === "approve"
    ? "ready-for-pr"
    : "not-ready";
  if (parsed.decision.status !== expectedStatus) {
    throw new Error(`Readiness status '${parsed.decision.status}' conflicts with its decision inputs; expected '${expectedStatus}'.`);
  }
  if (parsed.decision.fixesWereNeeded !== (parsed.decision.currentIssueBlockingFindings.length > 0)) {
    throw new Error("Readiness fixesWereNeeded conflicts with currentIssueBlockingFindings.");
  }
  if (parsed.decision.blockedByReview !== (parsed.decision.externalBlockers.length > 0)) {
    throw new Error("Readiness blockedByReview conflicts with externalBlockers.");
  }
  return parsed;
}

export async function buildReadinessArtifacts(context: WorkflowContext): Promise<{ result: ReadinessResult; markdown: string }> {
  const triage = artifactExists(context, "triage")
    ? parseTriageResultJson(await readArtifact(context, "triage"))
    : undefined;
  const plan = artifactExists(context, "implementationPlan")
    ? parseImplementationPlanResultJson(await readArtifact(context, "implementationPlan"))
    : undefined;
  const latestReviewCycle = latestCompleteReviewCycle(context);
  const reviewA = latestReviewCycle === undefined
    ? undefined
    : parseReviewResultJson(await readArtifact(context, reviewARef(latestReviewCycle)), { allowRestart: true });
  const reviewB = latestReviewCycle === undefined
    ? undefined
    : parseReviewResultJson(await readArtifact(context, reviewBRef(latestReviewCycle)), { allowRestart: true });
  const decision = decideReadiness({ triage, plan, reviewA, reviewB });
  const result: ReadinessResult = {
    version: 1,
    issueNumber: context.issueNumber,
    runDirectory: context.runDirRelative,
    latestReviewCycle: latestReviewCycle ?? null,
    maxFixPasses: context.maxFixPasses,
    decision,
  };
  return { result, markdown: formatReadinessMarkdown(result) };
}

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

function renderFindings(findings: readonly NormalizedReviewerFinding[]): string {
  if (findings.length === 0) return "None";
  return findings.map((finding) => {
    const details = [
      `classification: ${finding.classification}`,
      `severity: ${finding.severity}`,
      `confidence: ${finding.confidence}`,
    ].join("; ");
    const suffixes = [
      finding.currentIssueImpact ? `Impact: ${finding.currentIssueImpact}` : undefined,
      finding.recommendedHandling ? `Handling: ${finding.recommendedHandling}` : undefined,
      finding.evidence.length > 0 ? `Evidence: ${finding.evidence.join("; ")}` : undefined,
      finding.suggestedIssueTitle ? `Suggested issue: ${finding.suggestedIssueTitle}` : undefined,
    ].filter((value): value is string => value !== undefined);
    return `- ${finding.workflowId} — ${finding.title} (${details})${suffixes.length > 0 ? `. ${suffixes.join(" ")}` : ""}`;
  }).join("\n");
}
