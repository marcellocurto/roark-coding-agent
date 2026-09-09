import { trimmedText, trimmedScalar } from "../structured-output/fields.ts";
import { artifactContract } from "../structured-output/contract.ts";
import { Schema } from "effect";
import type { StructuredArtifactDefinition } from "../structured-output/runner.ts";
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
  reasoning: trimmedScalar("Concise reasoning for the triage verdict."),
  claimVerification: Schema.Enum(triageClaimVerification),
  evidence: Schema.mutable(
    Schema.Array(
      trimmedText(
        "Concrete repository or issue evidence supporting the verdict.",
      ),
    ),
  ).check(Schema.isMinLength(1)),
  establishedFacts: Schema.mutable(
    Schema.Array(
      trimmedText("Fact established by the issue or repository inspection."),
    ),
  ),
  blockingQuestions: Schema.mutable(
    Schema.Array(
      trimmedText("Specific question that must be answered before proceeding."),
    ),
  ),
  recommendedNextStep: trimmedScalar(
    "The smallest concrete next step after triage.",
  ),
});
export type TriageResult = (typeof triageResultSchemaShape)["Type"];
export type TriageVerdict = TriageResult["verdict"];
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
  triageResultSchemaShape.check(
    Schema.makeFilter((result) => {
      if (
        result.verdict === "needs-human-decision" &&
        result.blockingQuestions.length === 0
      )
        return "A needs-human-decision triage result requires at least one blocking question.";
      if (result.verdict === "proceed" && result.blockingQuestions.length > 0)
        return "A proceed triage result cannot contain blocking questions.";
    }),
  ),
);
export const validateTriageResult = contract.decode;
export const parseTriageResultJson = contract.parse;
export const triageResultSchema = Schema.toEncoded(triageResultSchemaShape);
export const triageArtifactDefinition: StructuredArtifactDefinition<TriageResult> =
  {
    toolName: "submit_triage",
    label: "Triage",
    noun: "triage result",
    parameters: triageResultSchema,
    validate: validateTriageResult,
    formatMarkdown: formatTriageMarkdown,
  };
function renderList(values: readonly string[]): string[] {
  return values.length === 0 ? ["None."] : values.map((value) => `- ${value}`);
}
