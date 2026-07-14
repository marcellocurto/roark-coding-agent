import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import {
  additionalSectionsSchema,
  escapeStructuredMarkdownText,
  normalizeAdditionalSections,
  renderAdditionalSectionsMarkdown,
} from "../structured-output/additional-sections.ts";

export type ReviewFindingSource = "review-a" | "review-b" | "revision-review";
export type FindingHandling = "must-fix-current" | "follow-up" | "suggestion";
export type ReviewConcernClassification = FindingHandling | "external-blocker";
export type FindingSeverity = "low" | "medium" | "high" | "critical";
export type FindingConfidence = "low" | "medium" | "high";
export type ReviewDisposition = "approve" | "fixes-required" | "restart-required" | "blocked";

export const reviewResultMaximumCharacters = 100_000;

export const findingHandlingSchema = Type.Union([
  Type.Literal("must-fix-current"),
  Type.Literal("follow-up"),
  Type.Literal("suggestion"),
]);

export const findingSeveritySchema = Type.Union([
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
  Type.Literal("critical"),
]);

export const findingConfidenceSchema = Type.Union([
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
]);

const boundedString = (description: string, maxLength: number) => Type.String({
  minLength: 1,
  maxLength,
  pattern: "\\S",
  description,
});
const identifier = (description: string) => Type.String({
  minLength: 1,
  maxLength: 64,
  pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$",
  description,
});

export const reviewResultSchema = Type.Object({
  summary: boundedString("Concise overall assessment for this review axis.", 2_000),
  evidenceReviewed: Type.Array(
    boundedString("Repository-relative file, requirement, diff, test, or verification evidence reviewed.", 1_000),
    { minItems: 1, maxItems: 50 },
  ),
  completeness: Type.Union([Type.Literal("complete"), Type.Literal("limited")]),
  limitations: Type.Array(Type.Object({
    id: identifier("Stable semantic identifier for this review limitation."),
    description: boundedString("What the reviewer could not inspect or establish.", 500),
    blocksApproval: Type.Boolean(),
  }, { additionalProperties: false }), { maxItems: 20 }),
  findings: Type.Array(Type.Object({
    id: identifier("Stable semantic identifier for this finding; reuse it while the same concern persists across passes."),
    handling: findingHandlingSchema,
    blockedBy: Type.Array(
      boundedString("Outside information, access, dependency resolution, or human decision preventing this finding from being handled.", 500),
      { maxItems: 5 },
    ),
    title: boundedString("Short actionable finding title.", 200),
    severity: findingSeveritySchema,
    confidence: findingConfidenceSchema,
    evidence: Type.Array(
      boundedString("Concrete repository-relative evidence supporting this finding.", 2_000),
      { minItems: 1, maxItems: 20 },
    ),
    currentIssueImpact: boundedString("Why this matters to the current issue or PR.", 4_000),
    recommendedHandling: boundedString("Smallest credible handling for this finding.", 4_000),
    suggestedIssueTitle: Type.Optional(boundedString("Issue title when the finding should be tracked separately.", 200)),
  }, { additionalProperties: false }), { maxItems: 50 }),
  restartRecommendation: Type.Optional(Type.Object({
    findingIds: Type.Array(identifier("Must-fix finding that requires a restart."), { minItems: 1, maxItems: 20 }),
    rationale: boundedString("Why resetting to the pre-implementation baseline is safer than incremental fixes for the referenced findings.", 2_000),
  }, { additionalProperties: false })),
  additionalSections: Type.Optional(additionalSectionsSchema),
}, { additionalProperties: false });

export type ReviewResult = Static<typeof reviewResultSchema>;
export type ReviewFinding = ReviewResult["findings"][number];
export type ReviewLimitation = ReviewResult["limitations"][number];

