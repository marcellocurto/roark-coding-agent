import { trimmedText, trimmedScalar } from "../structured-output/fields.ts";
import { Effect, SchemaGetter, type SchemaIssue } from "effect";
import {
  artifactContract,
  ArtifactContractError,
  invalidArtifact,
} from "../structured-output/contract.ts";
import { Schema } from "effect";
import type { StructuredArtifactDefinition } from "../structured-output/runner.ts";
import type { TriageResult } from "../triage/result.ts";
import {
  additionalSectionsSchema,
  normalizeAdditionalSections,
  renderAdditionalSectionsMarkdown,
} from "../structured-output/additional-sections.ts";
const implementationPlanResultSchemaShape = Schema.Struct({
  source: trimmedText(
    "Where the plan came from: an issue section, comment, or Roark draft. Keep its required decisions and detailed steps.",
  ),
  adaptations: Schema.mutable(
    Schema.Array(
      Schema.Struct({
        change: trimmedText(
          "What changed from the original plan. Leave out wording-only edits.",
        ),
        evidence: trimmedText(
          "What in the issue or code made this change necessary.",
        ),
      }),
    ),
  ),
  assumptions: Schema.mutable(
    Schema.Array(
      Schema.Struct({
        assumption: trimmedText(
          "A small assumption you are allowed to make. Any changes based on it must be easy to undo.",
        ),
        evidence: trimmedText(
          "What in the issue or code supports this assumption.",
        ),
      }),
    ),
  ),
  blockingQuestions: Schema.mutable(
    Schema.Array(
      trimmedText(
        "A question that needs information from the reporter or a decision from someone allowed to make it. List it here, even if it also appears in risks or another section.",
      ),
    ),
  ),
  externalBlockers: Schema.mutable(
    Schema.Array(
      trimmedText(
        "Something outside this work that must be resolved first. Explain how you checked it and what needs to happen next.",
      ),
    ),
  ),
  resolvedQuestions: Schema.mutable(
    Schema.Array(
      Schema.Struct({
        question: trimmedText("An earlier question, using its exact wording."),
        resolution: trimmedText(
          "The answer found in the code or given by someone allowed to decide.",
        ),
        evidence: trimmedText(
          "Where in the code or issue the answer was confirmed. A guess does not count as an answer.",
        ),
      }),
    ),
  ),
  issue: trimmedScalar("The issue or requested change this plan covers."),
  workClassification: Schema.Union([
    Schema.Literal("frontend"),
    Schema.Literal("backend"),
    Schema.Literal("full-stack"),
    Schema.Literal("docs-config"),
    Schema.Literal("test-only"),
    Schema.Literal("unknown"),
  ]),
  goal: trimmedScalar("What the finished change should do."),
  nonGoals: Schema.mutable(
    Schema.Array(trimmedText("Work this plan does not include.")),
  ),
  currentCodeFindings: Schema.mutable(
    Schema.Array(
      trimmedText("Something found in the code that affects this plan."),
    ),
  ),
  simplificationsFromDraft: Schema.mutable(
    Schema.Array(trimmedText("What was made simpler when checking the draft.")),
  ),
  proposedChanges: Schema.mutable(
    Schema.Array(trimmedText("A planned change to the behavior or code.")),
  ),
  filesLikelyToChange: Schema.mutable(
    Schema.Array(
      trimmedText(
        "A file likely to change and why. Use a path relative to the repository root.",
      ),
    ),
  ),
  detailedSteps: Schema.mutable(
    Schema.Array(
      trimmedText(
        "A step to follow. List the steps in the order they should happen.",
      ),
    ),
  ),
  testsAndValidation: Schema.mutable(
    Schema.Array(trimmedText("A check to run and the problem it would catch.")),
  ),
  risks: Schema.mutable(
    Schema.Array(trimmedText("A specific problem this change could cause.")),
  ),
  rollbackPlan: Schema.mutable(
    Schema.Array(trimmedText("A step to undo the change if needed.")),
  ),
  readyForImplementation: Schema.Boolean,
  additionalSections: Schema.optional(additionalSectionsSchema),
});
export type ImplementationPlanResult =
  (typeof implementationPlanResultSchemaShape)["Type"];
export type ImplementationPlanKind = "draft" | "final";
export const requireImplementationPlanSource = Effect.fn(
  "requireImplementationPlanSource",
)(function* (plan: ImplementationPlanResult, triage: TriageResult) {
  if (triage.planAction !== "draft" && plan.source !== triage.planSource)
    return yield* Effect.fail(
      new ArtifactContractError({
        artifact: "Implementation plan",
        message:
          "The plan source does not match the source selected during triage. Run continue to check the latest discussion before using the saved code or reviews.",
      }),
    );
  return plan;
});
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
    if (
      result.blockingQuestions.length > 0 ||
      result.externalBlockers.length > 0
    )
      return yield* invalidArtifact(
        "A ready plan cannot contain blocking questions or external blockers.",
      );
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
        `Before marking the plan ready, fill in ${missing.join(", ")}.`,
      );
    }
  }
  if (
    !result.readyForImplementation &&
    result.blockingQuestions.length === 0 &&
    result.externalBlockers.length === 0
  )
    return yield* invalidArtifact(
      "If the plan is not ready, list the questions or blockers that need to be resolved.",
    );
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
    "## Source",
    result.source,
    "",
    "## Adaptations",
    ...renderList(
      result.adaptations.map(
        (item) => `${item.change} Evidence: ${item.evidence}`,
      ),
    ),
    "",
    "## Assumptions",
    ...renderList(
      result.assumptions.map(
        (item) => `${item.assumption} Evidence: ${item.evidence}`,
      ),
    ),
    "",
    "## Blocking Questions",
    ...renderList(result.blockingQuestions),
    "",
    "## External Blockers",
    ...renderList(result.externalBlockers),
    "",
    "## Resolved Questions",
    ...renderList(
      result.resolvedQuestions.map(
        (item) =>
          `${item.question} Answer: ${item.resolution} Evidence: ${item.evidence}`,
      ),
    ),
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
  "Source",
  "Adaptations",
  "Assumptions",
  "Blocking Questions",
  "External Blockers",
  "Resolved Questions",
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
