import {
  trimmedText,
  changedFilesSchema,
  validationEntriesSchema,
} from "../structured-output/fields.ts";
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
import type {
  RevisionFeedbackClassification,
  RevisionPlanResult,
} from "./plan.ts";
const feedbackDispositionStatusSchema = Schema.Union([
  Schema.Literal("addressed"),
  Schema.Literal("already-addressed"),
  Schema.Literal("needs-human"),
  Schema.Literal("not-actionable"),
  Schema.Literal("skipped"),
]);
const revisionExecutionResultSchemaShape = Schema.Struct({
  summary: trimmedText("Concise account of the completed revision work."),
  feedbackDispositions: Schema.mutable(
    Schema.Array(
      Schema.Struct({
        feedbackId: trimmedText(
          "Stable id of the corresponding revision-plan feedback item.",
        ),
        status: feedbackDispositionStatusSchema,
        details: trimmedText(
          "Concrete resolution or reason for the final disposition.",
        ),
      }),
    ),
  ),
  changedFiles: changedFilesSchema,
  validation: validationEntriesSchema,
  additionalSections: Schema.optional(additionalSectionsSchema),
});
export type RevisionExecutionResult =
  (typeof revisionExecutionResultSchemaShape)["Type"];
export type RevisionFeedbackDispositionStatus =
  RevisionExecutionResult["feedbackDispositions"][number]["status"];
export interface RevisionFeedbackDisposition {
  feedbackId: string;
  sourceIds: string[];
  summary: string;
  classification: RevisionFeedbackClassification;
  status: RevisionFeedbackDispositionStatus;
  details: string;
}
const normalizeRevisionExecutionResult = Effect.fnUntraced(function* (
  value: RevisionExecutionResult,
  plan?: RevisionPlanResult,
): Effect.fn.Return<RevisionExecutionResult, SchemaIssue.Issue> {
  const additionalSections = yield* normalizeAdditionalSections(
    value.additionalSections,
    {
      artifactLabel: "Revision execution",
      reservedHeadings: [
        "Summary",
        "Feedback Dispositions",
        "Changed Files",
        "Validation Performed",
      ],
    },
  );
  const result = {
    ...value,
    ...(additionalSections === undefined ? {} : { additionalSections }),
  } satisfies RevisionExecutionResult;
  yield* assertUniqueDispositionIds(result);
  if (plan) yield* assertCompleteDispositionLinkage(result, plan);
  return result;
});
export function formatRevisionExecutionMarkdown(
  result: RevisionExecutionResult,
  title: string,
): string {
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
      : result.changedFiles.map(
          (file) => `- \`${file.path}\` — ${file.description}`,
        )),
    "",
    "## Validation Performed",
    ...result.validation.map(
      (entry) => `- \`${entry.command}\` — ${entry.status}: ${entry.details}`,
    ),
    "",
    ...renderAdditionalSectionsMarkdown(result.additionalSections),
  ].join("\n");
}
const contract = (plan?: RevisionPlanResult) =>
  artifactContract(
    "Revision execution",
    revisionExecutionResultSchemaShape.pipe(
      Schema.decode({
        decode: SchemaGetter.transformOrFail((value) =>
          normalizeRevisionExecutionResult(value, plan),
        ),
        encode: SchemaGetter.passthrough(),
      }),
    ),
  );
export const validateRevisionExecutionResult = Effect.fnUntraced(function* (
  value: unknown,
  plan?: RevisionPlanResult,
) {
  return yield* contract(plan).decode(value);
});
export const parseRevisionExecutionResultJson = Effect.fnUntraced(function* (
  content: string,
) {
  return yield* contract(undefined).parse(content);
});
export const revisionExecutionResultSchema = Schema.toEncoded(
  revisionExecutionResultSchemaShape,
);
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
  };
}
export function revisionFeedbackDispositions(
  plan: RevisionPlanResult,
  execution?: RevisionExecutionResult,
): RevisionFeedbackDisposition[] {
  const byId = new Map(
    execution?.feedbackDispositions.map((item) => [item.feedbackId, item]),
  );
  return plan.feedbackItems.map((item) => {
    const executed = byId.get(item.id);
    return {
      feedbackId: item.id,
      sourceIds: item.sourceIds,
      summary: item.summary,
      classification: item.classification,
      status:
        executed?.status ?? expectedNonExecutionStatus(item.classification),
      details: executed?.details ?? item.rationale,
    };
  });
}
const assertUniqueDispositionIds = Effect.fnUntraced(function* (
  result: RevisionExecutionResult,
): Effect.fn.Return<void, SchemaIssue.Issue> {
  const ids = result.feedbackDispositions.map((item) => item.feedbackId);
  if (new Set(ids).size !== ids.length) {
    return yield* invalidArtifact(
      "Revision execution feedback disposition ids must be unique.",
    );
  }
});
const assertCompleteDispositionLinkage = Effect.fnUntraced(function* (
  result: RevisionExecutionResult,
  plan: RevisionPlanResult,
): Effect.fn.Return<void, SchemaIssue.Issue> {
  const expected = new Map(
    plan.feedbackItems.map((item) => [item.id, item.classification]),
  );
  const actual = new Set(
    result.feedbackDispositions.map((item) => item.feedbackId),
  );
  const missing = [...expected.keys()].filter((id) => !actual.has(id));
  const unknown = [...actual].filter((id) => !expected.has(id));
  if (missing.length > 0 || unknown.length > 0) {
    return yield* invalidArtifact(
      `Revision execution must disposition every planned feedback item exactly once; missing: ${missing.join(", ") || "none"}; unknown: ${unknown.join(", ") || "none"}.`,
    );
  }
  for (const disposition of result.feedbackDispositions) {
    const classification = expected.get(disposition.feedbackId);
    if (
      classification &&
      !statusMatchesClassification(disposition.status, classification)
    ) {
      return yield* invalidArtifact(
        `Revision execution disposition '${disposition.status}' conflicts with classification '${classification}' for '${disposition.feedbackId}'.`,
      );
    }
  }
});
function statusMatchesClassification(
  status: RevisionFeedbackDispositionStatus,
  classification: RevisionFeedbackClassification,
): boolean {
  if (classification === "must-fix-current")
    return status === "addressed" || status === "skipped";
  return status === expectedNonExecutionStatus(classification);
}
function expectedNonExecutionStatus(
  classification: RevisionFeedbackClassification,
): RevisionFeedbackDispositionStatus {
  if (classification === "already-addressed") return "already-addressed";
  if (classification === "needs-human") return "needs-human";
  if (classification === "must-fix-current") return "skipped";
  return "not-actionable";
}
function renderDispositions(result: RevisionExecutionResult): string[] {
  if (result.feedbackDispositions.length === 0) return ["None."];
  return result.feedbackDispositions.map(
    (item) => `- \`${item.feedbackId}\` [${item.status}] ${item.details}`,
  );
}
