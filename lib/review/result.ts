import { Effect, SchemaGetter, type SchemaIssue } from "effect";
import {
  artifactContract,
  invalidArtifact,
} from "../structured-output/contract.ts";
import { Schema } from "effect";
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
export type ReviewDisposition =
  | "approve"
  | "fixes-required"
  | "restart-required"
  | "blocked";
export const reviewResultMaximumCharacters = 100000;
export const findingHandlingSchema = Schema.Union([
  Schema.Literal("must-fix-current"),
  Schema.Literal("follow-up"),
  Schema.Literal("suggestion"),
]);
export const findingSeveritySchema = Schema.Union([
  Schema.Literal("low"),
  Schema.Literal("medium"),
  Schema.Literal("high"),
  Schema.Literal("critical"),
]);
export const findingConfidenceSchema = Schema.Union([
  Schema.Literal("low"),
  Schema.Literal("medium"),
  Schema.Literal("high"),
]);
const boundedString = (description: string, maxLength: number) =>
  Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(maxLength),
    Schema.isPattern(/\S/),
  ).annotate({ description });
const identifier = (description: string) =>
  Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(64),
    Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  ).annotate({ description });
const reviewResultSchemaShape = Schema.Struct({
  summary: boundedString(
    "Concise overall assessment for this review axis.",
    2000,
  ),
  evidenceReviewed: Schema.mutable(
    Schema.Array(
      boundedString(
        "Repository-relative file, requirement, diff, test, or verification evidence reviewed.",
        1000,
      ),
    ),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(50)),
  completeness: Schema.Union([
    Schema.Literal("complete"),
    Schema.Literal("limited"),
  ]),
  limitations: Schema.mutable(
    Schema.Array(
      Schema.Struct({
        id: identifier(
          "Stable semantic identifier for this review limitation.",
        ),
        description: boundedString(
          "What the reviewer could not inspect or establish.",
          500,
        ),
        blocksApproval: Schema.Boolean,
      }),
    ),
  ).check(Schema.isMaxLength(20)),
  findings: Schema.mutable(
    Schema.Array(
      Schema.Struct({
        id: identifier(
          "Stable semantic identifier for this finding; reuse it while the same concern persists across passes.",
        ),
        handling: findingHandlingSchema,
        blockedBy: Schema.mutable(
          Schema.Array(
            boundedString(
              "Outside information, access, dependency resolution, or human decision preventing this finding from being handled.",
              500,
            ),
          ),
        ).check(Schema.isMaxLength(5)),
        title: boundedString("Short actionable finding title.", 200),
        severity: findingSeveritySchema,
        confidence: findingConfidenceSchema,
        evidence: Schema.mutable(
          Schema.Array(
            boundedString(
              "Concrete repository-relative evidence supporting this finding.",
              2000,
            ),
          ),
        ).check(Schema.isMinLength(1), Schema.isMaxLength(20)),
        currentIssueImpact: boundedString(
          "Why this matters to the current issue or PR.",
          4000,
        ),
        recommendedHandling: boundedString(
          "Smallest credible handling for this finding.",
          4000,
        ),
        suggestedIssueTitle: Schema.optional(
          boundedString(
            "Issue title when the finding should be tracked separately.",
            200,
          ),
        ),
      }),
    ),
  ).check(Schema.isMaxLength(50)),
  restartRecommendation: Schema.optional(
    Schema.Struct({
      findingIds: Schema.mutable(
        Schema.Array(identifier("Must-fix finding that requires a restart.")),
      ).check(Schema.isMinLength(1), Schema.isMaxLength(20)),
      rationale: boundedString(
        "Why resetting to the pre-implementation baseline is safer than incremental fixes for the referenced findings.",
        2000,
      ),
    }),
  ),
  additionalSections: Schema.optional(additionalSectionsSchema),
});
export type ReviewResult = (typeof reviewResultSchemaShape)["Type"];
export type ReviewFinding = ReviewResult["findings"][number];
export type ReviewLimitation = ReviewResult["limitations"][number];
export const normalizedReviewerFindingSchema = Schema.Struct({
  source: Schema.Union([
    Schema.Literal("review-a"),
    Schema.Literal("review-b"),
    Schema.Literal("revision-review"),
  ]),
  sourceLocalId: boundedString(
    "Finding identifier local to its source review.",
    128,
  ),
  workflowId: boundedString("Stable workflow identifier for the finding.", 256),
  title: boundedString("Short actionable finding title.", 700),
  classification: findingHandlingSchema,
  severity: findingSeveritySchema,
  confidence: findingConfidenceSchema,
  evidence: Schema.mutable(
    Schema.Array(
      boundedString("Concrete evidence supporting the finding.", 2000),
    ),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(20)),
  currentIssueImpact: boundedString(
    "Why this matters to the current issue.",
    4000,
  ),
  recommendedHandling: boundedString(
    "Smallest credible handling for this finding.",
    4000,
  ),
  blockedBy: Schema.mutable(
    Schema.Array(
      boundedString("External constraint blocking this finding.", 500),
    ),
  ).check(Schema.isMaxLength(5)),
  suggestedIssueTitle: Schema.optional(
    boundedString("Suggested follow-up issue title.", 200),
  ),
});
export type NormalizedReviewerFinding =
  typeof normalizedReviewerFindingSchema.Type;
