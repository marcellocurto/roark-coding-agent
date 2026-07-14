import type { PrRevisionContext } from "./artifacts.ts";
import { renderStructuredReviewContract } from "../review/contract.ts";

export function revisionPlanPrompt(context: PrRevisionContext): string {
  return `<pr_revision_planning>
You are planning a manual revision for PR #${context.prNumber}, revision ${context.revision}.
Read the PR feedback artifacts in ${context.agentRevisionDirRelative}:
- pr-feedback.md
- pr-feedback.json

Use shell commands freely for inspection and validation. Do not intentionally change repository files during this phase.

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
Use ${context.agentRevisionDirRelative}/revision-plan.md and the latest revision review artifact if present.
For fix passes, inspect the latest revision-review*.json source artifact (or its deterministic Markdown companion) if it contains required fixes, and ${context.agentRevisionDirRelative}/verification-before-fix-${pass}.md if that artifact exists.
Apply only planner-classified must-fix-current items and repair any verification failure captured for this fix pass. Do not implement non-blocking, invalid/stale, already-addressed, or needs-human items.
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
Review the current working tree diff and artifacts in ${context.agentRevisionDirRelative}.
Primary responsibility: verify that every planner-classified must-fix-current feedback item was correctly addressed and every skipped item has a sound rationale.
Then inspect the touched files and relevant callers and tests for regressions introduced by this revision. Check correctness, original PR requirement coverage, maintainability, validation evidence, and scope control.
Evaluate tests by realistic bug-finding value. Do not require tests by default, and reject tests that merely duplicate stronger coverage or restate configuration, prompt wording, fixtures, static content, or private structure.
Do not reopen unrelated pre-existing concerns in untouched code. Do not require changes for non-blocking feedback, optional suggestions, or follow-up work unless the revision made them current blockers.
Support every finding with concrete repository evidence such as a file, symbol, behavior, test, or command result. Stop once the findings are adequately supported; do not perform an unbounded repository audit.
${pass > 0 ? `If ${context.agentRevisionDirRelative}/verification-before-fix-${pass}.md exists, verify that this fix pass addressed the recorded failure or clearly identify why it remains externally blocked.` : ""}
Use shell commands freely for inspection and validation. Do not intentionally change repository files during this phase.

${renderStructuredReviewContract("this PR revision", false)}
</pr_revision_review>`;
}
