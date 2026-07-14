import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import type { StructuredArtifactDefinition } from "../structured-output/runner.ts";

const nonEmptyString = (description: string) => Type.String({ minLength: 1, description });

export const triageResultSchema = Type.Object({
  verdict: Type.Union([
    Type.Literal("proceed"),
    Type.Literal("blocked"),
    Type.Literal("reject"),
    Type.Literal("needs-human-decision"),
  ]),
  reasoning: nonEmptyString("Concise reasoning for the triage verdict."),
  claimVerification: Type.Union([
    Type.Literal("confirmed"),
    Type.Literal("not-reproduced"),
    Type.Literal("insufficient-detail"),
    Type.Literal("not-applicable"),
  ]),
  evidence: Type.Array(nonEmptyString("Concrete repository or issue evidence supporting the verdict."), { minItems: 1 }),
  establishedFacts: Type.Array(nonEmptyString("Fact established by the issue or repository inspection.")),
  blockingQuestions: Type.Array(nonEmptyString("Specific question that must be answered before proceeding.")),
  recommendedNextStep: nonEmptyString("The smallest concrete next step after triage."),
}, { additionalProperties: false });

export type TriageResult = Static<typeof triageResultSchema>;
export type TriageVerdict = TriageResult["verdict"];

export class TriageOutputContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TriageOutputContractError";
  }
}

export function validateTriageResult(value: unknown): TriageResult {
  if (!Value.Check(triageResultSchema, value)) {
    const first = Value.Errors(triageResultSchema, value)[0];
    const location = first?.instancePath ?? first?.schemaPath ?? "triage result";
    throw new TriageOutputContractError(`Triage result does not satisfy the structured contract at ${location}.`);
  }
  const result: TriageResult = {
    ...value,
    reasoning: value.reasoning.trim(),
    evidence: trimItems(value.evidence, "evidence"),
    establishedFacts: trimItems(value.establishedFacts, "establishedFacts"),
    blockingQuestions: trimItems(value.blockingQuestions, "blockingQuestions"),
    recommendedNextStep: value.recommendedNextStep.trim(),
  };
  if (result.verdict === "needs-human-decision" && result.blockingQuestions.length === 0) {
    throw new TriageOutputContractError("A needs-human-decision triage result requires at least one blocking question.");
  }
  if (result.verdict === "proceed" && result.blockingQuestions.length > 0) {
    throw new TriageOutputContractError("A proceed triage result cannot contain blocking questions.");
  }
  return result;
}

export function parseTriageResultJson(content: string): TriageResult {
  return validateTriageResult(parseJson(content, "Triage"));
}

export function formatTriageMarkdown(result: TriageResult): string {
  return [
    "# Triage",
    "",
    "## Verdict",
    result.verdict,
    "",
    "## Reasoning",
    result.reasoning,
    "",
    "## Claim Verification",
    result.claimVerification,
    "",
    "## Evidence",
    ...renderList(result.evidence),
    "",
    "## Established Facts",
    ...renderList(result.establishedFacts),
    "",
    "## Blocking Questions",
    ...renderList(result.blockingQuestions),
    "",
    "## Recommended Next Step",
    result.recommendedNextStep,
    "",
  ].join("\n");
}

export const triageArtifactDefinition: StructuredArtifactDefinition<TriageResult> = {
  toolName: "submit_triage",
  label: "Triage",
  noun: "triage result",
  parameters: triageResultSchema,
  validate: validateTriageResult,
  formatMarkdown: formatTriageMarkdown,
  createError: (message) => new TriageOutputContractError(message),
};

function parseJson(content: string, label: string): unknown {
  try {
    return JSON.parse(content);
  } catch (error) {
    throw new TriageOutputContractError(`${label} artifact is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function trimItems(values: string[], field: string): string[] {
  return values.map((value, index) => {
    const trimmed = value.trim();
    if (!trimmed) throw new TriageOutputContractError(`Triage ${field}[${index}] must not be blank.`);
    return trimmed;
  });
}

function renderList(values: readonly string[]): string[] {
  return values.length === 0 ? ["None."] : values.map((value) => `- ${value}`);
}
