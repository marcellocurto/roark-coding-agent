import { Type, type Static } from "typebox";

const sectionText = (description: string, maxLength: number) => Type.String({
  minLength: 1,
  maxLength,
  pattern: "\\S",
  description,
});

export const additionalSectionsSchema = Type.Array(Type.Object({
  heading: sectionText("Freely chosen heading for material content that does not fit the standard fields.", 160),
  items: Type.Array(
    sectionText("Problem-specific observation, rationale, alternative, question, or other material context.", 2_000),
    { minItems: 1, maxItems: 12 },
  ),
}, { additionalProperties: false }), { maxItems: 8 });

export type AdditionalSection = Static<typeof additionalSectionsSchema>[number];

export function normalizeAdditionalSections(
  sections: readonly AdditionalSection[] | undefined,
  input: {
    artifactLabel: string;
    reservedHeadings: readonly string[];
    createError: (message: string) => Error;
  },
): AdditionalSection[] | undefined {
  if (sections === undefined) return undefined;

  const reserved = new Set(input.reservedHeadings.map(headingKey));
  const seen = new Set<string>();
  return sections.map((section, index) => {
    const heading = normalizeStructuredMarkdownText(section.heading);
    const key = headingKey(heading);
    if (reserved.has(key)) {
      throw input.createError(`${input.artifactLabel} additionalSections[${index}] duplicates reserved heading '${heading}'.`);
    }
    if (seen.has(key)) {
      throw input.createError(`${input.artifactLabel} contains repeated additional section heading '${heading}'.`);
    }
    seen.add(key);
    return {
      heading,
      items: section.items.map((item) => normalizeStructuredMarkdownText(item)),
    };
  });
}

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
  return value.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}

function headingKey(value: string): string {
  return value.toLocaleLowerCase();
}
