import { shortenPath } from "../presentation/terminal.ts";

export { formatToolDuration } from "../presentation/duration.ts";

const maxPathLength = 72;
const maxCommandLength = 96;
const maxPatternLength = 64;
const maxGenericLength = 72;

export function summarizeToolCall(toolName: string, args: unknown, roots: readonly string[] = []): string {
  switch (toolName) {
    case "read":
      return summarizeRead(args, roots);
    case "grep":
      return summarizeGrep(args, roots);
    case "bash":
      return summarizeBash(args);
    case "edit":
      return summarizeEdit(args, roots);
    case "write":
      return summarizeWrite(args, roots);
    case "find":
      return summarizeFind(args, roots);
    case "ls":
      return summarizeLs(args, roots);
    default:
      return sanitizeInline(toolName, maxGenericLength) || "tool";
  }
}

function summarizeRead(args: unknown, roots: readonly string[]): string {
  const objectArgs = asRecord(args);
  const path = formatPath(objectArgs?.["path"], roots);
  const range = formatReadRange(objectArgs?.["offset"], objectArgs?.["limit"]);
  return `read ${path}${range}`;
}

function summarizeGrep(args: unknown, roots: readonly string[]): string {
  const objectArgs = asRecord(args);
  const pattern = formatSlashPattern(objectArgs?.["pattern"]);
  const target = formatTarget(objectArgs?.["path"], objectArgs?.["glob"], roots);
  return `grep ${pattern}${target ? ` in ${target}` : ""}`;
}

function summarizeBash(args: unknown): string {
  const objectArgs = asRecord(args);
  return `bash ${formatQuoted(objectArgs?.["command"], maxCommandLength)}`;
}

function summarizeEdit(args: unknown, roots: readonly string[]): string {
  const objectArgs = asRecord(args);
  const path = formatPath(objectArgs?.["path"], roots);
  const edits = objectArgs?.["edits"];
  const editCount = Array.isArray(edits) ? edits.length : undefined;
  return editCount === undefined ? `edit ${path}` : `edit ${path} (${editCount} ${editCount === 1 ? "edit" : "edits"})`;
}

function summarizeWrite(args: unknown, roots: readonly string[]): string {
  const objectArgs = asRecord(args);
  const path = formatPath(objectArgs?.["path"], roots);
  const content = objectArgs?.["content"];
  return typeof content === "string" ? `write ${path} (${content.length} chars)` : `write ${path}`;
}

function summarizeFind(args: unknown, roots: readonly string[]): string {
  const objectArgs = asRecord(args);
  const pattern = sanitizeInline(objectArgs?.["pattern"], maxPatternLength) || "<pattern>";
  const path = formatPath(objectArgs?.["path"] ?? ".", roots);
  return `find ${pattern} in ${path}`;
}

function summarizeLs(args: unknown, roots: readonly string[]): string {
  const objectArgs = asRecord(args);
  return `ls ${formatPath(objectArgs?.["path"] ?? ".", roots)}`;
}

function formatTarget(path: unknown, glob: unknown, roots: readonly string[]): string {
  const formattedPath = formatPath(path, roots, "");
  if (formattedPath) return formattedPath;
  return sanitizeInline(glob, maxPathLength);
}

function formatPath(value: unknown, roots: readonly string[], fallback = "<path>"): string {
  const clean = sanitizeInline(value, Number.MAX_SAFE_INTEGER);
  return clean ? shortenPath(clean, roots, maxPathLength) : fallback;
}

function formatQuoted(value: unknown, maxLength: number): string {
  const text = sanitizeInline(value, maxLength) || "";
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
}

function formatSlashPattern(value: unknown): string {
  const text = sanitizeInline(value, maxPatternLength) || "<pattern>";
  return `/${text.replace(/\\/g, "\\\\").replace(/\//g, "\\/")}/`;
}

function formatReadRange(offset: unknown, limit: unknown): string {
  const start = toPositiveInteger(offset);
  const length = toPositiveInteger(limit);
  if (start === undefined && length === undefined) return "";
  if (start === undefined) return `:1-${length ?? ""}`;
  if (length === undefined) return `:${start}`;
  return `:${start}-${start + length - 1}`;
}

function sanitizeInline(value: unknown, maxLength: number): string {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return "";
  const normalized = String(value).replace(/\s+/g, " ").trim();
  return truncate(normalized, maxLength);
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  if (maxLength <= 1) return "…";
  return `${value.slice(0, maxLength - 1)}…`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function toPositiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const integer = Math.trunc(value);
  return integer > 0 ? integer : undefined;
}
