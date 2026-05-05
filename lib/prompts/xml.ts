export function escapePromptXmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function escapePromptXmlAttribute(value: string): string {
  return escapePromptXmlText(value).replace(/"/g, "&quot;");
}
