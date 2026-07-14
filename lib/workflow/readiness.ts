import {
  artifactExists,
  latestCompleteReviewCycle,
  readArtifact,
  reviewARef,
  reviewBRef,
  type WorkflowContext,
} from "./artifacts.ts";
import { decideReadiness } from "./verdicts.ts";
import { parseReviewResultJson, type NormalizedReviewerFinding } from "../review/result.ts";

export async function buildReadinessMarkdown(context: WorkflowContext): Promise<string> {
  const triage = artifactExists(context, "triage") ? await readArtifact(context, "triage") : "";
  const plan = artifactExists(context, "implementationPlan") ? await readArtifact(context, "implementationPlan") : "";
  const latestReviewCycle = latestCompleteReviewCycle(context);
  const reviewA = latestReviewCycle === undefined
    ? undefined
    : parseReviewResultJson(await readArtifact(context, reviewARef(latestReviewCycle)), { allowRestart: true });
  const reviewB = latestReviewCycle === undefined
    ? undefined
    : parseReviewResultJson(await readArtifact(context, reviewBRef(latestReviewCycle)), { allowRestart: true });
  const decision = decideReadiness({ triage, plan, reviewA, reviewB });

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
- Latest review cycle: ${latestReviewCycle ?? "none"}
- Spec and Correctness verdict: ${decision.reviewAVerdict}
- Standards and Maintainability verdict: ${decision.reviewBVerdict}
- Fixes were needed in latest cycle: ${decision.fixesWereNeeded ? "yes" : "no"}
- Restart required in latest cycle: ${decision.restartRequired ? "yes" : "no"}
- Review blocked workflow: ${decision.blockedByReview ? "yes" : "no"}
- Maximum fix passes: ${context.maxFixPasses}

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
      finding.evidence.length > 0 ? `Evidence: ${finding.evidence.join("; ")}` : undefined,
      finding.suggestedIssueTitle ? `Suggested issue: ${finding.suggestedIssueTitle}` : undefined,
    ].filter((value): value is string => value !== undefined);
    return `- ${finding.workflowId} — ${finding.title} (${details})${suffixes.length > 0 ? `. ${suffixes.join(" ")}` : ""}`;
  }).join("\n");
}
