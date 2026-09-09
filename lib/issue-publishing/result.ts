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
export const issueDraftSchema = Schema.Struct({
  planItemId: nonEmptyString(
    "The exact accepted curation-plan item identifier.",
  ),
  title: nonEmptyString("Concise, action-oriented issue title."),
  simpleSummary: nonEmptyString(
    "Plain-language summary for a busy maintainer.",
  ),
  whyThisIssueExists: textItems("Evidence-backed reason this issue exists."),
  impact: textItems("Current or future user impact."),
  suggestedFix: textItems("Outcome-focused suggested handling."),
  acceptanceCriteria: textItems(
    "Independently verifiable acceptance criterion.",
  ),
  risksAndNonGoals: textItems("Risk, limitation, or non-goal."),
  additionalSections: Schema.mutable(
    Schema.Array(
      Schema.Struct({
        heading: nonEmptyString(
          "Additional maintainer-facing section heading.",
        ),
        items: textItems("Item in the additional section."),
      }),
    ),
  ),
});
const issueDraftCollectionSchemaShape = Schema.Struct({
  issues: Schema.mutable(Schema.Array(issueDraftSchema)),
});
export type IssueDraft = (typeof issueDraftSchema)["Type"];
export type IssueDraftCollection =
  (typeof issueDraftCollectionSchemaShape)["Type"];
export interface IssueDraftRenderingContext {
  sourceIssue: {
    number: number;
    title: string;
    url?: string | undefined;
  };
  relatedPrUrl?: string | undefined;
  classification: string;
  sourceFindingIds: readonly string[];
  reviewerSources: readonly string[];
  attempt?: number | undefined;
}
const normalizeIssueDraftCollection = Effect.fnUntraced(function* (
  value: IssueDraftCollection,
  expectedPlanItemIds: readonly string[],
): Effect.fn.Return<IssueDraftCollection, SchemaIssue.Issue> {
  const normalized = {
    issues: value.issues.map((draft) => ({
      ...draft,
      planItemId: inline(draft.planItemId),
      title: inline(draft.title),
      simpleSummary: inline(draft.simpleSummary),
      whyThisIssueExists: normalizeItems(draft.whyThisIssueExists),
      impact: normalizeItems(draft.impact),
      suggestedFix: normalizeItems(draft.suggestedFix),
      acceptanceCriteria: normalizeItems(draft.acceptanceCriteria),
      risksAndNonGoals: normalizeItems(draft.risksAndNonGoals),
      additionalSections: draft.additionalSections.map((section) => ({
        heading: inline(section.heading).replace(/^#+\s*/, ""),
        items: normalizeItems(section.items),
      })),
    })),
  };
  const expected = new Set(expectedPlanItemIds);
  const seen = new Map<string, number>();
  for (const draft of normalized.issues)
    seen.set(draft.planItemId, (seen.get(draft.planItemId) ?? 0) + 1);
  const duplicates = [...seen]
    .filter(([, count]) => count > 1)
    .map(([id]) => id);
  if (duplicates.length > 0)
    return yield* invalidArtifact(
      `Issue drafts contain duplicate planItemId(s): ${duplicates.join(", ")}.`,
    );
  const unknown = [...seen.keys()].filter((id) => !expected.has(id));
  if (unknown.length > 0)
    return yield* invalidArtifact(
      `Issue drafts contain unknown planItemId(s): ${unknown.join(", ")}.`,
    );
  const missing = [...expected].filter((id) => !seen.has(id));
  if (missing.length > 0)
    return yield* invalidArtifact(
      `Issue drafts omit planItemId(s): ${missing.join(", ")}.`,
    );
  if (
    normalized.issues.some(
      (draft) => !draft.planItemId || !draft.title || !draft.simpleSummary,
    )
  ) {
    return yield* invalidArtifact(
      "Issue draft identifiers, titles, and simple summaries must not be blank.",
    );
  }
  if (
    normalized.issues.some((draft) =>
      draft.additionalSections.some((section) => !section.heading),
    )
  ) {
    return yield* invalidArtifact(
      "Issue draft section headings must not be blank.",
    );
  }
  for (const draft of normalized.issues) {
    yield* assertUniqueSectionHeadings(
      draft.additionalSections.map((section) => section.heading),
      [
        "simple summary",
        "why this issue exists",
        "impact",
        "suggested fix",
        "acceptance criteria",
        "risks / non-goals",
        "context",
      ],
    );
  }
  return normalized;
});
export function formatIssueDraftMarkdown(
  draft: IssueDraft,
  context: IssueDraftRenderingContext,
): string {
  return [
    "## Simple summary",
    "",
    draft.simpleSummary,
    "",
    ...section("Why this issue exists", draft.whyThisIssueExists),
    ...section("Impact", draft.impact),
    ...section("Suggested fix", draft.suggestedFix),
    "## Acceptance criteria",
    "",
    ...(draft.acceptanceCriteria.length === 0
      ? ["None specified."]
      : draft.acceptanceCriteria.map((item) => `- [ ] ${item}`)),
    "",
    ...section("Risks / non-goals", draft.risksAndNonGoals),
    ...draft.additionalSections.flatMap((additional) =>
      section(additional.heading, additional.items),
    ),
    "## Context",
    "",
    `- Source issue: #${context.sourceIssue.number} ${context.sourceIssue.title}${context.sourceIssue.url ? ` (${context.sourceIssue.url})` : ""}`,
    ...(context.relatedPrUrl ? [`- Related PR: ${context.relatedPrUrl}`] : []),
    `- Classification: ${context.classification}`,
    `- Source finding IDs: ${context.sourceFindingIds.join(", ") || "none recorded"}`,
    `- Reviewer sources: ${context.reviewerSources.join(", ") || "none recorded"}`,
    ...(context.attempt === undefined ? [] : [`- Attempt: ${context.attempt}`]),
    "",
  ].join("\n");
}
function section(heading: string, items: readonly string[]): string[] {
  return [
    `## ${heading}`,
    "",
    ...(items.length === 0 ? ["None."] : items.map((item) => `- ${item}`)),
    "",
  ];
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
        `Issue draft additional section duplicates reserved or repeated heading '${heading}'.`,
      );
    seen.add(key);
  }
});
const contract = (expectedPlanItemIds: readonly string[]) =>
  artifactContract(
    "Issue drafts",
    issueDraftCollectionSchemaShape.pipe(
      Schema.decode({
        decode: SchemaGetter.transformOrFail((value) =>
          normalizeIssueDraftCollection(value, expectedPlanItemIds),
        ),
        encode: SchemaGetter.passthrough(),
      }),
    ),
  );
export const validateIssueDraftCollection = Effect.fnUntraced(function* (
  value: unknown,
  expectedPlanItemIds: readonly string[],
) {
  return yield* contract(expectedPlanItemIds).decode(value);
});
export const issueDraftCollectionSchema = issueDraftCollectionSchemaShape;
