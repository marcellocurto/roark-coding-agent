import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { verificationBeforeFixFullRef, verificationBeforeFixRef, writeArtifact, type WorkflowContext } from "../workflow/artifacts.ts";
import { presenter, type VerificationDisplayContext } from "../presentation/presenter.ts";

export const defaultAutorunVerifyCommand = "bun run typecheck";

const verificationOutputTailBytes = 4_000;
export const defaultVerificationTimeoutMs = 600_000;

export async function inferVerificationCommand(
  cwd: string,
  options: { scripts?: readonly string[] | undefined; allowMakefile?: boolean | undefined } = {},
): Promise<string | undefined> {
  const scripts = options.scripts ?? ["typecheck", "test"];
  const packagePath = path.join(cwd, "package.json");
  if (existsSync(packagePath)) {
    try {
      const parsed = JSON.parse(await readFile(packagePath, "utf8")) as { scripts?: Record<string, unknown> };
      const script = scripts.find((candidate) => typeof parsed.scripts?.[candidate] === "string" && parsed.scripts[candidate].trim().length > 0);
      if (script) return `${packageRunner(cwd)} ${script}`;
    } catch {
      // Continue to other repository-native inference sources.
    }
  }
  if (options.allowMakefile !== false) {
    const makefilePath = path.join(cwd, "Makefile");
    if (existsSync(makefilePath) && /^test\s*:/m.test(await readFile(makefilePath, "utf8"))) return "make test";
  }
  return undefined;
}

function packageRunner(cwd: string): string {
  if (existsSync(path.join(cwd, "bun.lock")) || existsSync(path.join(cwd, "bun.lockb"))) return "bun run";
  if (existsSync(path.join(cwd, "pnpm-lock.yaml"))) return "pnpm run";
  if (existsSync(path.join(cwd, "yarn.lock"))) return "yarn";
  if (existsSync(path.join(cwd, "package-lock.json")) || existsSync(path.join(cwd, "npm-shrinkwrap.json"))) return "npm run";
  return "bun run";
}

export interface VerificationResult {
  ok: boolean;
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean | undefined;
}

export type VerificationRunner = (request: { command: string; cwd: string; timeoutMs: number }) => Promise<VerificationResult>;

export interface VerificationFailureClassification {
  repairable: boolean;
  reason: string;
  recoveryGuidance?: string | undefined;
}

