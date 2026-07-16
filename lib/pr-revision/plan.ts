import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import type { StructuredArtifactDefinition } from "../structured-output/runner.ts";
import {
  additionalSectionsSchema,
  normalizeAdditionalSections,
  renderAdditionalSectionsMarkdown,
} from "../structured-output/additional-sections.ts";

export type RevisionPlanStatus = "revise" | "needs-human" | "no-action-needed";
export type RevisionFeedbackClassification = "must-fix-current" | "already-addressed" | "needs-human" | "non-blocking" | "invalid-stale";

const nonEmptyString = (description: string) => Type.String({ minLength: 1, description });
const feedbackClassificationSchema = Type.Union([
  Type.Literal("must-fix-current"),
  Type.Literal("already-addressed"),
  Type.Literal("needs-human"),
  Type.Literal("non-blocking"),
  Type.Literal("invalid-stale"),
]);

export const revisionPlanResultSchema = Type.Object({
  status: Type.Union([
    Type.Literal("revise"),
    Type.Literal("needs-human"),
    Type.Literal("no-action-needed"),
  ]),
  feedbackItems: Type.Array(Type.Object({
    id: nonEmptyString("Stable feedback identity derived from its source identity."),
    sourceIds: Type.Array(nonEmptyString("Source identity from pr-feedback.json."), { minItems: 1 }),
    summary: nonEmptyString("Concise statement of the feedback item."),
    classification: feedbackClassificationSchema,
    rationale: nonEmptyString("Reason for the classification, including any required human decision."),
  }, { additionalProperties: false })),
  additionalSections: Type.Optional(additionalSectionsSchema),
}, { additionalProperties: false });

export type RevisionPlanResult = Static<typeof revisionPlanResultSchema>;

export class RevisionPlanOutputContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RevisionPlanOutputContractError";
  }
}

export function validateRevisionPlanResult(value: unknown, validSourceIds?: ReadonlySet<string>): RevisionPlanResult {
  if (!Value.Check(revisionPlanResultSchema, value)) {
    const first = Value.Errors(revisionPlanResultSchema, value)[0];
    const location = first?.instancePath ?? first?.schemaPath ?? "revision plan";
    throw new RevisionPlanOutputContractError(`Revision plan does not satisfy the structured contract at ${location}.`);
  }

  const additionalSections = normalizeAdditionalSections(value.additionalSections, {
    artifactLabel: "Revision plan",
    reservedHeadings: ["Status", "Feedback Items"],
    createError: (message) => new RevisionPlanOutputContractError(message),
  });
  const result: RevisionPlanResult = {
    ...value,
    feedbackItems: value.feedbackItems.map((item, index) => ({
      id: requireTrimmed(item.id, `feedbackItems[${index}].id`),
      sourceIds: uniqueTrimmed(item.sourceIds, `feedbackItems[${index}].sourceIds`),
      summary: requireTrimmed(item.summary, `feedbackItems[${index}].summary`),
      classification: item.classification,
      rationale: requireTrimmed(item.rationale, `feedbackItems[${index}].rationale`),
    })),
    ...(additionalSections === undefined ? {} : { additionalSections }),
  };
  assertUniqueFeedbackIds(result);
  if (validSourceIds) assertValidFeedbackSources(result, validSourceIds);
  const expectedStatus: RevisionPlanStatus = result.feedbackItems.some((item) => item.classification === "needs-human")
    ? "needs-human"
    : result.feedbackItems.some((item) => item.classification === "must-fix-current")
      ? "revise"
      : "no-action-needed";
  if (result.status !== expectedStatus) {
    throw new RevisionPlanOutputContractError(
      `Revision plan status '${result.status}' conflicts with its actionable items; expected '${expectedStatus}'.`,
    );
  }
  return result;
}

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
    createError: (message) => new RevisionPlanOutputContractError(message),
  };
}

function requireTrimmed(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new RevisionPlanOutputContractError(`Revision plan ${field} must not be blank.`);
  return trimmed;
}

function uniqueTrimmed(values: readonly string[], field: string): string[] {
  const trimmed = values.map((value, index) => requireTrimmed(value, `${field}[${index}]`));
  if (new Set(trimmed).size !== trimmed.length) throw new RevisionPlanOutputContractError(`Revision plan ${field} must not contain duplicates.`);
  return trimmed;
}

function assertUniqueFeedbackIds(result: RevisionPlanResult): void {
  const ids = result.feedbackItems.map((item) => item.id);
  if (new Set(ids).size !== ids.length) throw new RevisionPlanOutputContractError("Revision plan feedback item ids must be unique.");
}

function assertValidFeedbackSources(result: RevisionPlanResult, validSourceIds: ReadonlySet<string>): void {
  for (const item of result.feedbackItems) {
    const unknown = item.sourceIds.filter((sourceId) => !validSourceIds.has(sourceId));
    if (unknown.length > 0) {
      throw new RevisionPlanOutputContractError(`Revision plan feedback item '${item.id}' references unknown source ids: ${unknown.join(", ")}.`);
    }
    if (!item.sourceIds.some((sourceId) => item.id === sourceId || item.id.startsWith(`${sourceId}#`))) {
      throw new RevisionPlanOutputContractError(`Revision plan feedback item id '${item.id}' must derive from one of its source ids.`);
    }
  }
}

function renderFeedbackItems(result: RevisionPlanResult): string[] {
  if (result.feedbackItems.length === 0) return ["None."];
  return result.feedbackItems.map((item) =>
    `- \`${item.id}\` [${item.classification}] ${item.summary} — ${item.rationale} (sources: ${item.sourceIds.join(", ")})`);
}
