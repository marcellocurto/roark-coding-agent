import {
  artifactExists,
  finalReviewRef,
  latestFinalReviewPass,
  readArtifact,
  type WorkflowContext,
} from "./artifacts.ts";
import { decideReadiness } from "./verdicts.ts";
import type { NormalizedReviewerFinding, RejectedReviewerFinding } from "./findings.ts";

export async function buildReadinessMarkdown(context: WorkflowContext): Promise<string> {
  const triage = artifactExists(context, "triage") ? await readArtifact(context, "triage") : "";
  const plan = artifactExists(context, "implementationPlan") ? await readArtifact(context, "implementationPlan") : "";
  const reviewA = artifactExists(context, "reviewA") ? await readArtifact(context, "reviewA") : "";
  const reviewB = artifactExists(context, "reviewB") ? await readArtifact(context, "reviewB") : "";
  const finalReviewPass = latestFinalReviewPass(context);
  const finalReview = finalReviewPass ? await readArtifact(context, finalReviewRef(finalReviewPass)) : "";
  const decision = decideReadiness({ triage, plan, reviewA, reviewB, finalReview });

  return `# PR Readiness

## Status
${decision.status}

## Issue
#${context.issueNumber}

## Run Directory
${context.runDirRelative}

## Decision Inputs
- Triage verdict: ${decision.triageVerdict}
- Plan ready for implementation: ${decision.planReady ? "yes" : "no"}
- Review A verdict: ${decision.reviewAVerdict}
- Review B verdict: ${decision.reviewBVerdict}
- Fixes were needed: ${decision.fixesWereNeeded ? "yes" : "no"}
- Review blocked workflow: ${decision.blockedByReview ? "yes" : "no"}
- Latest final review pass: ${finalReviewPass ?? "none"}
- Latest final review verdict: ${decision.finalVerdict}
- Maximum fix passes: ${context.maxFixPasses}

## Current-Issue Blocking Findings
${renderFindings(decision.currentIssueBlockingFindings)}

## External Blockers
${renderFindings(decision.externalBlockers)}

## Follow-Up Findings
${renderFindings(decision.followUpFindings)}

## Suggestions
${renderFindings(decision.suggestions)}

## Parser And Contract Warnings
${renderWarnings(decision.parserWarnings, decision.rejectedFindings)}

## Summary
${decision.status === "ready-for-pr" ? "The workflow considers this work ready for a pull request." : "The workflow does not consider this work ready for a pull request yet."}

## Recommended PR Title
Fix issue #${context.issueNumber}

## Recommended PR Body
Closes #${context.issueNumber}

See workflow artifacts in ${context.runDirRelative}.
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
      finding.evidence ? `Evidence: ${finding.evidence}` : undefined,
      finding.suggestedIssueTitle ? `Suggested issue: ${finding.suggestedIssueTitle}` : undefined,
    ].filter((value): value is string => Boolean(value));
    return `- ${finding.workflowId} — ${finding.title} (${details})${suffixes.length ? `. ${suffixes.join(" ")}` : ""}`;
  }).join("\n");
}

function renderWarnings(warnings: readonly string[], rejected: readonly RejectedReviewerFinding[]): string {
  const lines = [
    ...warnings.map((warning) => `- ${warning}`),
    ...rejected.map((entry) => {
      const id = entry.workflowId ?? `${entry.source}:unknown`;
      const classification = entry.classification ? ` Classification: ${entry.classification}.` : "";
      return `- ${id}: rejected finding entry. ${entry.reason}${classification}`;
    }),
  ];
  return lines.length === 0 ? "None" : lines.join("\n");
}
