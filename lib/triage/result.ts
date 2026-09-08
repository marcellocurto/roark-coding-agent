import { Effect, SchemaGetter, type SchemaIssue } from "effect";
import {
  artifactContract,
  invalidArtifact,
} from "../structured-output/contract.ts";
import { Schema } from "effect";
import type { StructuredArtifactDefinition } from "../structured-output/runner.ts";
const nonEmptyString = (description: string) =>
  Schema.String.check(Schema.isMinLength(1)).annotate({ description });
const triageClaimVerification = {
  confirmed: "confirmed",
  notReproduced: "not-reproduced",
  insufficientDetail: "insufficient-detail",
  notApplicable: "not-applicable",
} as const;
export const triageClaimVerificationValues = Object.values(
  triageClaimVerification,
);
const triageResultSchemaShape = Schema.Struct({
  verdict: Schema.Union([
    Schema.Literal("proceed"),
    Schema.Literal("blocked"),
    Schema.Literal("reject"),
    Schema.Literal("needs-human-decision"),
  ]),
  reasoning: nonEmptyString("Concise reasoning for the triage verdict."),
  claimVerification: Schema.Enum(triageClaimVerification),
  evidence: Schema.mutable(
    Schema.Array(
      nonEmptyString(
        "Concrete repository or issue evidence supporting the verdict.",
      ),
    ),
  ).check(Schema.isMinLength(1)),
  establishedFacts: Schema.mutable(
    Schema.Array(
      nonEmptyString("Fact established by the issue or repository inspection."),
    ),
  ),
  blockingQuestions: Schema.mutable(
    Schema.Array(
      nonEmptyString(
        "Specific question that must be answered before proceeding.",
      ),
    ),
  ),
  recommendedNextStep: nonEmptyString(
    "The smallest concrete next step after triage.",
  ),
});
export type TriageResult = (typeof triageResultSchemaShape)["Type"];
export type TriageVerdict = TriageResult["verdict"];
const normalizeTriageResult = Effect.fnUntraced(function* (
  value: TriageResult,
): Effect.fn.Return<TriageResult, SchemaIssue.Issue> {
  const result: TriageResult = {
    ...value,
    reasoning: value.reasoning.trim(),
    evidence: yield* trimItems(value.evidence, "evidence"),
    establishedFacts: yield* trimItems(
      value.establishedFacts,
      "establishedFacts",
    ),
    blockingQuestions: yield* trimItems(
      value.blockingQuestions,
      "blockingQuestions",
    ),
    recommendedNextStep: value.recommendedNextStep.trim(),
  };
  if (
    result.verdict === "needs-human-decision" &&
    result.blockingQuestions.length === 0
  ) {
    return yield* invalidArtifact(
      "A needs-human-decision triage result requires at least one blocking question.",
    );
  }
  if (result.verdict === "proceed" && result.blockingQuestions.length > 0) {
    return yield* invalidArtifact(
      "A proceed triage result cannot contain blocking questions.",
    );
  }
  return result;
});
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
const contract = artifactContract(
  "Triage",
  triageResultSchemaShape.pipe(
    Schema.decodeTo(
      Schema.Struct({
        ...triageResultSchemaShape.fields,
        reasoning: Schema.String,
        recommendedNextStep: Schema.String,
      }),
      {
        decode: SchemaGetter.transformOrFail(normalizeTriageResult),
        encode: SchemaGetter.passthrough(),
      },
    ),
  ),
);
export const validateTriageResult = contract.decode;
export const parseTriageResultJson = contract.parse;
export const triageResultSchema = triageResultSchemaShape;
export const triageArtifactDefinition: StructuredArtifactDefinition<TriageResult> =
  {
    toolName: "submit_triage",
    label: "Triage",
    noun: "triage result",
    parameters: triageResultSchema,
    validate: validateTriageResult,
    formatMarkdown: formatTriageMarkdown,
  };
const trimItems = Effect.fnUntraced(function* (
  values: string[],
  field: string,
): Effect.fn.Return<string[], SchemaIssue.Issue> {
  return yield* Effect.forEach(
    values,
    Effect.fnUntraced(function* (value, index) {
      const trimmed = value.trim();
      if (!trimmed)
        return yield* invalidArtifact(
          `Triage ${field}[${index}] must not be blank.`,
        );
      return trimmed;
    }),
  );
});
function renderList(values: readonly string[]): string[] {
  return values.length === 0 ? ["None."] : values.map((value) => `- ${value}`);
}
