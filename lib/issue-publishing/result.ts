import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

const nonEmptyString = (description: string) => Type.String({ minLength: 1, description });
const textItems = (description: string) => Type.Array(nonEmptyString(description));

export const issueDraftSchema = Type.Object({
  planItemId: nonEmptyString("The exact accepted curation-plan item identifier."),
  title: nonEmptyString("Concise, action-oriented issue title."),
  simpleSummary: nonEmptyString("Plain-language summary for a busy maintainer."),
  whyThisIssueExists: textItems("Evidence-backed reason this issue exists."),
  impact: textItems("Current or future user impact."),
  suggestedFix: textItems("Outcome-focused suggested handling."),
  acceptanceCriteria: textItems("Independently verifiable acceptance criterion."),
  risksAndNonGoals: textItems("Risk, limitation, or non-goal."),
  additionalSections: Type.Array(Type.Object({
    heading: nonEmptyString("Additional maintainer-facing section heading."),
    items: textItems("Item in the additional section."),
  }, { additionalProperties: false })),
}, { additionalProperties: false });

export const issueDraftCollectionSchema = Type.Object({
  issues: Type.Array(issueDraftSchema),
}, { additionalProperties: false });

export type IssueDraft = Static<typeof issueDraftSchema>;
export type IssueDraftCollection = Static<typeof issueDraftCollectionSchema>;

export interface IssueDraftRenderingContext {
  sourceIssue: { number: number; title: string; url?: string | undefined };
  relatedPrUrl?: string | undefined;
  classification: string;
  sourceFindingIds: readonly string[];
  reviewerSources: readonly string[];
  runDirectory: string;
  attempt?: number | undefined;
  artifactPaths: readonly string[];
}

export function validateIssueDraftCollection(value: unknown, expectedPlanItemIds: readonly string[]): IssueDraftCollection {
  if (!Value.Check(issueDraftCollectionSchema, value)) {
    const first = Value.Errors(issueDraftCollectionSchema, value)[0];
    const location = first?.instancePath ?? first?.schemaPath ?? "issue drafts";
    throw new Error(`Issue drafts do not satisfy the structured contract at ${location}.`);
  }

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
  for (const draft of normalized.issues) seen.set(draft.planItemId, (seen.get(draft.planItemId) ?? 0) + 1);
  const duplicates = [...seen].filter(([, count]) => count > 1).map(([id]) => id);
  if (duplicates.length > 0) throw new Error(`Issue drafts contain duplicate planItemId(s): ${duplicates.join(", ")}.`);
  const unknown = [...seen.keys()].filter((id) => !expected.has(id));
  if (unknown.length > 0) throw new Error(`Issue drafts contain unknown planItemId(s): ${unknown.join(", ")}.`);
  const missing = [...expected].filter((id) => !seen.has(id));
  if (missing.length > 0) throw new Error(`Issue drafts omit planItemId(s): ${missing.join(", ")}.`);
  if (normalized.issues.some((draft) => !draft.planItemId || !draft.title || !draft.simpleSummary)) {
    throw new Error("Issue draft identifiers, titles, and simple summaries must not be blank.");
  }
  if (normalized.issues.some((draft) => draft.additionalSections.some((section) => !section.heading))) {
    throw new Error("Issue draft section headings must not be blank.");
  }
  for (const draft of normalized.issues) {
    assertUniqueSectionHeadings(draft.additionalSections.map((section) => section.heading), [
      "simple summary", "why this issue exists", "impact", "suggested fix", "acceptance criteria", "risks / non-goals", "context",
    ]);
  }
  return normalized;
}

export function formatIssueDraftMarkdown(draft: IssueDraft, context: IssueDraftRenderingContext): string {
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
    ...(draft.acceptanceCriteria.length === 0 ? ["None specified."] : draft.acceptanceCriteria.map((item) => `- [ ] ${item}`)),
    "",
    ...section("Risks / non-goals", draft.risksAndNonGoals),
    ...draft.additionalSections.flatMap((additional) => section(additional.heading, additional.items)),
    "## Context",
    "",
    `- Source issue: #${context.sourceIssue.number} ${context.sourceIssue.title}${context.sourceIssue.url ? ` (${context.sourceIssue.url})` : ""}`,
    ...(context.relatedPrUrl ? [`- Related PR: ${context.relatedPrUrl}`] : []),
    `- Classification: ${context.classification}`,
    `- Source finding IDs: ${context.sourceFindingIds.join(", ") || "none recorded"}`,
    `- Reviewer sources: ${context.reviewerSources.join(", ") || "none recorded"}`,
    "",
    "<details>",
    "<summary>Roark run artifacts</summary>",
    "",
    `- Run directory: \`${context.runDirectory}\``,
    ...(context.attempt === undefined ? [] : [`- Attempt: ${context.attempt}`]),
    ...(context.artifactPaths.length === 0
      ? ["- Artifacts: none recorded"]
      : ["- Artifacts:", ...context.artifactPaths.map((artifactPath) => `  - \`${artifactPath}\``)]),
    "",
    "</details>",
    "",
  ].join("\n");
}

function section(heading: string, items: readonly string[]): string[] {
  return [`## ${heading}`, "", ...(items.length === 0 ? ["None."] : items.map((item) => `- ${item}`)), ""];
}

function normalizeItems(items: readonly string[]): string[] {
  return items.map(inline).filter((item) => item.length > 0);
}

function inline(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function assertUniqueSectionHeadings(headings: readonly string[], reserved: readonly string[]): void {
  const seen = new Set(reserved);
  for (const heading of headings) {
    const key = heading.toLocaleLowerCase();
    if (seen.has(key)) throw new Error(`Issue draft additional section duplicates reserved or repeated heading '${heading}'.`);
    seen.add(key);
  }
}
