import { Effect, SchemaGetter, type SchemaIssue } from "effect";
import {
  artifactContract,
  invalidArtifact,
} from "../structured-output/contract.ts";
import { Schema } from "effect";
const nonEmptyString = (description: string) =>
  Schema.String.check(Schema.isMinLength(1)).annotate({ description });
const textItems = (description: string) =>
  Schema.mutable(Schema.Array(nonEmptyString(description)));
const prDraftSchemaShape = Schema.Struct({
  title: nonEmptyString("Concise pull request title."),
  simpleSummary: nonEmptyString(
    "Plain-language summary for a busy maintainer.",
  ),
  summary: textItems("What changed and why."),
  changes: textItems("Important behavior or implementation change."),
  reviewInstructions: textItems(
    "Specific reviewer instruction or review path.",
  ),
  verification: textItems(
    "Verification performed or explicitly not performed.",
  ),
  risksAndNonGoals: textItems("Known risk, limitation, or non-goal."),
  additionalSections: Schema.mutable(
    Schema.Array(
      Schema.Struct({
        heading: nonEmptyString("Additional reviewer-facing section heading."),
        items: textItems("Item in the additional section."),
      }),
    ),
  ),
  additionalClosingIssueNumbers: Schema.mutable(
    Schema.Array(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  ),
});
export type PrDraft = (typeof prDraftSchemaShape)["Type"];
export interface PrDraftFollowUpIssue {
  title: string;
  url?: string | undefined;
  number?: number | undefined;
}
export interface PrDraftRenderingContext {
  sourceIssueNumber: number;
  followUpIssues?: readonly PrDraftFollowUpIssue[] | undefined;
}
const normalizePrDraft = Effect.fnUntraced(function* (
  value: PrDraft,
): Effect.fn.Return<PrDraft, SchemaIssue.Issue> {
  const draft: PrDraft = {
    ...value,
    title: inline(value.title),
    simpleSummary: inline(value.simpleSummary),
    summary: normalizeItems(value.summary),
    changes: normalizeItems(value.changes),
    reviewInstructions: normalizeItems(value.reviewInstructions),
    verification: normalizeItems(value.verification),
    risksAndNonGoals: normalizeItems(value.risksAndNonGoals),
    additionalSections: value.additionalSections.map((section) => ({
      heading: inline(section.heading).replace(/^#+\s*/, ""),
      items: normalizeItems(section.items),
    })),
    additionalClosingIssueNumbers: [
      ...new Set(value.additionalClosingIssueNumbers),
    ],
  };
  if (!draft.title || !draft.simpleSummary)
    return yield* invalidArtifact(
      "PR draft title and simple summary must not be blank.",
    );
  if (draft.additionalSections.some((section) => !section.heading))
    return yield* invalidArtifact(
      "PR draft section headings must not be blank.",
    );
  yield* assertUniqueSectionHeadings(
    draft.additionalSections.map((section) => section.heading),
    [
      "simple summary",
      "summary",
      "what changed",
      "how to review",
      "verification",
      "risks / non-goals",
      "follow-up issues",
    ],
  );
  return draft;
});
export function formatPrDraftMarkdown(
  draft: PrDraft,
  context: PrDraftRenderingContext,
): string {
  const closingIssues = [
    ...new Set([
      context.sourceIssueNumber,
      ...draft.additionalClosingIssueNumbers.filter(
        (number) => number !== context.sourceIssueNumber,
      ),
    ]),
  ];
  const lines = [
    "## Simple summary",
    "",
    draft.simpleSummary,
    "",
    ...section("Summary", draft.summary),
    ...section("What changed", draft.changes),
    ...section("How to review", draft.reviewInstructions),
    ...section("Verification", draft.verification),
    ...section("Risks / non-goals", draft.risksAndNonGoals),
    ...draft.additionalSections.flatMap((additional) =>
      section(additional.heading, additional.items),
    ),
    "## Follow-up issues",
    "",
    ...renderFollowUps(context.followUpIssues),
    "",
    ...closingIssues.flatMap((number) => [`Closes #${number}`, ""]),
  ];
  return lines.join("\n");
}
function section(heading: string, items: readonly string[]): string[] {
  return [
    `## ${heading}`,
    "",
    ...(items.length === 0 ? ["None."] : items.map((item) => `- ${item}`)),
    "",
  ];
}
function renderFollowUps(
  issues: readonly PrDraftFollowUpIssue[] | undefined,
): string[] {
  if (!issues || issues.length === 0)
    return ["None created at PR creation time."];
  return issues.map((issue) => {
    const label =
      issue.number === undefined
        ? issue.title
        : `#${issue.number}: ${issue.title}`;
    return `- ${issue.url ? `[${label}](${issue.url})` : label}`;
  });
}
function normalizeItems(items: readonly string[]): string[] {
  return items.map(inline).filter((item) => item.length > 0);
}
function inline(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
const assertUniqueSectionHeadings = Effect.fnUntraced(function* (
  headings: readonly string[],
  reserved: readonly string[],
): Effect.fn.Return<void, SchemaIssue.Issue> {
  const seen = new Set(reserved);
  for (const heading of headings) {
    const key = heading.toLocaleLowerCase();
    if (seen.has(key))
      return yield* invalidArtifact(
        `PR draft additional section duplicates reserved or repeated heading '${heading}'.`,
      );
    seen.add(key);
  }
});
const contract = artifactContract(
  "PR draft",
  prDraftSchemaShape.pipe(
    Schema.decode({
      decode: SchemaGetter.transformOrFail(normalizePrDraft),
      encode: SchemaGetter.passthrough(),
    }),
  ),
);
export const validatePrDraft = contract.decode;
export const parsePrDraftJson = contract.parse;
export const prDraftSchema = prDraftSchemaShape;
