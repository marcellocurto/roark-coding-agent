import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

const nonEmptyString = (description: string) => Type.String({ minLength: 1, description });
const textItems = (description: string) => Type.Array(nonEmptyString(description));

export const prDraftSchema = Type.Object({
  title: nonEmptyString("Concise pull request title."),
  simpleSummary: nonEmptyString("Plain-language summary for a busy maintainer."),
  summary: textItems("What changed and why."),
  changes: textItems("Important behavior or implementation change."),
  reviewInstructions: textItems("Specific reviewer instruction or review path."),
  verification: textItems("Verification performed or explicitly not performed."),
  risksAndNonGoals: textItems("Known risk, limitation, or non-goal."),
  additionalSections: Type.Array(Type.Object({
    heading: nonEmptyString("Additional reviewer-facing section heading."),
    items: textItems("Item in the additional section."),
  }, { additionalProperties: false })),
  additionalClosingIssueNumbers: Type.Array(Type.Integer({ minimum: 1 })),
}, { additionalProperties: false });

export type PrDraft = Static<typeof prDraftSchema>;

export interface PrDraftFollowUpIssue {
  title: string;
  url?: string | undefined;
  number?: number | undefined;
}

export interface PrDraftRenderingContext {
  sourceIssueNumber: number;
  followUpIssues?: readonly PrDraftFollowUpIssue[] | undefined;
  runDirectory: string;
  artifactPaths: readonly string[];
  attemptSummary?: string | undefined;
  verificationSummary?: string | undefined;
}

export function validatePrDraft(value: unknown): PrDraft {
  if (!Value.Check(prDraftSchema, value)) {
    const first = Value.Errors(prDraftSchema, value)[0];
    const location = first?.instancePath ?? first?.schemaPath ?? "PR draft";
    throw new Error(`PR draft does not satisfy the structured contract at ${location}.`);
  }

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
    additionalClosingIssueNumbers: [...new Set(value.additionalClosingIssueNumbers)],
  };
  if (!draft.title || !draft.simpleSummary) throw new Error("PR draft title and simple summary must not be blank.");
  if (draft.additionalSections.some((section) => !section.heading)) throw new Error("PR draft section headings must not be blank.");
  assertUniqueSectionHeadings(draft.additionalSections.map((section) => section.heading), [
    "simple summary", "summary", "what changed", "how to review", "verification", "risks / non-goals", "follow-up issues",
  ]);
  return draft;
}

export function parsePrDraftJson(content: string): PrDraft {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(`PR draft artifact is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return validatePrDraft(parsed);
}

export function formatPrDraftMarkdown(draft: PrDraft, context: PrDraftRenderingContext): string {
  const closingIssues = [...new Set([
    context.sourceIssueNumber,
    ...draft.additionalClosingIssueNumbers.filter((number) => number !== context.sourceIssueNumber),
  ])];
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
    ...draft.additionalSections.flatMap((additional) => section(additional.heading, additional.items)),
    "## Follow-up issues",
    "",
    ...renderFollowUps(context.followUpIssues),
    "",
    ...closingIssues.flatMap((number) => [`Closes #${number}`, ""]),
    "<details>",
    "<summary>Roark automation details</summary>",
    "",
    `- Run directory: \`${context.runDirectory}\``,
    ...(context.attemptSummary ? [`- Attempt: ${context.attemptSummary}`] : []),
    ...(context.verificationSummary ? [`- Verification: ${context.verificationSummary}`] : []),
    ...(context.artifactPaths.length === 0
      ? ["- Workflow artifacts: none recorded"]
      : ["- Workflow artifacts:", ...context.artifactPaths.map((artifactPath) => `  - \`${artifactPath}\``)]),
    "",
    "</details>",
    "",
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

function renderFollowUps(issues: readonly PrDraftFollowUpIssue[] | undefined): string[] {
  if (!issues || issues.length === 0) return ["None created at PR creation time."];
  return issues.map((issue) => {
    const label = issue.number === undefined ? issue.title : `#${issue.number}: ${issue.title}`;
    return `- ${issue.url ? `[${label}](${issue.url})` : label}`;
  });
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
    if (seen.has(key)) throw new Error(`PR draft additional section duplicates reserved or repeated heading '${heading}'.`);
    seen.add(key);
  }
}
