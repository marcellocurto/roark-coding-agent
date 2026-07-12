import { parseReviewFindings, type ParsedReviewFindings, type ReviewFindingSource } from "../workflow/findings.ts";
import { parseVerdict } from "../workflow/verdicts.ts";

export type ReviewLensName = "correctness" | "maintainability";

export interface ReviewLensDefinition {
  name: ReviewLensName;
  phase: "review_a" | "review_b";
  reviewerLabel: "A" | "B";
  role: string;
  successCriteria: string;
  focusName: string;
  focusItems: readonly string[];
  sourcePolicy: readonly string[];
  requiredFixesPolicy: string;
  requiresStandardsInspection: boolean;
  extraConstraints: readonly string[];
}

export const correctnessReviewLens: ReviewLensDefinition = {
  name: "correctness",
  phase: "review_a",
  reviewerLabel: "A",
  role: "Review Agent A — Spec and Correctness",
  successCriteria: "Spec and correctness review succeeds when the change is checked against the authoritative requirements, missing or extra behavior is identified, concrete defects cite file-level evidence, and non-defect concerns are not promoted to blockers.",
  focusName: "Spec and Correctness",
  focusItems: [
    "Missing, partial, or incorrect implementation of the requirements or acceptance criteria. Cite the relevant requirement for each finding.",
    "Behavior added by the diff that the requirements did not request, including accidental scope expansion.",
    "Logic bugs, off-by-one errors, and unhandled edge cases or invalid inputs.",
    "Missing or incorrect error handling, race conditions, and ordering issues.",
    "Regressions or broken contracts in unrelated callers touched by the diff.",
    "Missing behavior-oriented regression coverage only where a realistic defect could escape existing tests. Coverage should exercise a stable behavior seam and survive internal refactoring. Do not require tests by default.",
    "Gaps or unsubstantiated claims in available validation evidence.",
  ],
  sourcePolicy: [
    "The supplied review requirements are authoritative for requested behavior and acceptance criteria.",
    "Plans, logs, comments, and prior reviews are supporting evidence, not permission to change or broaden the requirements.",
    "For every spec finding, cite the authoritative requirement and explain how the diff is missing, partial, incorrect, or extra.",
  ],
  requiredFixesPolicy: "Required Fixes must be limited to <value>must-fix-current</value> defects: correctness bugs, missed acceptance criteria, regressions, or missing validation of changed behavior that block approval for the current review subject.",
  requiresStandardsInspection: false,
  extraConstraints: [],
};

export const maintainabilityReviewLens: ReviewLensDefinition = {
  name: "maintainability",
  phase: "review_b",
  reviewerLabel: "B",
  role: "Review Agent B — Standards and Maintainability",
  successCriteria: "Standards and maintainability review succeeds when documented repository-standard violations cite their source, concrete code-health harms cite file-level evidence, and subjective preferences remain clearly labelled suggestions.",
  focusName: "Standards and Maintainability",
  focusItems: [
    "Documented standards: inspect applicable AGENTS.md files, CONTRIBUTING.md, and other repository guidance governing the touched files. Cite the standards file and rule for every violation.",
    "Simplicity: unnecessary complexity, indirection, or premature abstraction.",
    "Proportionality: machinery that is unnecessary or disproportionate to delivering the requested behavior, even when the behavior technically works.",
    "Codebase fit: alignment with existing patterns, idioms, and module boundaries already used here.",
    "Test quality: flag implementation-coupled, tautological, over-mocked, or horizontal-slice tests. Reject tests that cannot name a realistic bug, duplicate stronger coverage, or merely freeze configuration, prompt wording, fixtures, static content, or private structure; assess coverage only for meaningful changed behavior.",
    "Naming and API clarity: ambiguous, misleading, or inconsistent names and public surfaces.",
    "Style, formatting, and structure only when they materially harm readability or consistency.",
  ],
  sourcePolicy: [
    "A documented repository standard is a hard rule and overrides general maintainability preferences.",
    "Cite the governing standards file and exact rule for documented-standard violations. Label uncodified maintainability concerns as judgement calls, not hard violations.",
    "Skip formatting, style, and mechanical concerns already enforced by configured linting, formatting, typechecking, or other tooling.",
  ],
  requiredFixesPolicy: "Required Fixes must cite a <value>must-fix-current</value> concrete maintainability harm and a concrete remediation that blocks approval for the current review subject.",
  requiresStandardsInspection: true,
  extraConstraints: ["Do not read Review Agent A's output."],
};

export const reviewLenses = [correctnessReviewLens, maintainabilityReviewLens] as const;

export interface ValidatedReviewOutput {
  verdict: "approve" | "fixes-required" | "blocked";
  findings: ParsedReviewFindings;
}

export function validateReviewOutput(markdown: string, source: ReviewFindingSource): ValidatedReviewOutput {
  const verdict = parseVerdict(markdown);
  if (verdict !== "approve" && verdict !== "fixes-required" && verdict !== "blocked") {
    throw new Error(`${source} output is missing a valid approve, fixes-required, or blocked verdict.`);
  }
  const findings = parseReviewFindings(markdown, source);
  if (!findings.hasLedger) throw new Error(`${source} output is missing the Findings Ledger.`);
  if (findings.rejected.length > 0) throw new Error(`${source} output contains invalid Findings Ledger entries.`);
  return { verdict, findings };
}
