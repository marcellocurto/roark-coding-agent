import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import {
  changedFileSchema,
  validationEntrySchema,
  validateChangeReport,
} from "../change-report/result.ts";
import type { StructuredArtifactDefinition } from "../structured-output/runner.ts";
import {
  additionalSectionsSchema,
  normalizeAdditionalSections,
  renderAdditionalSectionsMarkdown,
} from "../structured-output/additional-sections.ts";

const nonEmptyString = (description: string) => Type.String({ minLength: 1, description });

export const revisionExecutionResultSchema = Type.Object({
  summary: nonEmptyString("Concise account of the completed revision work."),
  addressedItems: Type.Array(Type.Object({
    item: nonEmptyString("Must-fix plan item or review finding that was addressed."),
    resolution: nonEmptyString("Concrete change that addressed the item."),
  }, { additionalProperties: false })),
  skippedItems: Type.Array(Type.Object({
    item: nonEmptyString("Feedback or requested work that was not changed."),
    reason: nonEmptyString("Concrete reason the item was skipped."),
  }, { additionalProperties: false })),
  changedFiles: Type.Array(changedFileSchema),
  validation: Type.Array(validationEntrySchema, { minItems: 1 }),
  additionalSections: Type.Optional(additionalSectionsSchema),
}, { additionalProperties: false });

export type RevisionExecutionResult = Static<typeof revisionExecutionResultSchema>;

export class RevisionExecutionOutputContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RevisionExecutionOutputContractError";
  }
}

export function validateRevisionExecutionResult(value: unknown): RevisionExecutionResult {
  if (!Value.Check(revisionExecutionResultSchema, value)) {
    const first = Value.Errors(revisionExecutionResultSchema, value)[0];
    const location = first?.instancePath ?? first?.schemaPath ?? "revision execution result";
    throw new RevisionExecutionOutputContractError(`Revision execution result does not satisfy the structured contract at ${location}.`);
  }

  try {
    const common = validateChangeReport({
      summary: value.summary,
      changedFiles: value.changedFiles,
      validation: value.validation,
      deviations: [],
      addressedFindingIds: [],
      remainingConcerns: [],
    });
    const additionalSections = normalizeAdditionalSections(value.additionalSections, {
      artifactLabel: "Revision execution",
      reservedHeadings: [
        "Summary",
        "Addressed Must Fix Current Items",
        "Skipped Items",
        "Changed Files",
        "Validation Performed",
      ],
      createError: (message) => new RevisionExecutionOutputContractError(message),
    });
    return {
      summary: common.summary,
      addressedItems: value.addressedItems.map((entry, index) => ({
        item: requireTrimmed(entry.item, `addressedItems[${index}].item`),
        resolution: requireTrimmed(entry.resolution, `addressedItems[${index}].resolution`),
      })),
      skippedItems: value.skippedItems.map((entry, index) => ({
        item: requireTrimmed(entry.item, `skippedItems[${index}].item`),
        reason: requireTrimmed(entry.reason, `skippedItems[${index}].reason`),
      })),
      changedFiles: common.changedFiles,
      validation: common.validation,
      ...(additionalSections === undefined ? {} : { additionalSections }),
    };
  } catch (error) {
    if (error instanceof RevisionExecutionOutputContractError) throw error;
    throw new RevisionExecutionOutputContractError(error instanceof Error ? error.message : String(error));
  }
}

export function parseRevisionExecutionResultJson(content: string): RevisionExecutionResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new RevisionExecutionOutputContractError(`Revision execution artifact is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return validateRevisionExecutionResult(parsed);
}

export function formatRevisionExecutionMarkdown(result: RevisionExecutionResult, title: string): string {
  return [
    `# ${title}`,
    "",
    "## Summary",
    result.summary,
    "",
    "## Addressed Must Fix Current Items",
    ...renderAddressed(result),
    "",
    "## Skipped Items",
    ...renderSkipped(result),
    "",
    "## Changed Files",
    ...(result.changedFiles.length === 0
      ? ["None."]
      : result.changedFiles.map((file) => `- \`${file.path}\` — ${file.description}`)),
    "",
    "## Validation Performed",
    ...result.validation.map((entry) => `- \`${entry.command}\` — ${entry.status}: ${entry.details}`),
    "",
    ...renderAdditionalSectionsMarkdown(result.additionalSections),
  ].join("\n");
}

export function revisionExecutionArtifactDefinition(
  title: string,
): StructuredArtifactDefinition<RevisionExecutionResult> {
  return {
    toolName: "submit_revision_execution",
    label: "Revision Execution",
    noun: "revision execution result",
    parameters: revisionExecutionResultSchema,
    validate: validateRevisionExecutionResult,
    formatMarkdown: (result) => formatRevisionExecutionMarkdown(result, title),
    createError: (message) => new RevisionExecutionOutputContractError(message),
  };
}

export function addressedRevisionItems(result: RevisionExecutionResult): string[] {
  return result.addressedItems.map((entry) => `${entry.item} — ${entry.resolution}`);
}

export function skippedRevisionItems(result: RevisionExecutionResult): string[] {
  return result.skippedItems.map((entry) => `${entry.item} — ${entry.reason}`);
}

function requireTrimmed(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new RevisionExecutionOutputContractError(`Revision execution ${field} must not be blank.`);
  return trimmed;
}

function renderAddressed(result: RevisionExecutionResult): string[] {
  return result.addressedItems.length === 0
    ? ["None."]
    : addressedRevisionItems(result).map((item) => `- ${item}`);
}

function renderSkipped(result: RevisionExecutionResult): string[] {
  return result.skippedItems.length === 0
    ? ["None."]
    : skippedRevisionItems(result).map((item) => `- ${item}`);
}
