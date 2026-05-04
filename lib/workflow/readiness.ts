import {
  artifactExists,
  finalReviewRef,
  latestFinalReviewPass,
  readArtifact,
  type WorkflowContext,
} from "./artifacts.ts";
import { decideReadiness } from "./verdicts.ts";

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
- Latest final review pass: ${finalReviewPass ?? "none"}
- Latest final review verdict: ${decision.finalVerdict}
- Maximum fix passes: ${context.maxFixPasses}

## Summary
${decision.status === "ready-for-pr" ? "The workflow considers this work ready for a pull request." : "The workflow does not consider this work ready for a pull request yet."}

## Recommended PR Title
Fix issue #${context.issueNumber}

## Recommended PR Body
Closes #${context.issueNumber}

See workflow artifacts in ${context.runDirRelative}.
`;
}