export const defaultVerificationRunner: VerificationRunner = async ({ command, cwd, timeoutMs }) => {
  const child = Bun.spawn(["sh", "-c", command], { cwd, stdout: "pipe", stderr: "pipe", detached: true });
  const state = { timedOut: false };
  const timer = setTimeout(() => {
    state.timedOut = true;
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }, timeoutMs);
  try {
    const [stdout, rawStderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    const stderr = state.timedOut ? `${rawStderr}${rawStderr.endsWith("\n") || rawStderr.length === 0 ? "" : "\n"}Timed out after ${timeoutMs}ms.\n` : rawStderr;
    return { ok: !state.timedOut && exitCode === 0, command, exitCode, stdout, stderr, timedOut: state.timedOut };
  } finally {
    clearTimeout(timer);
  }
};

export async function runVerification(options: {
  command: string;
  cwd: string;
  runner?: VerificationRunner | undefined  ;
  timeoutMs?: number | undefined;
  now?: (() => number) | undefined;
  display?: VerificationDisplayContext | undefined;
}): Promise<VerificationResult> {
  const runner = options.runner ?? defaultVerificationRunner;
  const now = options.now ?? Date.now;
  const startedAt = now();
  presenter().verificationStarted(options.command, options.display ?? {});
  let result: VerificationResult;
  try {
    result = await runner({ command: options.command, cwd: options.cwd, timeoutMs: options.timeoutMs ?? defaultVerificationTimeoutMs });
  } catch (error) {
    presenter().verification({
      command: options.command,
      ok: false,
      exitCode: -1,
      elapsedMs: now() - startedAt,
      reason: "verification could not be executed",
      diagnostic: error instanceof Error ? error.message : String(error),
      display: options.display,
    });
    throw error;
  }
  const classification = classifyVerificationFailure(result);
  presenter().verification({
    command: options.command,
    ok: result.ok,
    exitCode: result.exitCode,
    elapsedMs: now() - startedAt,
    timedOut: result.timedOut,
    ...(!result.ok ? {
      reason: classification.reason,
      diagnostic: tailText(result.stderr || result.stdout).slice(-500),
    } : {}),
    display: options.display,
  });
  return result;
}

export function formatVerificationArtifact(result: VerificationResult): string {
  return formatVerificationOutput(result, tailText, " (tail)");
}

export function formatCompleteVerificationArtifact(result: VerificationResult): string {
  return formatVerificationOutput(result, (value) => value, "");
}

function formatVerificationOutput(result: VerificationResult, formatOutput: (value: string) => string, headingSuffix: string): string {
  return `# Verification

## Command
\`${result.command}\`

## Exit Code
${result.exitCode}

## Timed Out
${result.timedOut === true ? "yes" : "no"}

## Stdout${headingSuffix}
\`\`\`
${formatOutput(result.stdout)}
\`\`\`

## Stderr${headingSuffix}
\`\`\`
${formatOutput(result.stderr)}
\`\`\`
`;
}

export async function writeVerificationArtifact(
  context: WorkflowContext,
  result: VerificationResult,
): Promise<void> {
  await writeArtifact(context, "verification", formatVerificationArtifact(result));
  await writeArtifact(context, "verificationFull", formatCompleteVerificationArtifact(result));
}

export async function writeVerificationBeforeFixArtifact(
  context: WorkflowContext,
  pass: number,
  result: VerificationResult,
): Promise<void> {
  await writeArtifact(context, verificationBeforeFixRef(pass), formatVerificationArtifact(result));
  await writeArtifact(context, verificationBeforeFixFullRef(pass), formatCompleteVerificationArtifact(result));
}

export function classifyVerificationFailure(result: VerificationResult): VerificationFailureClassification {
  if (result.ok || result.exitCode === 0) {
    return { repairable: false, reason: "verification passed" };
  }

  if (result.timedOut === true) {
    return {
      repairable: false,
      reason: "verification timed out",
      recoveryGuidance: "Run a narrower explicit verification command or increase the configured command's own timeout.",
    };
  }

  const output = `${result.stdout}\n${result.stderr}`.toLowerCase();
  if (result.exitCode === 127 || looksLikeCommandUnavailable(output)) {
    return {
      repairable: false,
      reason: `verification command exited ${result.exitCode} because a required command was not found`,
      recoveryGuidance: "Install dependencies in the verification workspace or configure hooks.beforeVerify, for example: bun install --frozen-lockfile.",
    };
  }
  if (result.exitCode === 126 || /permission denied|operation not permitted/.test(output)) {
    return {
      repairable: false,
      reason: `verification command exited ${result.exitCode} because a command could not be executed`,
      recoveryGuidance: "Fix executable permissions or workspace/sandbox permissions, then rerun verification.",
    };
  }

  return {
    repairable: true,
    reason: `verification command exited ${result.exitCode}`,
  };
}

export function verificationFailureReason(result: VerificationResult): string {
  const classification = classifyVerificationFailure(result);
  if (classification.repairable) return classification.reason;
  return classification.recoveryGuidance
    ? `${classification.reason}. ${classification.recoveryGuidance}`
    : classification.reason;
}

export function parseVerificationArtifact(markdown: string): VerificationResult | undefined {
  const exitCodeMatch = /##\s*Exit Code\s*\r?\n+\s*(-?\d+)/i.exec(markdown);
  const exitCode = exitCodeMatch?.[1] === undefined ? undefined : Number(exitCodeMatch[1]);
  if (exitCode === undefined || !Number.isFinite(exitCode)) return undefined;

  const commandMatch = /##\s*Command\s*\r?\n+\s*`([^`]+)`/i.exec(markdown);
  const command = commandMatch?.[1] ?? "unknown verification command";

  const timedOut = /##\s*Timed Out\s*\r?\n+\s*yes\b/i.test(markdown);
  return {
    ok: exitCode === 0 && !timedOut,
    command,
    exitCode,
    stdout: extractFencedSection(markdown, "Stdout"),
    stderr: extractFencedSection(markdown, "Stderr"),
    ...(timedOut ? { timedOut: true } : {}),
  };
}

function looksLikeCommandUnavailable(output: string): boolean {
  return /(^|\n)\s*(?:\/[^\s:\n]*(?:sh|bash|zsh|fish|dash)|sh|bash|zsh|fish|dash|env):\s*(?:(?:line\s*)?\d+:\s*)?[^:\n]+:\s*(?:command not found|not found)\s*(?:\n|$)/.test(output)
    || /(^|\n)\s*(?:zsh|fish):\s*command not found:\s*[^:\n]+\s*(?:\n|$)/.test(output);
}

function extractFencedSection(markdown: string, headingPrefix: string): string {
  const heading = new RegExp(`##\\s*${headingPrefix}[^\\r\\n]*`, "i").exec(markdown);
  if (heading?.index === undefined) return "";
  const afterHeading = markdown.slice(heading.index + heading[0].length);
  const fenceStart = afterHeading.indexOf("```");
  if (fenceStart === -1) return "";
  const contentStart = fenceStart + "```".length;
  const content = afterHeading.slice(contentStart).replace(/^\r?\n/, "");
  const fenceEnd = content.indexOf("```");
  if (fenceEnd === -1) return "";
  return content.slice(0, fenceEnd).replace(/\r?\n$/, "");
}

function tailText(value: string): string {
  if (value.length <= verificationOutputTailBytes) return value;
  return `... (truncated ${value.length - verificationOutputTailBytes} earlier bytes) ...\n${value.slice(-verificationOutputTailBytes)}`;
}
