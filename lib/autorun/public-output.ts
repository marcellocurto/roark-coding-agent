const redactedLocalPath = "[local path redacted]";
const redactedSecret = "[redacted]";
const fileUriPrefix = "file://";

export function sanitizePublicMarkdown(value: string): string {
  return redactSecrets(redactLocalPaths(value));
}

export function redactSecrets(value: string): string {
  const secretValuePattern = `(?:"[^"\\r\\n]*(?:"|(?=\\r?\\n|$))|'[^'\\r\\n]*(?:'|(?=\\r?\\n|$))|[^\\s\`'"<>]+)`;
  const secretNamePattern = `[A-Z0-9_]*(?:TOKEN|SECRET|API[_-]?KEY|PASSWORD)[A-Z0-9_]*`;
  return value
    .replace(new RegExp(`\\b(authorization\\s*:\\s*bearer\\s+)${secretValuePattern}`, "gi"), `$1${redactedSecret}`)
    .replace(new RegExp(`\\b((${secretNamePattern})\\s*=\\s*)${secretValuePattern}`, "gi"), `$1${redactedSecret}`)
    .replace(new RegExp(`\\b((${secretNamePattern})\\s*:\\s*)${secretValuePattern}`, "gi"), `$1${redactedSecret}`);
}

export function truncatePublicMarkdown(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n\n... (truncated ${value.length - maxChars} later characters) ...`;
}

export function redactLocalPaths(value: string): string {
  let result = "";
  let index = 0;

  while (index < value.length) {
    const end = localPathEnd(value, index);
    if (end !== undefined) {
      result += redactedLocalPath;
      index = end;
      continue;
    }

    result += value[index] ?? "";
    index += 1;
  }

  return result;
}

function localPathEnd(value: string, index: number): number | undefined {
  if (!isPathBoundary(value[index - 1])) return undefined;

  if (value.slice(index, index + fileUriPrefix.length).toLowerCase() === fileUriPrefix) {
    const end = scanPathEnd(value, index + fileUriPrefix.length);
    return end > index + fileUriPrefix.length ? end : undefined;
  }

  if (isWindowsPathStart(value, index)) return scanPathEnd(value, index);
  if (value[index] === "/" && value[index + 1] !== "/") return scanPathEnd(value, index);

  return undefined;
}

function scanPathEnd(value: string, start: number): number {
  let index = start;

  while (index < value.length) {
    const char = value[index] ?? "";
    if (isPathTerminator(char)) break;
    if (/\s/.test(char) && !continuesPathAfterWhitespace(value, start, index)) break;
    index += 1;
  }

  return index;
}

function continuesPathAfterWhitespace(value: string, pathStart: number, whitespaceIndex: number): boolean {
  if (value[whitespaceIndex] !== " ") return false;

  let nextIndex = whitespaceIndex;
  while (value[nextIndex] === " ") nextIndex += 1;
  const nextChar = value[nextIndex];
  if (!nextChar || isPathTerminator(nextChar) || nextChar === "-") return false;

  const nextTokenEnd = scanPathTokenEnd(value, nextIndex);
  const nextToken = value.slice(nextIndex, nextTokenEnd);
  if (isSentenceBoundaryToken(nextToken)) return false;
  if (/[\\/]/.test(nextToken) || /%2f|%5c/i.test(nextToken)) return true;
  if (/\.[A-Za-z0-9]{1,8}(?::\d+){0,2}$/.test(nextToken)) return true;

  const currentPath = value.slice(pathStart, whitespaceIndex);
  return isLikelyLocalPathPrefix(currentPath);
}

function scanPathTokenEnd(value: string, start: number): number {
  let index = start;
  while (index < value.length) {
    const char = value[index] ?? "";
    if (/\s/.test(char) || isPathTerminator(char)) break;
    index += 1;
  }
  return index;
}

function isLikelyLocalPathPrefix(value: string): boolean {
  return /^\/(?:Users|home|tmp|var|private|opt)(?:\/|$)/i.test(value) || /^[A-Za-z]:[\\/]/.test(value);
}

function isSentenceBoundaryToken(value: string): boolean {
  return /^(?:after|and|at|before|because|but|exit|exited|failed|failure|fails|for|from|in|on|or|then|to|when|while|with)$/i.test(value);
}

function isWindowsPathStart(value: string, index: number): boolean {
  const first = value[index] ?? "";
  return /^[A-Za-z]$/.test(first) && value[index + 1] === ":" && /[\\/]/.test(value[index + 2] ?? "");
}

function isPathBoundary(char: string | undefined): boolean {
  return char === undefined || (char !== "/" && char !== "\\" && /[^A-Za-z0-9_]/.test(char));
}

function isPathTerminator(char: string): boolean {
  return /[`"'<>{}\[\])]/.test(char);
}
