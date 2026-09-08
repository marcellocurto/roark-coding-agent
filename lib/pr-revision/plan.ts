import { Effect, SchemaGetter, type SchemaIssue } from "effect";
import {
  artifactContract,
  invalidArtifact,
} from "../structured-output/contract.ts";
import { Schema } from "effect";
import type { StructuredArtifactDefinition } from "../structured-output/runner.ts";
import {
  additionalSectionsSchema,
  normalizeAdditionalSections,
  renderAdditionalSectionsMarkdown,
} from "../structured-output/additional-sections.ts";
export type RevisionPlanStatus = "revise" | "needs-human" | "no-action-needed";
export type RevisionFeedbackClassification =
  | "must-fix-current"
  | "already-addressed"
  | "needs-human"
  | "non-blocking"
  | "invalid-stale";
const nonEmptyString = (description: string) =>
  Schema.String.check(Schema.isMinLength(1)).annotate({ description });
const feedbackClassificationSchema = Schema.Union([
  Schema.Literal("must-fix-current"),
  Schema.Literal("already-addressed"),
  Schema.Literal("needs-human"),
  Schema.Literal("non-blocking"),
  Schema.Literal("invalid-stale"),
]);
const revisionPlanResultSchemaShape = Schema.Struct({
  status: Schema.Union([
    Schema.Literal("revise"),
    Schema.Literal("needs-human"),
    Schema.Literal("no-action-needed"),
  ]),
  feedbackItems: Schema.mutable(
    Schema.Array(
      Schema.Struct({
        id: nonEmptyString(
          "Stable feedback identity derived from its source identity.",
        ),
        sourceIds: Schema.mutable(
          Schema.Array(
            nonEmptyString("Source identity from pr-feedback.json."),
          ),
        ).check(Schema.isMinLength(1)),
        summary: nonEmptyString("Concise statement of the feedback item."),
        classification: feedbackClassificationSchema,
        rationale: nonEmptyString(
          "Reason for the classification, including any required human decision.",
        ),
      }),
    ),
  ),
  additionalSections: Schema.optional(additionalSectionsSchema),
});
export type RevisionPlanResult = (typeof revisionPlanResultSchemaShape)["Type"];
const normalizeRevisionPlanResult = Effect.fnUntraced(function* (
  value: RevisionPlanResult,
  validSourceIds?: ReadonlySet<string>,
): Effect.fn.Return<RevisionPlanResult, SchemaIssue.Issue> {
  const additionalSections = yield* normalizeAdditionalSections(
    value.additionalSections,
    {
      artifactLabel: "Revision plan",
      reservedHeadings: ["Status", "Feedback Items"],
    },
  );
  const result: RevisionPlanResult = {
    ...value,
    feedbackItems: yield* Effect.forEach(
      value.feedbackItems,
      Effect.fnUntraced(function* (item, index) {
        return {
          id: yield* requireTrimmed(item.id, `feedbackItems[${index}].id`),
          sourceIds: yield* uniqueTrimmed(
            item.sourceIds,
            `feedbackItems[${index}].sourceIds`,
          ),
          summary: yield* requireTrimmed(
            item.summary,
            `feedbackItems[${index}].summary`,
          ),
          classification: item.classification,
          rationale: yield* requireTrimmed(
            item.rationale,
            `feedbackItems[${index}].rationale`,
          ),
        };
      }),
    ),
    ...(additionalSections === undefined ? {} : { additionalSections }),
  };
  yield* assertUniqueFeedbackIds(result);
  if (validSourceIds) yield* assertValidFeedbackSources(result, validSourceIds);
  const expectedStatus: RevisionPlanStatus = result.feedbackItems.some(
    (item) => item.classification === "needs-human",
  )
    ? "needs-human"
    : result.feedbackItems.some(
          (item) => item.classification === "must-fix-current",
        )
      ? "revise"
      : "no-action-needed";
  if (result.status !== expectedStatus) {
    return yield* invalidArtifact(
      `Revision plan status '${result.status}' conflicts with its actionable items; expected '${expectedStatus}'.`,
    );
  }
  return result;
});
export function formatRevisionPlanMarkdown(result: RevisionPlanResult): string {
  return [
    "# Revision Plan",
    "",
    "## Status",
    result.status,
    "",
    "## Feedback Items",
    ...renderFeedbackItems(result),
    "",
    ...renderAdditionalSectionsMarkdown(result.additionalSections),
  ].join("\n");
}
const contract = (validSourceIds?: ReadonlySet<string>) =>
  artifactContract(
    "Revision plan",
    revisionPlanResultSchemaShape.pipe(
      Schema.decode({
        decode: SchemaGetter.transformOrFail((value) =>
          normalizeRevisionPlanResult(value, validSourceIds),
        ),
        encode: SchemaGetter.passthrough(),
      }),
    ),
  );