export const normalizedReviewerFindingSchema = Type.Object({
  source: Type.Union([Type.Literal("review-a"), Type.Literal("review-b"), Type.Literal("revision-review")]),
  sourceLocalId: boundedString("Finding identifier local to its source review.", 128),
  workflowId: boundedString("Stable workflow identifier for the finding.", 256),
  title: boundedString("Short actionable finding title.", 700),
  classification: findingHandlingSchema,
  severity: findingSeveritySchema,
  confidence: findingConfidenceSchema,
  evidence: Type.Array(boundedString("Concrete evidence supporting the finding.", 2_000), { minItems: 1, maxItems: 20 }),
  currentIssueImpact: boundedString("Why this matters to the current issue.", 4_000),
  recommendedHandling: boundedString("Smallest credible handling for this finding.", 4_000),
  blockedBy: Type.Array(boundedString("External constraint blocking this finding.", 500), { maxItems: 5 }),
  suggestedIssueTitle: Type.Optional(boundedString("Suggested follow-up issue title.", 200)),
}, { additionalProperties: false });

export interface NormalizedReviewerFinding {
  source: ReviewFindingSource;
  sourceLocalId: string;
  workflowId: string;
  title: string;
  classification: FindingHandling;
  severity: FindingSeverity;
  confidence: FindingConfidence;
  evidence: string[];
  currentIssueImpact: string;
  recommendedHandling: string;
  blockedBy: string[];
  suggestedIssueTitle?: string;
}

export const normalizedReviewBlockerSchema = Type.Object({
  source: Type.Union([Type.Literal("review-a"), Type.Literal("review-b"), Type.Literal("revision-review")]),
  sourceLocalId: boundedString("Blocker identifier local to its source review.", 128),
  workflowId: boundedString("Stable workflow identifier for the blocker.", 256),
  title: boundedString("Short blocker title.", 700),
  classification: Type.Literal("external-blocker"),
  evidence: Type.Array(boundedString("Concrete external constraint or unavailable review coverage.", 2_000), { minItems: 1, maxItems: 20 }),
  currentIssueImpact: boundedString("Why this constraint blocks the current issue.", 4_000),
  recommendedHandling: boundedString("Smallest credible way to resolve the constraint.", 4_000),
  relatedFindingId: Type.Optional(boundedString("Workflow ID of the finding constrained by this blocker.", 256)),
  suggestedIssueTitle: Type.Optional(boundedString("Suggested prerequisite issue title.", 200)),
}, { additionalProperties: false });

export interface NormalizedReviewBlocker {
  source: ReviewFindingSource;
  sourceLocalId: string;
  workflowId: string;
  title: string;
  classification: "external-blocker";
  evidence: string[];
  currentIssueImpact: string;
  recommendedHandling: string;
  relatedFindingId?: string;
  suggestedIssueTitle?: string;
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
  const serialized = serializeForSizeCheck(value);
  if (serialized.length > reviewResultMaximumCharacters) {
    throw new Error(`Review result exceeds the ${reviewResultMaximumCharacters}-character limit.`);
  }

  const normalized = trimStructuredStrings(value);
  if (!Value.Check(reviewResultSchema, normalized)) {
    const first = Value.Errors(reviewResultSchema, normalized)[0];
    const location = first?.instancePath ?? first?.schemaPath ?? "review result";
    throw new Error(`Review result does not satisfy the structured contract at ${location}.`);
  }
  const additionalSections = normalizeAdditionalSections(normalized.additionalSections, {
    artifactLabel: "Review result",
    reservedHeadings: reviewResultHeadings,
    createError: (message) => new Error(message),
  });
  const result: ReviewResult = {
    ...normalized,
    ...(additionalSections === undefined ? {} : { additionalSections }),
  };

  requireUniqueIds(result.findings.map((finding) => finding.id), "finding");
  requireUniqueIds(result.limitations.map((limitation) => limitation.id), "limitation");
  if (result.completeness === "complete" && result.limitations.length > 0) {
    throw new Error("A complete review cannot report limitations.");
  }
  if (result.completeness === "limited" && result.limitations.length === 0) {
    throw new Error("A limited review must report at least one limitation.");
  }
  for (const finding of result.findings) {
    if (finding.handling === "must-fix-current" && finding.confidence === "low") {
      throw new Error(`Must-fix finding '${finding.id}' requires medium or high confidence.`);
    }
    if (finding.handling === "suggestion" && finding.severity === "critical") {
      throw new Error(`Critical finding '${finding.id}' cannot be routed as an optional suggestion.`);
    }
  }

