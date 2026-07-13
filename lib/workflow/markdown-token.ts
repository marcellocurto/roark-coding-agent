export function extractMarkdownToken(markdown: string, section: string): string | undefined {
  const candidate = new RegExp(`##\\s+${escapeRegExp(section)}\\s*\\r?\\n+\\s*([^\\r\\n]+)`, "i").exec(markdown)?.[1];
  if (!candidate) return undefined;
  return candidate
    .toLowerCase()
    .replace(/^[\s*\-:]+/, "")
    .replace(/[\u0060*_]/g, "")
    .trim()
    .split(/\s+/)[0];
}

export function requireMarkdownToken<const T extends readonly string[]>(
  markdown: string,
  section: string,
  allowed: T,
): T[number] | undefined {
  const token = extractMarkdownToken(markdown, section);
  return allowed.find((value) => value === token);
}

export function artifactOutcome(markdown: string): string {
  return extractMarkdownToken(markdown, "Verdict") ?? extractMarkdownToken(markdown, "Status") ?? "completed";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
