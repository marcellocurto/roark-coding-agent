import { trimmedText, trimmedScalar } from "../structured-output/fields.ts";
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
const implementationPlanResultSchemaShape = Schema.Struct({
  issue: trimmedScalar("Issue or requirement being planned."),
  workClassification: Schema.Union([
    Schema.Literal("frontend"),
    Schema.Literal("backend"),
    Schema.Literal("full-stack"),
    Schema.Literal("docs-config"),
    Schema.Literal("test-only"),
    Schema.Literal("unknown"),
  ]),
  goal: trimmedScalar("Concrete implementation goal."),
  nonGoals: Schema.mutable(
    Schema.Array(trimmedText("Explicitly excluded work.")),
  ),
  currentCodeFindings: Schema.mutable(
    Schema.Array(
      trimmedText("Repository-grounded finding relevant to the plan."),
    ),
  ),
  simplificationsFromDraft: Schema.mutable(
    Schema.Array(
      trimmedText("Complexity removed or narrowed during refinement."),
    ),
  ),
  proposedChanges: Schema.mutable(
    Schema.Array(trimmedText("Concrete proposed behavior or code change.")),
  ),
  filesLikelyToChange: Schema.mutable(
    Schema.Array(
      trimmedText("Repository-relative file likely to change and why."),
    ),
  ),
  detailedSteps: Schema.mutable(
    Schema.Array(trimmedText("Ordered implementation step.")),
  ),
  testsAndValidation: Schema.mutable(
    Schema.Array(
      trimmedText("Validation step and the regression it protects against."),
    ),
  ),
  risks: Schema.mutable(
    Schema.Array(trimmedText("Concrete implementation risk.")),
  ),
  rollbackPlan: Schema.mutable(
    Schema.Array(trimmedText("Concrete rollback action.")),
  ),
  readyForImplementation: Schema.Boolean,
  additionalSections: Schema.optional(additionalSectionsSchema),
});
export type ImplementationPlanResult =
  (typeof implementationPlanResultSchemaShape)["Type"];
export type ImplementationPlanKind = "draft" | "final";
const normalizeImplementationPlanResult = Effect.fnUntraced(function* (
  value: ImplementationPlanResult,
): Effect.fn.Return<ImplementationPlanResult, SchemaIssue.Issue> {
  const additionalSections = yield* normalizeAdditionalSections(
    value.additionalSections,
    {
      artifactLabel: "Implementation plan",
      reservedHeadings: implementationPlanHeadings,
    },
  );
  const result: ImplementationPlanResult = {
    ...value,
    ...(additionalSections === undefined ? {} : { additionalSections }),
  };
  if (result.readyForImplementation) {
    const missing = [
      result.proposedChanges.length === 0 ? "proposedChanges" : undefined,
      result.filesLikelyToChange.length === 0
        ? "filesLikelyToChange"
        : undefined,
      result.detailedSteps.length === 0 ? "detailedSteps" : undefined,
      result.testsAndValidation.length === 0 ? "testsAndValidation" : undefined,
    ].filter((field): field is string => field !== undefined);
    if (missing.length > 0) {
      return yield* invalidArtifact(
        `An implementation-ready plan requires non-empty ${missing.join(", ")}.`,
      );
    }
  }
  return result;
});
export function formatImplementationPlanMarkdown(
  result: ImplementationPlanResult,
  kind: ImplementationPlanKind,
): string {
  const lines = [
    `# Implementation Plan${kind === "draft" ? " Draft" : ""}`,
    "",
    "## Issue",
    result.issue,
    "",
    "## Work Classification",
    result.workClassification,
    "",
    "## Goal",
    result.goal,
    "",
    "## Non-Goals",
    ...renderList(result.nonGoals),
    "",
    "## Current Code Findings",
    ...renderList(result.currentCodeFindings),
  ];
  if (kind === "final") {
    lines.push(
      "",
      "## Simplifications From Draft",
      ...renderList(result.simplificationsFromDraft),
    );
  }
  lines.push(
    "",
    "## Proposed Changes",
    ...renderList(result.proposedChanges),
    "",
    "## Files Likely To Change",
    ...renderList(result.filesLikelyToChange),
    "",
    "## Detailed Steps",
    ...renderNumberedList(result.detailedSteps),
    "",
    "## Tests And Validation",
    ...renderList(result.testsAndValidation),
    "",
    "## Risks",
    ...renderList(result.risks),
    "",
    "## Rollback Plan",
    ...renderList(result.rollbackPlan),
    "",
    "## Ready For Implementation",
    result.readyForImplementation ? "yes" : "no",
    "",
    ...renderAdditionalSectionsMarkdown(result.additionalSections),
  );
  return lines.join("\n");
}
const implementationPlanHeadings = [
  "Issue",
  "Work Classification",
  "Goal",
  "Non-Goals",
  "Current Code Findings",
  "Simplifications From Draft",
  "Proposed Changes",
  "Files Likely To Change",
  "Detailed Steps",
  "Tests And Validation",
  "Risks",
  "Rollback Plan",
  "Ready For Implementation",
] as const;
const contract = artifactContract(
  "Implementation plan",
  implementationPlanResultSchemaShape.pipe(
    Schema.decode({
      decode: SchemaGetter.transformOrFail(normalizeImplementationPlanResult),
      encode: SchemaGetter.passthrough(),
    }),
  ),
);
export const validateImplementationPlanResult = contract.decode;
export const parseImplementationPlanResultJson = contract.parse;
export const implementationPlanResultSchema = Schema.toEncoded(
  implementationPlanResultSchemaShape,
);
export function implementationPlanArtifactDefinition(
  kind: ImplementationPlanKind,
): StructuredArtifactDefinition<ImplementationPlanResult> {
  return {
    toolName: "submit_implementation_plan",
    label: "Implementation Plan",
    noun: "implementation plan",
    parameters: implementationPlanResultSchema,
    validate: validateImplementationPlanResult,
    formatMarkdown: (result) => formatImplementationPlanMarkdown(result, kind),
  };
}
function renderList(values: readonly string[]): string[] {
  return values.length === 0 ? ["None."] : values.map((value) => `- ${value}`);
}
function renderNumberedList(values: readonly string[]): string[] {
  return values.length === 0
    ? ["None."]
    : values.map((value, index) => `${index + 1}. ${value}`);
}