  const restart = result.restartRecommendation;
  if (!options.allowRestart && restart !== undefined) {
    throw new Error("This review workflow does not allow restart recommendations.");
  }
  if (restart !== undefined) {
    requireUniqueIds(restart.findingIds, "restart finding reference");
    const findingsById = new Map(result.findings.map((finding) => [finding.id, finding]));
    for (const findingId of restart.findingIds) {
      const finding = findingsById.get(findingId);
      if (!finding) throw new Error(`Restart recommendation references unknown finding '${findingId}'.`);
      if (finding.handling !== "must-fix-current") {
        throw new Error(`Restart recommendation finding '${findingId}' is not must-fix-current.`);
      }
      if (finding.blockedBy.length > 0) {
        throw new Error(`Restart recommendation finding '${findingId}' is externally blocked.`);
      }
    }
  }
  return result;
}

export function reviewDisposition(result: ReviewResult): ReviewDisposition {
  if (reviewHasBlockingConstraint(result)) return "blocked";
  if (result.restartRecommendation !== undefined) return "restart-required";
  if (result.findings.some(isUnblockedCurrentFix)) return "fixes-required";
  return "approve";
}

export function reviewHasBlockingConstraint(result: ReviewResult): boolean {
  return result.findings.some((finding) => finding.blockedBy.length > 0) ||
    result.limitations.some((limitation) => limitation.blocksApproval);
}

export function isUnblockedCurrentFix(finding: ReviewFinding): boolean {
  return finding.handling === "must-fix-current" && finding.blockedBy.length === 0;
}

export function normalizeReviewFindings(result: ReviewResult, source: ReviewFindingSource): NormalizedReviewerFinding[] {
  return result.findings.map((finding) => ({
    source,
    sourceLocalId: finding.id,
    workflowId: `${source}:${finding.id}`,
    title: finding.title,
    classification: finding.handling,
    severity: finding.severity,
    confidence: finding.confidence,
    evidence: finding.evidence,
    currentIssueImpact: finding.currentIssueImpact,
    recommendedHandling: finding.recommendedHandling,
    blockedBy: finding.blockedBy,
    ...(finding.suggestedIssueTitle ? { suggestedIssueTitle: finding.suggestedIssueTitle } : {}),
  }));
}

export function normalizeReviewBlockers(result: ReviewResult, source: ReviewFindingSource): NormalizedReviewBlocker[] {
  const findingBlockers = normalizeReviewFindings(result, source)
    .filter((finding) => finding.blockedBy.length > 0)
    .map((finding): NormalizedReviewBlocker => ({
      source,
      sourceLocalId: `${finding.sourceLocalId}-external-blocker`,
      workflowId: `${source}:blocker:${finding.sourceLocalId}`,
      title: `Blocked: ${finding.title}`,
      classification: "external-blocker",
      evidence: finding.blockedBy,
      currentIssueImpact: finding.currentIssueImpact,
      recommendedHandling: finding.recommendedHandling,
      relatedFindingId: finding.workflowId,
      ...(finding.suggestedIssueTitle ? { suggestedIssueTitle: finding.suggestedIssueTitle } : {}),
    }));
  const limitations = result.limitations
    .filter((limitation) => limitation.blocksApproval)
    .map((limitation): NormalizedReviewBlocker => ({
      source,
      sourceLocalId: `limitation-${limitation.id}`,
      workflowId: `${source}:limitation:${limitation.id}`,
      title: `Review limitation: ${limitation.description}`,
      classification: "external-blocker",
      evidence: [limitation.description],
      currentIssueImpact: "The reviewer could not establish complete approval evidence for the current change.",
      recommendedHandling: "Resolve the review limitation and rerun the review.",
    }));
  return [...findingBlockers, ...limitations];
}

