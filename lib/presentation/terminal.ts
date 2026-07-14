import path from "node:path";

export interface TerminalStream {
  write(chunk: string): unknown;
  isTTY?: boolean | undefined;
  columns?: number | undefined;
}

export interface TitleParts {
  target?: string | undefined;
  phase: string;
  revision?: string | number | undefined;
  pass?: string | number | undefined;
  repository?: string | undefined;
}

export function sanitizeTerminalLine(value: unknown): string {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return "";
  return String(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
}

export function sanitizeTerminalText(value: unknown): string {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return "";
  return String(value)
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, " ");
}

export function normalizeTerminalText(value: unknown): string {
  return sanitizeTerminalLine(value).replace(/\s+/g, " ").trim();
}

export function terminalWidth(stream: TerminalStream, fallback = 80): number {
  const columns = stream.columns;
  if (typeof columns === "number" && Number.isInteger(columns) && columns >= 20) return columns;
  return fallback;
}

export function supportsTerminalTitle(stream: TerminalStream, env: NodeJS.ProcessEnv = process.env): boolean {
  return supportsInteractivePresentation(stream, env);
}

export function supportsInteractivePresentation(stream: TerminalStream, env: NodeJS.ProcessEnv = process.env): boolean {
  return stream.isTTY === true && env["TERM"] !== "dumb" && !isCiEnvironment(env);
}

export function formatTerminalTitle(parts: TitleParts, maxLength = 80): string {
  const limit = Math.max(1, Math.floor(maxLength));
  const target = normalizeTerminalText(parts.target);
  const phase = normalizeTerminalText(parts.phase) || "Roark";
  const revision = parts.revision === undefined ? "" : normalizeTerminalText(parts.revision);
  const pass = parts.pass === undefined ? "" : normalizeTerminalText(parts.pass);
  const repository = shortRepository(parts.repository);
  const required = [target, phase, revision ? `r${revision}` : "", pass ? `p${pass}` : ""].filter(Boolean);
  const optional = repository ? [...required, repository] : required;
  const joined = optional.join(" · ");
  if (Array.from(joined).length <= limit) return joined;

  const withoutRepository = required.join(" · ");
  if (Array.from(withoutRepository).length <= limit) return withoutRepository;

  return fitTitleComponents(required, limit);
}

export function setTerminalTitle(
  stream: TerminalStream,
  parts: TitleParts,
  options: { enabled?: boolean | undefined; env?: NodeJS.ProcessEnv | undefined; maxLength?: number | undefined } = {},
): boolean {
  if (options.enabled === false || !supportsTerminalTitle(stream, options.env)) return false;
  const title = formatTerminalTitle(parts, options.maxLength);
  stream.write(`\u001b]0;${title}\u0007`);
  return true;
}

export function shortenPath(value: string, roots: readonly string[] = [], maxLength = 60): string {
  const absolute = path.resolve(value);
  for (const root of roots) {
    const relative = path.relative(path.resolve(root), absolute);
    if (relative === "") return ".";
    if (relative && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)) {
      return truncateMiddle(relative, maxLength);
    }
  }
  return truncateMiddle(normalizeTerminalText(value), maxLength);
}

export function boundLine(value: string, width: number): string {
  return truncateCodePoints(sanitizeTerminalLine(value), Math.max(20, width));
}

function shortRepository(repository: string | undefined): string {
  const clean = normalizeTerminalText(repository);
  if (!clean) return "";
  return clean.split("/").filter(Boolean).at(-1) ?? clean;
}

function isCiEnvironment(env: NodeJS.ProcessEnv): boolean {
  const value = env["CI"]?.trim().toLowerCase();
  return value !== undefined && value !== "" && value !== "0" && value !== "false";
}

function truncateMiddle(value: string, maxLength: number): string {
  const points = Array.from(value);
  if (points.length <= maxLength) return value;
  if (maxLength < 5) return truncateCodePoints(value, maxLength);
  const tailLength = Math.ceil((maxLength - 1) * 0.65);
  const headLength = maxLength - 1 - tailLength;
  return `${points.slice(0, headLength).join("")}…${points.slice(-tailLength).join("")}`;
}

function truncateCodePoints(value: string, maxLength: number): string {
  if (maxLength <= 0) return "";
  const points = Array.from(value);
  if (points.length <= maxLength) return value;
  if (maxLength === 1) return "…";
  return `${points.slice(0, maxLength - 1).join("")}…`;
}

function fitTitleComponents(components: string[], maxLength: number): string {
  const separatorLength = Math.max(0, components.length - 1) * 3;
  const available = Math.max(1, maxLength - separatorLength);
  const minimums = components.map((component, index) => Math.min(Array.from(component).length, index === 0 ? 12 : index === 1 ? 16 : 6));
  const budgets = [...minimums];
  let used = budgets.reduce((sum, budget) => sum + budget, 0);

  if (used > available) {
    const base = Math.max(1, Math.floor(available / components.length));
    for (let index = 0; index < budgets.length; index++) budgets[index] = Math.min(Array.from(components[index] ?? "").length, base);
    used = budgets.reduce((sum, budget) => sum + budget, 0);
  }

  let remaining = Math.max(0, available - used);
  for (const index of [1, 0, 3, 2]) {
    const component = components[index];
    if (component === undefined || remaining === 0) continue;
    const desired = Array.from(component).length;
    const extra = Math.min(remaining, Math.max(0, desired - (budgets[index] ?? 0)));
    budgets[index] = (budgets[index] ?? 0) + extra;
    remaining -= extra;
  }

  const fitted = components.map((component, index) => truncateCodePoints(component, budgets[index] ?? 1)).join(" · ");
  return truncateCodePoints(fitted, maxLength);
}
