import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import type { StructuredArtifactDefinition } from "../structured-output/runner.ts";

const nonEmptyString = (description: string) => Type.String({ minLength: 1, description });

export const implementationPlanResultSchema = Type.Object({
  issue: nonEmptyString("Issue or requirement being planned."),
  workClassification: Type.Union([
    Type.Literal("frontend"),
    Type.Literal("backend"),
    Type.Literal("full-stack"),
    Type.Literal("docs-config"),
    Type.Literal("test-only"),
    Type.Literal("unknown"),
  ]),
  goal: nonEmptyString("Concrete implementation goal."),
  nonGoals: Type.Array(nonEmptyString("Explicitly excluded work.")),
  currentCodeFindings: Type.Array(nonEmptyString("Repository-grounded finding relevant to the plan.")),
  simplificationsFromDraft: Type.Array(nonEmptyString("Complexity removed or narrowed during refinement.")),
  proposedChanges: Type.Array(nonEmptyString("Concrete proposed behavior or code change.")),
  filesLikelyToChange: Type.Array(nonEmptyString("Repository-relative file likely to change and why.")),
  detailedSteps: Type.Array(nonEmptyString("Ordered implementation step.")),
  testsAndValidation: Type.Array(nonEmptyString("Validation step and the regression it protects against.")),
  risks: Type.Array(nonEmptyString("Concrete implementation risk.")),
  rollbackPlan: Type.Array(nonEmptyString("Concrete rollback action.")),
  readyForImplementation: Type.Boolean(),
}, { additionalProperties: false });

export type ImplementationPlanResult = Static<typeof implementationPlanResultSchema>;
export type ImplementationPlanKind = "draft" | "final";

export class ImplementationPlanOutputContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImplementationPlanOutputContractError";
  }
}

export function validateImplementationPlanResult(value: unknown): ImplementationPlanResult {
  if (!Value.Check(implementationPlanResultSchema, value)) {
    const first = Value.Errors(implementationPlanResultSchema, value)[0];
    const location = first?.instancePath ?? first?.schemaPath ?? "implementation plan";
    throw new ImplementationPlanOutputContractError(`Implementation plan does not satisfy the structured contract at ${location}.`);
  }
  const result: ImplementationPlanResult = {
    ...value,
    issue: value.issue.trim(),
    goal: value.goal.trim(),
    nonGoals: trimItems(value.nonGoals, "nonGoals"),
    currentCodeFindings: trimItems(value.currentCodeFindings, "currentCodeFindings"),
    simplificationsFromDraft: trimItems(value.simplificationsFromDraft, "simplificationsFromDraft"),
    proposedChanges: trimItems(value.proposedChanges, "proposedChanges"),
    filesLikelyToChange: trimItems(value.filesLikelyToChange, "filesLikelyToChange"),
    detailedSteps: trimItems(value.detailedSteps, "detailedSteps"),
    testsAndValidation: trimItems(value.testsAndValidation, "testsAndValidation"),
    risks: trimItems(value.risks, "risks"),
    rollbackPlan: trimItems(value.rollbackPlan, "rollbackPlan"),
  };
  if (result.readyForImplementation) {
    const missing = [
      result.proposedChanges.length === 0 ? "proposedChanges" : undefined,
      result.filesLikelyToChange.length === 0 ? "filesLikelyToChange" : undefined,
      result.detailedSteps.length === 0 ? "detailedSteps" : undefined,
      result.testsAndValidation.length === 0 ? "testsAndValidation" : undefined,
    ].filter((field): field is string => field !== undefined);
    if (missing.length > 0) {
      throw new ImplementationPlanOutputContractError(
        `An implementation-ready plan requires non-empty ${missing.join(", ")}.`,
      );
    }
  }
  return result;
}

export function parseImplementationPlanResultJson(content: string): ImplementationPlanResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new ImplementationPlanOutputContractError(`Implementation plan artifact is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return validateImplementationPlanResult(parsed);
}

export function formatImplementationPlanMarkdown(result: ImplementationPlanResult, kind: ImplementationPlanKind): string {
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
    lines.push("", "## Simplifications From Draft", ...renderList(result.simplificationsFromDraft));
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
  );
  return lines.join("\n");
}

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
    createError: (message) => new ImplementationPlanOutputContractError(message),
  };
}

function trimItems(values: string[], field: string): string[] {
  return values.map((value, index) => {
    const trimmed = value.trim();
    if (!trimmed) throw new ImplementationPlanOutputContractError(`Implementation plan ${field}[${index}] must not be blank.`);
    return trimmed;
  });
}

function renderList(values: readonly string[]): string[] {
  return values.length === 0 ? ["None."] : values.map((value) => `- ${value}`);
}

function renderNumberedList(values: readonly string[]): string[] {
  return values.length === 0 ? ["None."] : values.map((value, index) => `${index + 1}. ${value}`);
}