export const normalizedReviewBlockerSchema = Schema.Struct({
  source: Schema.Union([
    Schema.Literal("review-a"),
    Schema.Literal("review-b"),
    Schema.Literal("revision-review"),
  ]),
  sourceLocalId: boundedString(
    "Blocker identifier local to its source review.",
    128,
  ),
  workflowId: boundedString("Stable workflow identifier for the blocker.", 256),
  title: boundedString("Short blocker title.", 700),
  classification: Schema.Literal("external-blocker"),
  evidence: Schema.mutable(
    Schema.Array(
      boundedString(
        "Concrete external constraint or unavailable review coverage.",
        2000,
      ),
    ),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(20)),
  currentIssueImpact: boundedString(
    "Why this constraint blocks the current issue.",
    4000,
  ),
  recommendedHandling: boundedString(
    "Smallest credible way to resolve the constraint.",
    4000,
  ),
  relatedFindingId: Schema.optional(
    boundedString(
      "Workflow ID of the finding constrained by this blocker.",
      256,
    ),
  ),
  suggestedIssueTitle: Schema.optional(
    boundedString("Suggested prerequisite issue title.", 200),
  ),
});
export type NormalizedReviewBlocker = typeof normalizedReviewBlockerSchema.Type;
const normalizeReviewResult = Effect.fnUntraced(function* (
  value: ReviewResult,
  options: {
    allowRestart: boolean;
  },
): Effect.fn.Return<ReviewResult, SchemaIssue.Issue> {
  const normalized = value;
  const additionalSections = yield* normalizeAdditionalSections(
    normalized.additionalSections,
    {
      artifactLabel: "Review result",
      reservedHeadings: reviewResultHeadings,
    },
  );
  const result: ReviewResult = {
    ...normalized,
    ...(additionalSections === undefined ? {} : { additionalSections }),
  };
  yield* requireUniqueIds(
    result.findings.map((finding) => finding.id),
    "finding",
  );
  yield* requireUniqueIds(
    result.limitations.map((limitation) => limitation.id),
    "limitation",
  );
  if (result.completeness === "complete" && result.limitations.length > 0) {
    return yield* invalidArtifact(
      "A complete review cannot report limitations.",
    );
  }
  if (result.completeness === "limited" && result.limitations.length === 0) {
    return yield* invalidArtifact(
      "A limited review must report at least one limitation.",
    );
  }
  for (const finding of result.findings) {
    if (
      finding.handling === "must-fix-current" &&
      finding.confidence === "low"
    ) {
      return yield* invalidArtifact(
        `Must-fix finding '${finding.id}' requires medium or high confidence.`,
      );
    }
    if (finding.handling === "suggestion" && finding.severity === "critical") {
      return yield* invalidArtifact(
        `Critical finding '${finding.id}' cannot be routed as an optional suggestion.`,
      );
    }
  }
  const restart = result.restartRecommendation;
  if (!options.allowRestart && restart !== undefined) {
    return yield* invalidArtifact(
      "This review workflow does not allow restart recommendations.",
    );
  }
  if (restart !== undefined) {
    yield* requireUniqueIds(restart.findingIds, "restart finding reference");
    const findingsById = new Map(
      result.findings.map((finding) => [finding.id, finding]),
    );
    for (const findingId of restart.findingIds) {
      const finding = findingsById.get(findingId);
      if (!finding)
        return yield* invalidArtifact(
          `Restart recommendation references unknown finding '${findingId}'.`,
        );
      if (finding.handling !== "must-fix-current") {
        return yield* invalidArtifact(
          `Restart recommendation finding '${findingId}' is not must-fix-current.`,
        );
      }
      if (finding.blockedBy.length > 0) {
        return yield* invalidArtifact(
          `Restart recommendation finding '${findingId}' is externally blocked.`,
        );
      }
    }
  }
  return result;
});
export function reviewDisposition(result: ReviewResult): ReviewDisposition {
  if (reviewHasBlockingConstraint(result)) return "blocked";
  if (result.restartRecommendation !== undefined) return "restart-required";
  if (result.findings.some(isUnblockedCurrentFix)) return "fixes-required";
  return "approve";
}
export function reviewHasBlockingConstraint(result: ReviewResult): boolean {
  return (
    result.findings.some((finding) => finding.blockedBy.length > 0) ||
    result.limitations.some((limitation) => limitation.blocksApproval)
  );
}
export function isUnblockedCurrentFix(finding: ReviewFinding): boolean {
  return (
    finding.handling === "must-fix-current" && finding.blockedBy.length === 0
  );
}
export function normalizeReviewFindings(
  result: ReviewResult,
  source: ReviewFindingSource,
): NormalizedReviewerFinding[] {
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
    ...(finding.suggestedIssueTitle
      ? { suggestedIssueTitle: finding.suggestedIssueTitle }
      : {}),
  }));
}
export function normalizeReviewBlockers(
  result: ReviewResult,
  source: ReviewFindingSource,
): NormalizedReviewBlocker[] {
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
      ...(finding.suggestedIssueTitle
        ? { suggestedIssueTitle: finding.suggestedIssueTitle }
        : {}),
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
      currentIssueImpact:
        "The reviewer could not establish complete approval evidence for the current change.",
      recommendedHandling:
        "Resolve the review limitation and rerun the review.",
    }));
  return [...findingBlockers, ...limitations];
}
export function normalizeReviewPair(input: {
  reviewA: ReviewResult;
  reviewB: ReviewResult;
}): NormalizedReviewerFinding[] {
  return [
    ...normalizeReviewFindings(input.reviewA, "review-a"),
    ...normalizeReviewFindings(input.reviewB, "review-b"),
  ];
}
export function normalizeReviewPairBlockers(input: {
  reviewA: ReviewResult;
  reviewB: ReviewResult;
}): NormalizedReviewBlocker[] {
  return [
    ...normalizeReviewBlockers(input.reviewA, "review-a"),
    ...normalizeReviewBlockers(input.reviewB, "review-b"),
  ];
}
export function findingsByClassification<
  T extends {
    classification: ReviewConcernClassification;
  },
