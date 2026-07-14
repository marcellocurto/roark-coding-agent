import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

export type ReviewFindingSource = "review-a" | "review-b" | "revision-review";
export type FindingClassification = "must-fix-current" | "external-blocker" | "follow-up" | "suggestion";
export type FindingSeverity = "low" | "medium" | "high" | "critical";
export type FindingConfidence = "low" | "medium" | "high";
export type ReviewDisposition = "approve" | "fixes-required" | "restart-required" | "blocked";

const classificationSchema = Type.Union([
  Type.Literal("must-fix-current"),
  Type.Literal("external-blocker"),
  Type.Literal("follow-up"),
  Type.Literal("suggestion"),
]);

const severitySchema = Type.Union([
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
  Type.Literal("critical"),
]);

const confidenceSchema = Type.Union([
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
]);

const nonEmptyString = (description: string) => Type.String({ minLength: 1, description });

export const reviewResultSchema = Type.Object({
  summary: nonEmptyString("Concise overall assessment for this review axis."),
  evidenceReviewed: Type.Array(nonEmptyString("Repository-relative file, requirement, diff, test, or verification evidence reviewed.")),
  findings: Type.Array(Type.Object({
    classification: classificationSchema,
    title: nonEmptyString("Short actionable finding title."),
    severity: severitySchema,
    confidence: confidenceSchema,
    evidence: Type.Array(nonEmptyString("Concrete repository-relative evidence supporting this finding."), { minItems: 1 }),
    currentIssueImpact: nonEmptyString("Why this matters to the current issue or PR."),
    recommendedHandling: nonEmptyString("Smallest credible handling for this finding."),
    suggestedIssueTitle: Type.Optional(nonEmptyString("Issue title when the finding should be tracked separately.")),
  }, { additionalProperties: false })),
  restartRationale: Type.Optional(nonEmptyString("Why resetting to the pre-implementation baseline is safer than an incremental fix.")),
}, { additionalProperties: false });

export type ReviewResult = Static<typeof reviewResultSchema>;
export type ReviewFinding = ReviewResult["findings"][number];

export interface NormalizedReviewerFinding {
  source: ReviewFindingSource;
  sourceLocalId: string;
  workflowId: string;
  title: string;
  classification: FindingClassification;
  severity: FindingSeverity;
  confidence: FindingConfidence;
  evidence: string[];
  currentIssueImpact: string;
  recommendedHandling: string;
  suggestedIssueTitle?: string | undefined;
}

export function parseReviewResultJson(content: string, options: { allowRestart: boolean }): ReviewResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(`Review artifact is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return validateReviewResult(parsed, options);
}

export function validateReviewResult(value: unknown, options: { allowRestart: boolean }): ReviewResult {
  if (!Value.Check(reviewResultSchema, value)) {
    const first = Value.Errors(reviewResultSchema, value)[0];
    const location = first?.instancePath ?? first?.schemaPath ?? "review result";
    throw new Error(`Review result does not satisfy the structured contract at ${location}.`);
  }
  const result = value;
  if (!options.allowRestart && result.restartRationale !== undefined) {
    throw new Error("This review workflow does not allow restart recommendations.");
  }
  if (result.restartRationale !== undefined && !result.findings.some((finding) => finding.classification === "must-fix-current")) {
    throw new Error("A restart recommendation requires at least one must-fix-current finding.");
  }
  return result;
}

export function reviewDisposition(result: ReviewResult): ReviewDisposition {
  if (result.findings.some((finding) => finding.classification === "external-blocker")) return "blocked";
  if (result.restartRationale !== undefined) return "restart-required";
  if (result.findings.some((finding) => finding.classification === "must-fix-current")) return "fixes-required";
  return "approve";
}

export function normalizeReviewFindings(result: ReviewResult, source: ReviewFindingSource): NormalizedReviewerFinding[] {
  const label = source === "review-a" ? "A" : source === "review-b" ? "B" : "R";
  return result.findings.map((finding, index) => {
    const sourceLocalId = `${label}-${String(index + 1).padStart(3, "0")}`;
    return {
      source,
      sourceLocalId,
      workflowId: `${source}:${sourceLocalId}`,
      ...finding,
    };
  });
}

export function normalizeReviewPair(input: { reviewA: ReviewResult; reviewB: ReviewResult }): NormalizedReviewerFinding[] {
  return [
    ...normalizeReviewFindings(input.reviewA, "review-a"),
    ...normalizeReviewFindings(input.reviewB, "review-b"),
  ];
}

export function findingsByClassification(
  findings: readonly NormalizedReviewerFinding[],
  classification: FindingClassification,
): NormalizedReviewerFinding[] {
  return findings.filter((finding) => finding.classification === classification);
}

export function formatReviewResultMarkdown(
  result: ReviewResult,
  input: { title: string; source: ReviewFindingSource },
): string {
  const findings = normalizeReviewFindings(result, input.source);
  const lines = [
    `# ${input.title}`,
    "",
    "## Outcome",
    reviewDisposition(result),
    "",
    "## Summary",
    result.summary,
    "",
    "## Evidence Reviewed",
    ...renderList(result.evidenceReviewed),
    "",
    "## Findings",
    ...(findings.length === 0 ? ["None."] : findings.flatMap((finding) => [
      `### ${finding.sourceLocalId}: ${finding.title}`,
      "",
      `- Classification: ${finding.classification}`,
      `- Severity: ${finding.severity}`,
      `- Confidence: ${finding.confidence}`,
      `- Evidence: ${finding.evidence.join("; ")}`,
      `- Current-issue impact: ${finding.currentIssueImpact}`,
      `- Recommended handling: ${finding.recommendedHandling}`,
      ...(finding.suggestedIssueTitle ? [`- Suggested issue title: ${finding.suggestedIssueTitle}`] : []),
      "",
    ])),
    "## Restart Rationale",
    result.restartRationale ?? "Not applicable.",
  ];
  return `${lines.join("\n").trimEnd()}\n`;
}

function renderList(values: readonly string[]): string[] {
  return values.length === 0 ? ["None."] : values.map((value) => `- ${value}`);
}
