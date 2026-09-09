import { Effect, Schema } from "effect";
import {
  artifactContract,
  ArtifactContractError,
} from "../structured-output/contract.ts";
import { trimmedText } from "../structured-output/fields.ts";
import type { StructuredArtifactDefinition } from "../structured-output/runner.ts";

export const continuationPhaseSchema = Schema.Literals([
  "unchanged",
  "triage",
  "plan-draft",
  "plan",
  "implement",
  "refine-code",
  "fix",
  "review",
]);
export type ContinuationPhase = typeof continuationPhaseSchema.Type;
export interface ContinuationQuestion {
  id: string;
  question: string;
  artifact: string;
}
const resultSchema = Schema.Struct({
  status: Schema.Literals(["continue", "blocked"]),
  summary: trimmedText(
    "What the new information changes, or why work still cannot continue.",
  ),
  resumeFrom: continuationPhaseSchema,
  pass: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  requirementsChanged: Schema.Boolean,
  resolutions: Schema.mutable(
    Schema.Array(
      Schema.Struct({
        questionId: trimmedText("The exact ID of the saved question."),
        question: Schema.optional(
          trimmedText(
            "The original question text. Roark fills this from questionId.",
          ),
        ),
        status: Schema.Literals(["resolved", "unresolved"]),
        answer: Schema.NullOr(
          trimmedText(
            "The confirmed answer. Use null if the question is still unresolved.",
          ),
        ),
        sources: Schema.mutable(
          Schema.Array(
            trimmedText(
              "Where the answer was established: a comment ID, repository file and line, or documentation URL.",
            ),
          ),
        ),
      }),
    ),
  ),
  blockingQuestions: Schema.mutable(
    Schema.Array(
      trimmedText("A new question that still prevents work from continuing."),
    ),
  ),
  externalBlockers: Schema.mutable(
    Schema.Array(
      trimmedText(
        "A confirmed dependency or access problem that still prevents work.",
      ),
    ),
  ),
});
export type ContinuationResult = typeof resultSchema.Type;
const contract = artifactContract(
  "Continuation review",
  resultSchema.check(
    Schema.makeFilter((result) => {
      const unresolved =
        result.resolutions.some((item) => item.status === "unresolved") ||
        result.blockingQuestions.length > 0 ||
        result.externalBlockers.length > 0;
      if ((result.status === "blocked") !== unresolved)
        return "Continue only when every required question and blocker is resolved. A blocked result must explain what is missing.";
      if (
        result.resolutions.some(
          (item) =>
            item.status === "resolved" &&
            (item.answer === null || item.sources.length === 0),
        )
      )
        return "Each resolved question needs an answer and its sources.";
      if (
        result.requirementsChanged &&
        !["triage", "plan-draft", "plan"].includes(result.resumeFrom)
      )
        return "Changed requirements must return to triage or planning.";
      if (
        ["fix", "refine-code", "review"].includes(result.resumeFrom) !==
        (result.pass !== null)
      )
        return "Provide a pass number only for fix, refine-code, or review.";
      if (result.resumeFrom === "fix" && result.pass === 0)
        return "Fix passes start at 1.";
    }),
  ),
);
export const parseContinuationResult = contract.parse;
export function continuationDefinition(
  questions: readonly ContinuationQuestion[],
): StructuredArtifactDefinition<ContinuationResult> {
  return {
    toolName: "submit_continuation",
    label: "Continuation review",
    noun: "continuation review",
    parameters: Schema.toEncoded(resultSchema),
    validate: Effect.fnUntraced(function* (input: unknown) {
      const result = yield* contract.decode(input);
      const expected = new Set(questions.map((item) => item.id));
      const actual = result.resolutions.map((item) => item.questionId);
      if (
        actual.length !== expected.size ||
        new Set(actual).size !== expected.size ||
        actual.some((id) => !expected.has(id))
      )
        return yield* Effect.fail(
          new ArtifactContractError({
            artifact: "Continuation review",
            message:
              "Report each saved question exactly once, using only the supplied question IDs.",
          }),
        );
      return {
        ...result,
        resolutions: result.resolutions.map((item) => ({
          ...item,
          question:
            questions.find((question) => question.id === item.questionId)
              ?.question ?? item.questionId,
        })),
      };
    }),
    formatMarkdown: formatContinuationReview,
  };
}
export function formatContinuationReview(result: ContinuationResult): string {
  return [
    "# Continuation review",
    "",
    result.summary,
    "",
    `Status: ${result.status}`,
    `Next step: ${result.resumeFrom}${result.pass === null ? "" : ` pass ${result.pass}`}`,
    "",
    "## Saved questions",
    ...result.resolutions.map(
      (item) =>
        `- ${item.question ?? item.questionId}: ${item.answer ?? "Still unresolved"}${item.sources.length > 0 ? ` Sources: ${item.sources.join("; ")}` : ""}`,
    ),
    "",
    "## Questions still open",
    ...result.blockingQuestions.map((question) => `- ${question}`),
    "",
    "## Outside blockers",
    ...result.externalBlockers.map((blocker) => `- ${blocker}`),
    "",
  ].join("\n");
}