>(findings: readonly T[], classification: ReviewConcernClassification): T[] {
  return findings.filter(
    (finding) => finding.classification === classification,
  );
}
export function formatReviewResultMarkdown(
  result: ReviewResult,
  input: {
    title: string;
    source: ReviewFindingSource;
  },
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
    ...(result.limitations.length === 0
      ? ["None."]
      : result.limitations.flatMap((limitation) => [
          `### ${limitation.id}`,
          "",
          `- Description: ${escapeReviewMarkdownText(limitation.description)}`,
          `- Blocks approval: ${limitation.blocksApproval ? "yes" : "no"}`,
          "",
        ])),
    "## Findings",
    ...(findings.length === 0
      ? ["None."]
      : findings.flatMap((finding) => [
          `### ${finding.sourceLocalId}: ${escapeReviewMarkdownText(finding.title)}`,
          "",
          `- Handling: ${finding.classification}`,
          `- Severity: ${finding.severity}`,
          `- Confidence: ${finding.confidence}`,
          `- Blocked by: ${finding.blockedBy.length === 0 ? "None." : finding.blockedBy.map(escapeReviewMarkdownText).join("; ")}`,
          `- Evidence: ${finding.evidence.map(escapeReviewMarkdownText).join("; ")}`,
          `- Current-issue impact: ${escapeReviewMarkdownText(finding.currentIssueImpact)}`,
          `- Recommended handling: ${escapeReviewMarkdownText(finding.recommendedHandling)}`,
          ...(finding.suggestedIssueTitle
            ? [
                `- Suggested issue title: ${escapeReviewMarkdownText(finding.suggestedIssueTitle)}`,
              ]
            : []),
          "",
        ])),
    "## Restart Recommendation",
    ...(result.restartRecommendation === undefined
      ? ["Not applicable."]
      : [
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
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        trimStructuredStrings(entry),
      ]),
    );
  }
  return value;
}
const serializeReviewInput = Schema.encodeUnknownEffect(
  Schema.fromJsonString(Schema.Unknown),
);
const reviewInput = Schema.Unknown.pipe(
  Schema.decode({
    decode: SchemaGetter.transformOrFail(
      Effect.fnUntraced(function* (value: unknown) {
        const serialized = yield* serializeReviewInput(value).pipe(
          Effect.mapError((error) => error.issue),
        );
        if (serialized.length > reviewResultMaximumCharacters) {
          return yield* invalidArtifact(
            `Review result exceeds the ${reviewResultMaximumCharacters}-character limit.`,
          );
        }
        return trimStructuredStrings(value);
      }),
    ),
    encode: SchemaGetter.passthrough(),
  }),
  Schema.decodeTo(reviewResultSchemaShape),
);
const requireUniqueIds = Effect.fnUntraced(function* (
  ids: readonly string[],
  noun: string,
): Effect.fn.Return<void, SchemaIssue.Issue> {
  const duplicates = [
    ...new Set(ids.filter((id, index) => ids.indexOf(id) !== index)),
  ];
  if (duplicates.length > 0)
    return yield* invalidArtifact(
      `Review result contains duplicate ${noun} ID(s): ${duplicates.join(", ")}.`,
    );
});
const reviewResultHeadings = [
  "Outcome",
  "Summary",
  "Evidence Reviewed",
  "Completeness",
  "Limitations",
  "Findings",
  "Restart Recommendation",
] as const;
const contract = (options: { allowRestart: boolean }) =>
  artifactContract(
    "Review",
    reviewInput.pipe(
      Schema.decode({
        decode: SchemaGetter.transformOrFail((value) =>
          normalizeReviewResult(value, options),
        ),
        encode: SchemaGetter.passthrough(),
      }),
    ),
  );
export const validateReviewResult = Effect.fnUntraced(function* (
  value: unknown,
  options: {
    allowRestart: boolean;
  },
) {
  return yield* contract(options).decode(value);
});
export const parseReviewResultJson = Effect.fnUntraced(function* (
  content: string,
  options: {
    allowRestart: boolean;
  },
) {
  return yield* contract(options).parse(content);
});
export const reviewResultSchema = reviewResultSchemaShape;
