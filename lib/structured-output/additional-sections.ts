import { Effect, type SchemaIssue } from "effect";
import { invalidArtifact } from "./contract.ts";
import { Schema } from "effect";
const sectionText = (description: string, maxLength: number) =>
  Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(maxLength),
    Schema.isPattern(/\S/),
  ).annotate({ description });
export const additionalSectionsSchema = Schema.mutable(
  Schema.Array(
    Schema.Struct({
      heading: sectionText(
        "Freely chosen heading for material content that does not fit the standard fields.",
        160,
      ),
      items: Schema.mutable(
        Schema.Array(
          sectionText(
            "Problem-specific observation, rationale, alternative, question, or other material context.",
            2000,
          ),
        ),
      ).check(Schema.isMinLength(1), Schema.isMaxLength(12)),
    }),
  ),
).check(Schema.isMaxLength(8));
export type AdditionalSection =
  (typeof additionalSectionsSchema)["Type"][number];
export const normalizeAdditionalSections = Effect.fnUntraced(function* (
  sections: readonly AdditionalSection[] | undefined,
  input: {
    artifactLabel: string;
    reservedHeadings: readonly string[];
  },
): Effect.fn.Return<AdditionalSection[] | undefined, SchemaIssue.Issue> {
  if (sections === undefined) return undefined;
  const reserved = new Set(input.reservedHeadings.map(headingKey));
  const seen = new Set<string>();
  return yield* Effect.forEach(
    sections,
    Effect.fnUntraced(function* (section, index) {
      const heading = normalizeStructuredMarkdownText(section.heading);
      const key = headingKey(heading);
      if (reserved.has(key)) {
        return yield* invalidArtifact(
          `${input.artifactLabel} additionalSections[${index}] duplicates reserved heading '${heading}'.`,
        );
      }
      if (seen.has(key)) {
        return yield* invalidArtifact(
          `${input.artifactLabel} contains repeated additional section heading '${heading}'.`,
        );
      }
      seen.add(key);
      return {
        heading,
        items: section.items.map((item) =>
          normalizeStructuredMarkdownText(item),
        ),
      };
    }),
  );
});
export function renderAdditionalSectionsMarkdown(
  sections: readonly AdditionalSection[] | undefined,
): string[] {
  return (sections ?? []).flatMap((section) => [
    `## ${escapeStructuredMarkdownText(section.heading)}`,
    "",
    ...section.items.map((item) => `- ${escapeStructuredMarkdownText(item)}`),
    "",
  ]);
}
export function escapeStructuredMarkdownText(value: string): string {
  return normalizeStructuredMarkdownText(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/([\\`*_{}\[\]!|@])/g, "\\$1");
}
function normalizeStructuredMarkdownText(value: string): string {
  return value
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function headingKey(value: string): string {
  return value.toLocaleLowerCase();
}
