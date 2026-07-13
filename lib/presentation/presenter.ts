import { AsyncLocalStorage } from "node:async_hooks";
import { formatToolDuration } from "../pi/tool-log.ts";
import { boundLine, normalizeTerminalText, sanitizeTerminalLine, setTerminalTitle, shortenPath, terminalWidth, type TerminalStream } from "./terminal.ts";

export type AgentOperation = "inspect" | "edit" | "review" | "verify" | "publish";

export interface AgentDisplayContext {
  command: string;
  repository?: string | undefined;
  target: string;
  phaseId: string;
  phaseLabel: string;
  revision?: number | string | undefined;
  pass?: number | string | undefined;
  expectedArtifact?: string | undefined;
  operation: AgentOperation;
}

export interface PresenterOptions {
  stream?: TerminalStream | undefined;
  errorStream?: TerminalStream | undefined;
  verbose?: boolean | undefined;
  titleEnabled?: boolean | undefined;
  now?: (() => number) | undefined;
  roots?: readonly string[] | undefined;
  env?: NodeJS.ProcessEnv | undefined;
}

interface PhaseState {
  startedAt: number;
  toolCount: number;
  aggregateToolMs: number;
}

export class Presenter {
  readonly verbose: boolean;
  private readonly stream: TerminalStream;
  private readonly errorStream: TerminalStream;
  private readonly titleEnabled: boolean;
  private readonly now: () => number;
  private roots: readonly string[];
  private readonly env: NodeJS.ProcessEnv | undefined;
  private readonly phases = new Map<string, PhaseState>();
  private identity?: { command: string; repository?: string | undefined; target?: string | undefined };

  constructor(options: PresenterOptions = {}) {
    this.stream = options.stream ?? process.stdout;
    this.errorStream = options.errorStream ?? process.stderr;
    this.verbose = options.verbose ?? false;
    this.titleEnabled = options.titleEnabled ?? true;
    this.now = options.now ?? Date.now;
    this.roots = options.roots ?? [];
    this.env = options.env;
  }

  setRoots(roots: readonly string[]): void {
    this.roots = roots;
  }

  run(input: { command: string; repository?: string | undefined; target?: string | undefined }): void {
    this.identity = input;
    this.line(`RUN ${input.target ? `${input.target} · ` : ""}${input.command} · ${shortRepo(input.repository) || "repository"}`);
    this.title(input.target, input.command, undefined, undefined, input.repository);
  }

  updateTarget(target: string): void {
    if (!this.identity) return;
    this.identity = { ...this.identity, target };
    this.title(target, this.identity.command, undefined, undefined, this.identity.repository);
  }

  currentTarget(): string | undefined {
    return this.identity?.target;
  }

  transition(phase: string, target = this.identity?.target ?? "Roark", pass?: string | number): void {
    this.line(`STATE ${target} · ${phase}${pass === undefined ? "" : ` · pass ${pass}`}`);
    this.title(target, phase, undefined, pass, this.identity?.repository);
  }

  phaseStarted(context: AgentDisplayContext, options: { manageTitle?: boolean | undefined } = {}): void {
    this.phases.set(context.phaseId, { startedAt: this.now(), toolCount: 0, aggregateToolMs: 0 });
    const revision = context.revision === undefined ? "" : ` · revision ${context.revision}`;
    const pass = context.pass === undefined ? "" : ` · pass ${context.pass}`;
    this.line(`PHASE ${context.target} · ${context.phaseLabel}${revision}${pass} · ${context.operation}`);
    if (options.manageTitle !== false) this.title(context.target, context.phaseLabel, context.revision, context.pass, context.repository);
  }

  activity(context: AgentDisplayContext, summary: string, input: { failed: boolean; durationMs: number }): void {
    const phase = this.phases.get(context.phaseId);
    if (phase) {
      phase.toolCount++;
      phase.aggregateToolMs += Math.max(0, input.durationMs);
    }
    this.subline("", `${input.failed ? `FAILED ${context.phaseLabel}` : context.phaseLabel} · ${summary} (${formatToolDuration(input.durationMs)})`);
  }

