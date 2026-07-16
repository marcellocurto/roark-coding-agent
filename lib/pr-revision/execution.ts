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
import type { RevisionFeedbackClassification, RevisionPlanResult } from "./plan.ts";

const nonEmptyString = (description: string) => Type.String({ minLength: 1, description });
const feedbackDispositionStatusSchema = Type.Union([
  Type.Literal("addressed"),
  Type.Literal("already-addressed"),
  Type.Literal("needs-human"),
  Type.Literal("not-actionable"),
  Type.Literal("skipped"),
]);

export const revisionExecutionResultSchema = Type.Object({
  summary: nonEmptyString("Concise account of the completed revision work."),
  feedbackDispositions: Type.Array(Type.Object({
    feedbackId: nonEmptyString("Stable id of the corresponding revision-plan feedback item."),
    status: feedbackDispositionStatusSchema,
    details: nonEmptyString("Concrete resolution or reason for the final disposition."),
  }, { additionalProperties: false })),
  changedFiles: Type.Array(changedFileSchema),
  validation: Type.Array(validationEntrySchema, { minItems: 1 }),
  additionalSections: Type.Optional(additionalSectionsSchema),
}, { additionalProperties: false });

export type RevisionExecutionResult = Static<typeof revisionExecutionResultSchema>;
export type RevisionFeedbackDispositionStatus = RevisionExecutionResult["feedbackDispositions"][number]["status"];

export interface RevisionFeedbackDisposition {
  feedbackId: string;
  sourceIds: string[];
  summary: string;
  classification: RevisionFeedbackClassification;
  status: RevisionFeedbackDispositionStatus;
  details: string;
}

export class RevisionExecutionOutputContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RevisionExecutionOutputContractError";
  }
}

export function validateRevisionExecutionResult(value: unknown, plan?: RevisionPlanResult): RevisionExecutionResult {
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
        "Feedback Dispositions",
        "Changed Files",
        "Validation Performed",
      ],
      createError: (message) => new RevisionExecutionOutputContractError(message),
    });
    const result = {
      summary: common.summary,
      feedbackDispositions: value.feedbackDispositions.map((entry, index) => ({
        feedbackId: requireTrimmed(entry.feedbackId, `feedbackDispositions[${index}].feedbackId`),
        status: entry.status,
        details: requireTrimmed(entry.details, `feedbackDispositions[${index}].details`),
      })),
      changedFiles: common.changedFiles,
      validation: common.validation,
      ...(additionalSections === undefined ? {} : { additionalSections }),
    } satisfies RevisionExecutionResult;
    assertUniqueDispositionIds(result);
    if (plan) assertCompleteDispositionLinkage(result, plan);
    return result;
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
    "## Feedback Dispositions",
    ...renderDispositions(result),
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
  plan: RevisionPlanResult,
): StructuredArtifactDefinition<RevisionExecutionResult> {
  return {
    toolName: "submit_revision_execution",
    label: "Revision Execution",
    noun: "revision execution result",
    parameters: revisionExecutionResultSchema,
    validate: (value) => validateRevisionExecutionResult(value, plan),
    formatMarkdown: (result) => formatRevisionExecutionMarkdown(result, title),
    createError: (message) => new RevisionExecutionOutputContractError(message),
  };
}

export function revisionFeedbackDispositions(
  plan: RevisionPlanResult,
  execution?: RevisionExecutionResult,
): RevisionFeedbackDisposition[] {
  const byId = new Map(execution?.feedbackDispositions.map((item) => [item.feedbackId, item]));
  return plan.feedbackItems.map((item) => {
    const executed = byId.get(item.id);
    return {
      feedbackId: item.id,
      sourceIds: item.sourceIds,
      summary: item.summary,
      classification: item.classification,
      status: executed?.status ?? expectedNonExecutionStatus(item.classification),
      details: executed?.details ?? item.rationale,
    };
  });
}

function requireTrimmed(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new RevisionExecutionOutputContractError(`Revision execution ${field} must not be blank.`);
  return trimmed;
}

function assertUniqueDispositionIds(result: RevisionExecutionResult): void {
  const ids = result.feedbackDispositions.map((item) => item.feedbackId);
  if (new Set(ids).size !== ids.length) {
    throw new RevisionExecutionOutputContractError("Revision execution feedback disposition ids must be unique.");
  }
}

function assertCompleteDispositionLinkage(result: RevisionExecutionResult, plan: RevisionPlanResult): void {
  const expected = new Map(plan.feedbackItems.map((item) => [item.id, item.classification]));
  const actual = new Set(result.feedbackDispositions.map((item) => item.feedbackId));
  const missing = [...expected.keys()].filter((id) => !actual.has(id));
  const unknown = [...actual].filter((id) => !expected.has(id));
  if (missing.length > 0 || unknown.length > 0) {
    throw new RevisionExecutionOutputContractError(
      `Revision execution must disposition every planned feedback item exactly once; missing: ${missing.join(", ") || "none"}; unknown: ${unknown.join(", ") || "none"}.`,
    );
  }
  for (const disposition of result.feedbackDispositions) {
    const classification = expected.get(disposition.feedbackId);
    if (classification && !statusMatchesClassification(disposition.status, classification)) {
      throw new RevisionExecutionOutputContractError(
        `Revision execution disposition '${disposition.status}' conflicts with classification '${classification}' for '${disposition.feedbackId}'.`,
      );
    }
  }
}

function statusMatchesClassification(status: RevisionFeedbackDispositionStatus, classification: RevisionFeedbackClassification): boolean {
  if (classification === "must-fix-current") return status === "addressed" || status === "skipped";
  return status === expectedNonExecutionStatus(classification);
}

function expectedNonExecutionStatus(classification: RevisionFeedbackClassification): RevisionFeedbackDispositionStatus {
  if (classification === "already-addressed") return "already-addressed";
  if (classification === "needs-human") return "needs-human";
  if (classification === "must-fix-current") return "skipped";
  return "not-actionable";
}

function renderDispositions(result: RevisionExecutionResult): string[] {
  if (result.feedbackDispositions.length === 0) return ["None."];
  return result.feedbackDispositions.map((item) => `- \`${item.feedbackId}\` [${item.status}] ${item.details}`);
}
