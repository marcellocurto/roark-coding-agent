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
  planAction: Schema.Literals(["draft", "adopt", "adapt"]),
  planSource: Schema.NullOr(
    trimmedText(
      "Where the existing plan appears in the issue. Name the section, or give the comment author, date, and index. Use null if there is no plan.",
    ),
  ),
  verdict: Schema.Union([
    Schema.Literal("proceed"),
    Schema.Literal("blocked"),
    Schema.Literal("reject"),
    Schema.Literal("needs-human-decision"),
  ]),
  reasoning: trimmedScalar("Why the issue should proceed or stop."),
  claimVerification: Schema.Enum(triageClaimVerification),
  evidence: Schema.mutable(
    Schema.Array(
      trimmedText("Details from the issue or code that support this decision."),
    ),
  ).check(Schema.isMinLength(1)),
  establishedFacts: Schema.mutable(
    Schema.Array(
      trimmedText(
        "Something confirmed by reading the issue or checking the code.",
      ),
    ),
  ),
  blockingQuestions: Schema.mutable(
    Schema.Array(
      trimmedText("A question that needs an answer before work can continue."),
    ),
  ),
  recommendedNextStep: trimmedScalar("What should happen next."),
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
    "## Plan Preparation",
    `Action: ${result.planAction}`,
    `Source: ${result.planSource ?? "No existing plan."}`,
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
      if (result.planAction !== "draft" && result.planSource === null)
        return "To use an existing plan, set planSource to where it appears in the issue.";
      if (
        result.verdict === "needs-human-decision" &&
        result.blockingQuestions.length === 0
      )
        return "If the verdict is needs-human-decision, list at least one question that needs an answer.";
      if (result.verdict === "proceed" && result.blockingQuestions.length > 0)
        return "Use proceed only when no blocking questions remain.";
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