  phaseCompleted(context: AgentDisplayContext, input: { outcome?: string | undefined; artifact?: string | undefined; failed?: boolean | undefined; manageTitle?: boolean | undefined } = {}): void {
    const state = this.phases.get(context.phaseId);
    const elapsed = state ? this.now() - state.startedAt : 0;
    const status = input.failed === true ? "FAILED" : "DONE";
    const toolCount = state?.toolCount ?? 0;
    const prefix = `${status} ${context.target} · ${context.phaseLabel} · `;
    const suffix = ` · ${toolCount} ${toolCount === 1 ? "tool" : "tools"} · ${formatToolDuration(elapsed)}`;
    const outcome = normalizeTerminalText(input.outcome ?? (input.failed === true ? "failed" : "completed"));
    if (this.stream.isTTY !== true) {
      this.line(`${prefix}${outcome}${suffix}`);
    } else {
      const width = terminalWidth(this.stream);
      const record = fitRecord(prefix, outcome, suffix, width);
      if (Array.from(record).length <= width) {
        this.line(record);
      } else {
        this.line(`${prefix}${input.outcome ?? (input.failed === true ? "failed" : "completed")}`);
        this.subline("elapsed: ", `${formatToolDuration(elapsed)} · ${toolCount} ${toolCount === 1 ? "tool" : "tools"}`);
      }
    }
    if (input.artifact !== undefined && input.artifact !== "") this.artifact(input.artifact);
    if (this.verbose && state !== undefined) {
      this.subline("tools: ", `${state.toolCount} · aggregate tool execution ${formatToolDuration(state.aggregateToolMs)}`);
    }
    this.phases.delete(context.phaseId);
    if (input.manageTitle !== false) this.title(context.target, input.failed === true ? "Failed" : "Completed", context.revision, context.pass, context.repository);
  }

  artifact(value: string): void {
    const maxLength = this.stream.isTTY === true ? Math.max(24, terminalWidth(this.stream) - 12) : Number.MAX_SAFE_INTEGER;
    this.subline("artifact: ", shortenPath(value, this.roots, maxLength));
  }

  verificationStarted(command: string): void {
    this.line(this.stream.isTTY === true ? fitRecord("VERIFY RUNNING · ", command, "", terminalWidth(this.stream)) : `VERIFY RUNNING · ${command}`);
    this.title(this.identity?.target, "Verification", undefined, undefined, this.identity?.repository);
  }

  verification(input: { command: string; ok: boolean; exitCode: number; elapsedMs: number; timedOut?: boolean | undefined; reason?: string | undefined; diagnostic?: string | undefined }): void {
    const status = input.timedOut === true ? "TIMED OUT" : input.ok ? "PASSED" : "FAILED";
    if (this.stream.isTTY !== true) {
      this.line(`VERIFY ${status} · ${input.command} · exit ${input.exitCode} · ${formatToolDuration(input.elapsedMs)}`);
    } else {
      const width = terminalWidth(this.stream);
      const record = fitRecord(`VERIFY ${status} · `, input.command, ` · exit ${input.exitCode} · ${formatToolDuration(input.elapsedMs)}`, width);
      if (Array.from(record).length <= width) {
        this.line(record);
      } else {
        this.line(`VERIFY ${status} · ${input.command}`);
        this.subline("elapsed: ", `${formatToolDuration(input.elapsedMs)} · exit ${input.exitCode}`);
      }
    }
    if (!input.ok && input.reason !== undefined && input.reason !== "") this.subline("reason: ", input.reason);
    if (!input.ok && input.diagnostic !== undefined && input.diagnostic !== "") this.subline("output: ", input.diagnostic, true);
    this.title(this.identity?.target, input.ok ? "Verification passed" : "Verification failed", undefined, undefined, this.identity?.repository);
  }

  outcome(status: "SUCCESS" | "FAILED" | "BLOCKED" | "STOPPED", target?: string, detail?: string): void {
    const outcomeTarget = target ?? this.identity?.target ?? this.identity?.command ?? "Roark";
    this.line(`${status} ${outcomeTarget}${detail !== undefined && detail !== "" ? ` · ${detail}` : ""}`);
    this.title(outcomeTarget, status === "SUCCESS" ? "Completed" : status.toLowerCase(), undefined, undefined, this.identity?.repository);
  }

  recovery(command: string): void {
    this.stream.write("  continue:\n");
    this.stream.write(`    ${sanitizeTerminalLine(command)}\n`);
  }

  verboseAgentResponse(markdown: string): void {
    if (!this.verbose) return;
    for (const line of renderMarkdownLines(markdown)) {
      if (line.preformatted || this.stream.isTTY !== true) this.stream.write(`${line.value}\n`);
      else this.wrappedLine(line.value);
    }
  }

  line(value: string): void {
    this.writeLine(this.stream, value);
  }

