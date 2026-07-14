import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import type { StructuredArtifactDefinition } from "../structured-output/runner.ts";
import {
  additionalSectionsSchema,
  normalizeAdditionalSections,
  renderAdditionalSectionsMarkdown,
} from "../structured-output/additional-sections.ts";

export type RevisionPlanStatus = "revise" | "needs-human" | "no-action-needed";

const nonEmptyString = (description: string) => Type.String({ minLength: 1, description });

export const revisionPlanResultSchema = Type.Object({
  status: Type.Union([
    Type.Literal("revise"),
    Type.Literal("needs-human"),
    Type.Literal("no-action-needed"),
  ]),
  classifiedFeedback: Type.Array(nonEmptyString("Concise feedback item with its classification, source, and rationale.")),
  mustFixCurrent: Type.Array(nonEmptyString("Concrete feedback item that must be fixed in this revision.")),
  humanNeeds: Type.Array(nonEmptyString("Decision, information, or access required from a human.")),
  additionalSections: Type.Optional(additionalSectionsSchema),
}, { additionalProperties: false });

export type RevisionPlanResult = Static<typeof revisionPlanResultSchema>;

export class RevisionPlanOutputContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RevisionPlanOutputContractError";
  }
}

export function validateRevisionPlanResult(value: unknown): RevisionPlanResult {
  if (!Value.Check(revisionPlanResultSchema, value)) {
    const first = Value.Errors(revisionPlanResultSchema, value)[0];
    const location = first?.instancePath ?? first?.schemaPath ?? "revision plan";
    throw new RevisionPlanOutputContractError(`Revision plan does not satisfy the structured contract at ${location}.`);
  }

  const additionalSections = normalizeAdditionalSections(value.additionalSections, {
    artifactLabel: "Revision plan",
    reservedHeadings: ["Status", "Classified Feedback", "Must Fix Current Items", "Human Needs"],
    createError: (message) => new RevisionPlanOutputContractError(message),
  });
  const result: RevisionPlanResult = {
    ...value,
    classifiedFeedback: trimItems(value.classifiedFeedback, "classifiedFeedback"),
    mustFixCurrent: trimItems(value.mustFixCurrent, "mustFixCurrent"),
    humanNeeds: trimItems(value.humanNeeds, "humanNeeds"),
    ...(additionalSections === undefined ? {} : { additionalSections }),
  };
  const expectedStatus: RevisionPlanStatus = result.humanNeeds.length > 0
    ? "needs-human"
    : result.mustFixCurrent.length > 0
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
    "## Classified Feedback",
    ...renderList(result.classifiedFeedback),
    "",
    "## Must Fix Current Items",
    ...renderList(result.mustFixCurrent),
    "",
    "## Human Needs",
    ...renderList(result.humanNeeds),
    "",
    ...renderAdditionalSectionsMarkdown(result.additionalSections),
  ].join("\n");
}

export const revisionPlanArtifactDefinition: StructuredArtifactDefinition<RevisionPlanResult> = {
  toolName: "submit_revision_plan",
  label: "Revision Plan",
  noun: "revision plan",
  parameters: revisionPlanResultSchema,
  validate: validateRevisionPlanResult,
  formatMarkdown: formatRevisionPlanMarkdown,
  createError: (message) => new RevisionPlanOutputContractError(message),
};

function trimItems(values: string[], field: string): string[] {
  return values.map((value, index) => {
    const trimmed = value.trim();
    if (!trimmed) throw new RevisionPlanOutputContractError(`Revision plan ${field}[${index}] must not be blank.`);
    return trimmed;
  });
}

function renderList(values: readonly string[]): string[] {
  return values.length === 0 ? ["None."] : values.map((value) => `- ${value}`);
}
