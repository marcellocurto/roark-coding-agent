import type { PrRevisionContext } from "./artifacts.ts";

export function revisionPlanPrompt(context: PrRevisionContext): string {
  return `<pr_revision_planning>
You are planning a manual revision for PR #${context.prNumber}, revision ${context.revision}.
Read the PR feedback artifacts in ${context.revisionDirRelative}:
- pr-feedback.md
- pr-feedback.json

Classify every relevant unresolved/current feedback item as exactly one of:
- must-fix-current
- already-addressed
- needs-human
- non-blocking
- invalid/stale

If any item needs human clarification/decision before code changes, set status needs-human.
If there are no must-fix-current items and no needs-human items, set status no-action-needed.
Otherwise set status revise.

Return only this Markdown artifact:
# Revision Plan

## Status
revise|needs-human|no-action-needed

## Classified Feedback
- [classification] concise item id/source and rationale

## Must Fix Current Items
- concrete required fix, or None

## Human Needs
- questions/blockers, or None
</pr_revision_planning>`;
}

export function revisionImplementationPrompt(context: PrRevisionContext, pass: number): string {
  return `<pr_revision_implementation>
You are implementing PR #${context.prNumber} revision ${context.revision}${pass > 0 ? ` fix pass ${pass}` : ""}.
Use ${context.revisionDirRelative}/revision-plan.md and the latest revision review artifact if present.
Apply only planner-classified must-fix-current items. Do not implement non-blocking, invalid/stale, already-addressed, or needs-human items.
Keep scope minimal and inspect the current diff before editing.

Return only this Markdown artifact:
# Revision Log

## Summary

## Addressed Must Fix Current Items

## Skipped Items

## Changed Files

## Validation Performed
</pr_revision_implementation>`;
}

export function revisionReviewPrompt(context: PrRevisionContext, pass: number): string {
  return `<pr_revision_review>
You are reviewing PR #${context.prNumber} revision ${context.revision}${pass > 0 ? ` after fix pass ${pass}` : ""}.
Review the current working tree diff and artifacts in ${context.revisionDirRelative}.
Verify feedback handling, skipped-item rationale, validation evidence, regression risk, and scope control.

Return only this Markdown artifact:
# Revision Review

## Verdict
approve|fixes-required|blocked

## Feedback Handling

## Skipped Item Rationale

## Validation Review

## Regression And Scope Review

## Required Fixes
- If verdict is fixes-required, list concrete fixes. Otherwise None.
</pr_revision_review>`;
}