export const validateRevisionPlanResult = Effect.fnUntraced(function* (
  value: unknown,
  validSourceIds?: ReadonlySet<string>,
) {
  return yield* contract(validSourceIds).decode(value);
});
export const revisionPlanResultSchema = revisionPlanResultSchemaShape;
export function revisionPlanArtifactDefinition(
  validSourceIds: ReadonlySet<string>,
): StructuredArtifactDefinition<RevisionPlanResult> {
  return {
    toolName: "submit_revision_plan",
    label: "Revision Plan",
    noun: "revision plan",
    parameters: revisionPlanResultSchema,
    validate: (value) => validateRevisionPlanResult(value, validSourceIds),
    formatMarkdown: formatRevisionPlanMarkdown,
  };
}
const requireTrimmed = Effect.fnUntraced(function* (
  value: string,
  field: string,
): Effect.fn.Return<string, SchemaIssue.Issue> {
  const trimmed = value.trim();
  if (!trimmed)
    return yield* invalidArtifact(`Revision plan ${field} must not be blank.`);
  return trimmed;
});
const uniqueTrimmed = Effect.fnUntraced(function* (
  values: readonly string[],
  field: string,
): Effect.fn.Return<string[], SchemaIssue.Issue> {
  const trimmed = yield* Effect.forEach(
    values,
    Effect.fnUntraced(function* (value, index) {
      return yield* requireTrimmed(value, `${field}[${index}]`);
    }),
  );
  if (new Set(trimmed).size !== trimmed.length)
    return yield* invalidArtifact(
      `Revision plan ${field} must not contain duplicates.`,
    );
  return trimmed;
});
const assertUniqueFeedbackIds = Effect.fnUntraced(function* (
  result: RevisionPlanResult,
): Effect.fn.Return<void, SchemaIssue.Issue> {
  const ids = result.feedbackItems.map((item) => item.id);
  if (new Set(ids).size !== ids.length)
    return yield* invalidArtifact(
      "Revision plan feedback item ids must be unique.",
    );
});
const assertValidFeedbackSources = Effect.fnUntraced(function* (
  result: RevisionPlanResult,
  validSourceIds: ReadonlySet<string>,
): Effect.fn.Return<void, SchemaIssue.Issue> {
  for (const item of result.feedbackItems) {
    const unknown = item.sourceIds.filter(
      (sourceId) => !validSourceIds.has(sourceId),
    );
    if (unknown.length > 0) {
      return yield* invalidArtifact(
        `Revision plan feedback item '${item.id}' references unknown source ids: ${unknown.join(", ")}.`,
      );
    }
    if (
      !item.sourceIds.some(
        (sourceId) =>
          item.id === sourceId || item.id.startsWith(`${sourceId}#`),
      )
    ) {
      return yield* invalidArtifact(
        `Revision plan feedback item id '${item.id}' must derive from one of its source ids.`,
      );
    }
  }
});
function renderFeedbackItems(result: RevisionPlanResult): string[] {
  if (result.feedbackItems.length === 0) return ["None."];
  return result.feedbackItems.map(
    (item) =>
      `- \`${item.id}\` [${item.classification}] ${item.summary} — ${item.rationale} (sources: ${item.sourceIds.join(", ")})`,
  );
}
