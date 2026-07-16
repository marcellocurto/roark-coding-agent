import type { PrRevisionContext } from "./artifacts.ts";
import { renderStructuredReviewContract } from "../review/contract.ts";

export function revisionPlanPrompt(context: PrRevisionContext): string {
  return `<pr_revision_planning>
You are planning a manual revision for PR #${context.prNumber}, revision ${context.revision}.
Read ${context.agentRevisionDirRelative}/pr-feedback.json as the canonical PR feedback artifact.
The generated pr-feedback.md file is a human-readable companion, not machine authority.

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

Complete planning only by calling submit_revision_plan with:
- status: revise, needs-human, or no-action-needed
- feedbackItems: every relevant feedback item exactly once, with a stable id, all sourceIds from pr-feedback.json, a concise summary, exactly one classification, and its rationale
- additionalSections: material problem-specific reasoning, interactions, risks, validation strategy, alternatives, or discoveries that do not fit the standard fields; choose each heading freely

Derive each feedback item id from its source identity (for example thread:T1 or comment:123); when one source contains multiple independent concerns, add a stable suffix. Merge duplicate sources into one item and retain every source id.
The status and classifications must agree: any needs-human item implies needs-human; otherwise any must-fix-current item implies revise; otherwise use no-action-needed.
Additional sections are non-routing context. Every considered feedback item must still appear exactly once in feedbackItems.
Do not return Markdown or prose after calling submit_revision_plan.
</pr_revision_planning>`;
}

export function revisionImplementationPrompt(context: PrRevisionContext, pass: number): string {
  const priorReviewInput = pass > 0
    ? `For fix pass ${pass}, inspect ${context.agentRevisionDirRelative}/${priorRevisionReviewArtifact(pass)} as the canonical review input, and ${context.agentRevisionDirRelative}/verification-before-fix-${pass}.md if that artifact exists.`
    : "";
  return `<pr_revision_implementation>
You are implementing PR #${context.prNumber} revision ${context.revision}${pass > 0 ? ` fix pass ${pass}` : ""}.
Use ${context.agentRevisionDirRelative}/revision-plan.json as the canonical revision plan.
${priorReviewInput}
Apply only planner-classified must-fix-current items and repair any verification failure captured for this fix pass. Do not implement non-blocking, invalid/stale, already-addressed, or needs-human items.
Keep scope minimal and inspect the current diff before editing.

Complete this phase only by calling submit_revision_execution with:
- summary: a concise account of the completed work
- feedbackDispositions: exactly one final disposition for every feedbackItems id in revision-plan.json, using addressed or skipped for must-fix-current items and the classification-compatible status for all other items, paired with concrete details
- changedFiles: repository-relative paths paired with what changed
- validation: exact commands with passed, failed, or not-run status and observed details
- additionalSections: material problem-specific discoveries, tradeoffs, or context that do not fit the standard fields; choose each heading freely

On fix passes, carry forward the disposition for every planned feedback id; do not report only the work performed in the latest pass.
Additional sections are non-routing context. Every planned feedback item must still appear exactly once in feedbackDispositions.
The tool schema is authoritative. Do not return Markdown or prose after calling submit_revision_execution.
</pr_revision_implementation>`;
}

function priorRevisionReviewArtifact(fixPass: number): string {
  return fixPass === 1 ? "revision-review.json" : `revision-review-pass-${fixPass - 1}.json`;
}

export function revisionReviewPrompt(context: PrRevisionContext, pass: number): string {
  const executionArtifact = pass === 0 ? "revision-log.json" : `revision-log-fix-pass-${pass}.json`;
  const priorReviewArtifact = pass === 0 ? undefined : priorRevisionReviewArtifact(pass);
  return `<pr_revision_review>
You are reviewing PR #${context.prNumber} revision ${context.revision}${pass > 0 ? ` after fix pass ${pass}` : ""}.
Review the current working tree diff and artifacts in ${context.agentRevisionDirRelative}.
Use ${context.agentRevisionDirRelative}/${executionArtifact} as the canonical execution report; do not infer state from its Markdown companion.
${priorReviewArtifact ? `Use ${context.agentRevisionDirRelative}/${priorReviewArtifact} to reuse stable finding ids for concerns that remain unresolved.` : ""}
Primary responsibility: verify that every planner-classified must-fix-current feedback item was correctly addressed and every skipped item has a sound rationale.
Then inspect the touched files and relevant callers and tests for regressions introduced by this revision. Check correctness, original PR requirement coverage, maintainability, validation evidence, and scope control.
Consider cross-cutting risks implicated by the revision, including security, privacy, accessibility, data migration, performance, licensing, and operational behavior. Report unavailable relevant coverage as a structured limitation.
Evaluate tests by realistic bug-finding value. Do not require tests by default, and reject tests that merely duplicate stronger coverage or restate configuration, prompt wording, fixtures, static content, or private structure.
Do not reopen unrelated pre-existing concerns in untouched code. Do not require changes for non-blocking feedback, optional suggestions, or follow-up work unless the revision made them current blockers.
Support every finding with concrete repository evidence such as a file, symbol, behavior, test, or command result. Stop once the findings are adequately supported; do not perform an unbounded repository audit.
${pass > 0 ? `If ${context.agentRevisionDirRelative}/verification-before-fix-${pass}.md exists, verify that this fix pass addressed the recorded failure or clearly identify why it remains externally blocked.` : ""}
Use shell commands freely for inspection and validation. Do not intentionally change repository files during this phase.

${renderStructuredReviewContract("this PR revision", false)}
</pr_revision_review>`;
}
