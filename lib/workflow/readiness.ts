import {
  artifactExists,
  finalReviewRef,
  latestCompleteReviewCycle,
  latestFinalReviewPass,
  readArtifact,
  reviewARef,
  reviewBRef,
  type WorkflowContext,
} from "./artifacts.ts";
import { decideReadiness } from "./verdicts.ts";
import type { NormalizedReviewerFinding, RejectedReviewerFinding } from "./findings.ts";

export async function buildReadinessMarkdown(context: WorkflowContext): Promise<string> {
  const triage = artifactExists(context, "triage") ? await readArtifact(context, "triage") : "";
  const plan = artifactExists(context, "implementationPlan") ? await readArtifact(context, "implementationPlan") : "";
  const latestReviewCycle = latestCompleteReviewCycle(context);
  const reviewAArtifact = latestReviewCycle === undefined ? "reviewA" : reviewARef(latestReviewCycle);
  const reviewBArtifact = latestReviewCycle === undefined ? "reviewB" : reviewBRef(latestReviewCycle);
  const reviewA = artifactExists(context, reviewAArtifact) ? await readArtifact(context, reviewAArtifact) : "";
  const reviewB = artifactExists(context, reviewBArtifact) ? await readArtifact(context, reviewBArtifact) : "";
  const useLegacyFinalReview = latestReviewCycle === undefined;
  const finalReviewPass = useLegacyFinalReview ? latestFinalReviewPass(context) : undefined;
  const finalReview = finalReviewPass !== undefined ? await readArtifact(context, finalReviewRef(finalReviewPass)) : "";
  const decision = decideReadiness({ triage, plan, reviewA, reviewB, finalReview, allowLegacyFinalReview: useLegacyFinalReview });

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
- Latest review cycle: ${latestReviewCycle ?? "legacy/static"}
- Review A verdict: ${decision.reviewAVerdict}
- Review B verdict: ${decision.reviewBVerdict}
- Fixes were needed in latest cycle: ${decision.fixesWereNeeded ? "yes" : "no"}
- Restart required in latest cycle: ${decision.restartRequired ? "yes" : "no"}
- Review blocked workflow: ${decision.blockedByReview ? "yes" : "no"}
- Legacy final review pass used: ${finalReviewPass ?? "none"}
- Legacy final review verdict used: ${decision.finalVerdict}
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
${decision.status === "ready-for-pr" ? "The workflow considers the latest post-refinement Review A/B cycle ready for a pull request." : "The workflow does not consider this work ready for a pull request yet."}

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
    ].filter((value): value is string => value !== undefined);
    return `- ${finding.workflowId} — ${finding.title} (${details})${suffixes.length > 0 ? `. ${suffixes.join(" ")}` : ""}`;
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
