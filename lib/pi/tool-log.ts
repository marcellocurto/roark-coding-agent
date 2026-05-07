export interface CompletedToolCallForLog {
  readonly toolName: string;
  readonly args: unknown;
  readonly durationMs: number;
  readonly isError: boolean;
}

export interface CompletedToolRunForLog {
  readonly toolName: string;
  readonly durationMs: number;
}

const maxPathLength = 72;
const maxCommandLength = 96;
const maxPatternLength = 64;
const maxGenericLength = 72;

export function formatCompletedToolLine(tool: CompletedToolCallForLog): string {
  const marker = tool.isError ? "✗" : "•";
  return `${marker} ${summarizeToolCall(tool.toolName, tool.args)} (${formatToolDuration(tool.durationMs)})`;
}

export function formatToolRunSummary(tools: readonly CompletedToolRunForLog[]): string {
  if (tools.length === 0) return "tools: none · 0ms";

  const counts = new Map<string, number>();
  let totalDurationMs = 0;
  for (const tool of tools) {
    counts.set(tool.toolName, (counts.get(tool.toolName) ?? 0) + 1);
    totalDurationMs += normalizeDurationMs(tool.durationMs);
  }

  const countText = [...counts]
    .map(([toolName, count]) => `${sanitizeInline(toolName, maxGenericLength) || "unknown"} ${count}`)
    .join(", ");
  return `tools: ${countText} · ${formatToolDuration(totalDurationMs)}`;
}

export function formatToolDuration(durationMs: number): string {
  const safeDurationMs = normalizeDurationMs(durationMs);
  if (safeDurationMs < 1000) return `${Math.round(safeDurationMs)}ms`;

  const seconds = safeDurationMs / 1000;
  const secondsText = seconds.toFixed(1).replace(/\.0$/, "");
  return `${secondsText}s`;
}

export function summarizeToolCall(toolName: string, args: unknown): string {
  switch (toolName) {
    case "read":
      return summarizeRead(args);
    case "grep":
      return summarizeGrep(args);
    case "bash":
      return summarizeBash(args);
    case "edit":
      return summarizeEdit(args);
    case "write":
      return summarizeWrite(args);
    case "find":
      return summarizeFind(args);
    case "ls":
      return summarizeLs(args);
    default:
      return sanitizeInline(toolName, maxGenericLength) || "tool";
  }
}

function summarizeRead(args: unknown): string {
  const objectArgs = asRecord(args);
  const path = formatPath(objectArgs?.["path"]);
  const range = formatReadRange(objectArgs?.["offset"], objectArgs?.["limit"]);
  return `read ${path}${range}`;
}

function summarizeGrep(args: unknown): string {
  const objectArgs = asRecord(args);
  const pattern = formatSlashPattern(objectArgs?.["pattern"]);
  const target = formatTarget(objectArgs?.["path"], objectArgs?.["glob"]);
  return `grep ${pattern}${target ? ` in ${target}` : ""}`;
}

function summarizeBash(args: unknown): string {
  const objectArgs = asRecord(args);
  return `bash ${formatQuoted(objectArgs?.["command"], maxCommandLength)}`;
}

function summarizeEdit(args: unknown): string {
  const objectArgs = asRecord(args);
  const path = formatPath(objectArgs?.["path"]);
  const edits = objectArgs?.["edits"];
  const editCount = Array.isArray(edits) ? edits.length : undefined;
  return editCount === undefined ? `edit ${path}` : `edit ${path} (${editCount} ${editCount === 1 ? "edit" : "edits"})`;
}

function summarizeWrite(args: unknown): string {
  const objectArgs = asRecord(args);
  const path = formatPath(objectArgs?.["path"]);
  const content = objectArgs?.["content"];
  return typeof content === "string" ? `write ${path} (${content.length} chars)` : `write ${path}`;
}

function summarizeFind(args: unknown): string {
  const objectArgs = asRecord(args);
  const pattern = sanitizeInline(objectArgs?.["pattern"], maxPatternLength) || "<pattern>";
  const path = formatPath(objectArgs?.["path"] ?? ".");
  return `find ${pattern} in ${path}`;
}

function summarizeLs(args: unknown): string {
  const objectArgs = asRecord(args);
  return `ls ${formatPath(objectArgs?.["path"] ?? ".")}`;
}

function formatTarget(path: unknown, glob: unknown): string {
  const formattedPath = sanitizeInline(path, maxPathLength);
  if (formattedPath) return formattedPath;
  return sanitizeInline(glob, maxPathLength);
}

function formatPath(value: unknown): string {
  return sanitizeInline(value, maxPathLength) || "<path>";
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
  if (start === undefined) return `:1-${length}`;
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
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function toPositiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const integer = Math.trunc(value);
  return integer > 0 ? integer : undefined;
}

function normalizeDurationMs(durationMs: number): number {
  return Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 0;
}