export function normalizeReviewPair(input: { reviewA: ReviewResult; reviewB: ReviewResult }): NormalizedReviewerFinding[] {
  return [
    ...normalizeReviewFindings(input.reviewA, "review-a"),
    ...normalizeReviewFindings(input.reviewB, "review-b"),
  ];
}

export function normalizeReviewPairBlockers(input: { reviewA: ReviewResult; reviewB: ReviewResult }): NormalizedReviewBlocker[] {
  return [
    ...normalizeReviewBlockers(input.reviewA, "review-a"),
    ...normalizeReviewBlockers(input.reviewB, "review-b"),
  ];
}

export function findingsByClassification<T extends { classification: ReviewConcernClassification }>(
  findings: readonly T[],
  classification: ReviewConcernClassification,
): T[] {
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
    escapeReviewMarkdownText(result.summary),
    "",
    "## Evidence Reviewed",
    ...renderList(result.evidenceReviewed),
    "",
    "## Completeness",
    result.completeness,
    "",
    "## Limitations",
    ...(result.limitations.length === 0 ? ["None."] : result.limitations.flatMap((limitation) => [
      `### ${limitation.id}`,
      "",
      `- Description: ${escapeReviewMarkdownText(limitation.description)}`,
      `- Blocks approval: ${limitation.blocksApproval ? "yes" : "no"}`,
      "",
    ])),
    "## Findings",
    ...(findings.length === 0 ? ["None."] : findings.flatMap((finding) => [
      `### ${finding.sourceLocalId}: ${escapeReviewMarkdownText(finding.title)}`,
      "",
      `- Handling: ${finding.classification}`,
      `- Severity: ${finding.severity}`,
      `- Confidence: ${finding.confidence}`,
      `- Blocked by: ${finding.blockedBy.length === 0 ? "None." : finding.blockedBy.map(escapeReviewMarkdownText).join("; ")}`,
      `- Evidence: ${finding.evidence.map(escapeReviewMarkdownText).join("; ")}`,
      `- Current-issue impact: ${escapeReviewMarkdownText(finding.currentIssueImpact)}`,
      `- Recommended handling: ${escapeReviewMarkdownText(finding.recommendedHandling)}`,
      ...(finding.suggestedIssueTitle ? [`- Suggested issue title: ${escapeReviewMarkdownText(finding.suggestedIssueTitle)}`] : []),
      "",
    ])),
    "## Restart Recommendation",
    ...(result.restartRecommendation === undefined ? ["Not applicable."] : [
      `- Finding IDs: ${result.restartRecommendation.findingIds.join(", ")}`,
      `- Rationale: ${escapeReviewMarkdownText(result.restartRecommendation.rationale)}`,
    ]),
    "",
    ...renderAdditionalSectionsMarkdown(result.additionalSections),
  ];
  return `${lines.join("\n").trimEnd()}\n`;
}

export function escapeReviewMarkdownText(value: string): string {
  return escapeStructuredMarkdownText(value);
}

function renderList(values: readonly string[]): string[] {
  return values.map((value) => `- ${escapeReviewMarkdownText(value)}`);
}

function trimStructuredStrings(value: unknown): unknown {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.map(trimStructuredStrings);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, trimStructuredStrings(entry)]));
  }
  return value;
}

function serializeForSizeCheck(value: unknown): string {
  try {
    const serialized = JSON.stringify(value) as string | undefined;
    if (serialized === undefined) throw new Error("Review result is not serializable.");
    return serialized;
  } catch (error) {
    throw new Error(`Review result is not serializable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function requireUniqueIds(ids: readonly string[], noun: string): void {
  const duplicates = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
  if (duplicates.length > 0) throw new Error(`Review result contains duplicate ${noun} ID(s): ${duplicates.join(", ")}.`);
}

const reviewResultHeadings = [
  "Outcome",
  "Summary",
  "Evidence Reviewed",
  "Completeness",
  "Limitations",
  "Findings",
  "Restart Recommendation",
] as const;