  warning(value: string): void {
    const message = value.startsWith("WARNING ") ? value : `WARNING ${value}`;
    this.writeLine(this.errorStream, message);
  }

  private subline(label: string, value: string, retainTail = false): void {
    const prefix = `  ${label}`;
    const clean = sanitizeTerminalLine(value);
    if (this.stream.isTTY !== true) {
      this.stream.write(`${prefix}${clean}\n`);
      return;
    }
    const budget = Math.max(1, terminalWidth(this.stream) - Array.from(prefix).length);
    const points = Array.from(clean);
    const bounded = points.length <= budget
      ? clean
      : retainTail
        ? `${budget === 1 ? "" : "…"}${points.slice(-(budget === 1 ? 1 : budget - 1)).join("")}`
        : `${points.slice(0, Math.max(0, budget - 1)).join("")}…`;
    this.stream.write(`${prefix}${bounded}\n`);
  }

  private wrappedLine(value: string): void {
    for (const line of wrapTerminalText(value, terminalWidth(this.stream))) this.stream.write(`${line}\n`);
  }

  private writeLine(stream: TerminalStream, value: string): void {
    const clean = normalizeTerminalText(value);
    stream.write(`${stream.isTTY === true ? boundLine(clean, terminalWidth(stream)) : clean}\n`);
  }

  private title(
    target: string | undefined,
    phase: string,
    revision: string | number | undefined,
    pass: string | number | undefined,
    repository: string | undefined,
  ): void {
    setTerminalTitle(this.stream, { target, phase, revision, pass, repository }, {
      enabled: this.titleEnabled,
      ...(this.env ? { env: this.env } : {}),
    });
  }
}

const presenterStorage = new AsyncLocalStorage<Presenter>();
let fallbackPresenter = new Presenter();

export function configurePresenter(options: PresenterOptions): Presenter {
  fallbackPresenter = new Presenter(options);
  return fallbackPresenter;
}

export function runWithPresenter<T>(presentation: Presenter, work: () => T): T {
  return presenterStorage.run(presentation, work);
}

export function presenter(): Presenter {
  return presenterStorage.getStore() ?? fallbackPresenter;
}

export function renderMarkdownPlain(markdown: string): string {
  return renderMarkdownLines(markdown).map((line) => line.value).join("\n").trim();
}

interface MarkdownLine {
  value: string;
  preformatted: boolean;
}

function renderMarkdownLines(markdown: string): MarkdownLine[] {
  const output: string[] = [];
  const preformatted: boolean[] = [];
  let inFence = false;
  for (const rawLine of markdown.replace(/\r\n/g, "\n").split("\n")) {
    if (/^\s*```/.test(rawLine)) {
      inFence = !inFence;
      continue;
    }
    let line = rawLine;
    if (!inFence) {
      line = line.replace(/^#{1,6}\s+/, "").replace(/^\s*[-*+]\s+/, "- ");
      line = line.replace(/`([^`]+)`/g, "$1").replace(/\*\*([^*]+)\*\*/g, "$1");
    }
    output.push(inFence ? sanitizeTerminalLine(line) : normalizeTerminalText(line));
    preformatted.push(inFence);
  }
  return output
    .map((value, index) => ({ value, preformatted: preformatted[index] ?? false }))
    .filter((line, index, values) => line.value !== "" || (index > 0 && values[index - 1]?.value !== ""));
}

function shortRepo(repository: string | undefined): string {
  const clean = normalizeTerminalText(repository);
  return clean.split("/").at(-1) ?? clean;
}

function fitRecord(prefix: string, value: string, suffix: string, width: number): string {
  const fixedLength = Array.from(prefix).length + Array.from(suffix).length;
  const budget = Math.max(1, width - fixedLength);
  const points = Array.from(normalizeTerminalText(value));
  const bounded = points.length <= budget ? points.join("") : budget === 1 ? "…" : `${points.slice(0, budget - 1).join("")}…`;
  return `${prefix}${bounded}${suffix}`;
}

function wrapTerminalText(value: string, width: number): string[] {
  const clean = normalizeTerminalText(value);
  if (clean === "") return [""];

  const lines: string[] = [];
  let current = "";
  for (const word of clean.split(" ")) {
    if (current === "") {
      current = word;
      continue;
    }
    if (Array.from(`${current} ${word}`).length <= width) {
      current += ` ${word}`;
      continue;
    }
    lines.push(current);
    current = word;
  }
  lines.push(current);
  return lines;
}
