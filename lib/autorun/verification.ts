import { Presentation, Verification } from "../runtime/services.ts";
import type { ApplicationExecution } from "../runtime/application.ts";
import { Effect, Layer } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import {
  executeProcess,
  type InvalidProcessCommandError,
  type ProcessExecutionError,
} from "../cli/process.ts";
import { runApplicationPromise } from "../runtime/application.ts";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  verificationBeforeFixFullRef,
  verificationBeforeFixRef,
  type WorkflowContext,
} from "../workflow/artifacts.ts";
import { writeArtifactPromise as writeArtifact } from "../workflow/artifacts-promise.ts";
import { type VerificationDisplayContext } from "../presentation/presenter.ts";

export const defaultAutorunVerifyCommand = "bun run typecheck";

const verificationOutputTailBytes = 4_000;
export const defaultVerificationTimeoutMs = 600_000;

export async function inferVerificationCommand(
  cwd: string,
  options: {
    scripts?: readonly string[] | undefined;
    allowMakefile?: boolean | undefined;
  } = {},
): Promise<string | undefined> {
  const scripts = options.scripts ?? ["typecheck", "test"];
  const packagePath = path.join(cwd, "package.json");
  if (existsSync(packagePath)) {
    try {
      const parsed = JSON.parse(await readFile(packagePath, "utf8")) as {
        scripts?: Record<string, unknown>;
      };
      const script = scripts.find(
        (candidate) =>
          typeof parsed.scripts?.[candidate] === "string" &&
          parsed.scripts[candidate].trim().length > 0,
      );
      if (script) return `${packageRunner(cwd)} ${script}`;
    } catch {
      // Continue to other repository-native inference sources.
    }
  }
  if (options.allowMakefile !== false) {
    const makefilePath = path.join(cwd, "Makefile");
    if (
      existsSync(makefilePath) &&
      /^test\s*:/m.test(await readFile(makefilePath, "utf8"))
    )
      return "make test";
  }
  return undefined;
}

function packageRunner(cwd: string): string {
  if (
    existsSync(path.join(cwd, "bun.lock")) ||
    existsSync(path.join(cwd, "bun.lockb"))
  )
    return "bun run";
  if (existsSync(path.join(cwd, "pnpm-lock.yaml"))) return "pnpm run";
  if (existsSync(path.join(cwd, "yarn.lock"))) return "yarn";
  if (
    existsSync(path.join(cwd, "package-lock.json")) ||
    existsSync(path.join(cwd, "npm-shrinkwrap.json"))
  )
    return "npm run";
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

export interface VerificationRequest {
  command: string;
  cwd: string;
  timeoutMs: number;
}

export interface VerificationFailureClassification {
  repairable: boolean;
  reason: string;
  recoveryGuidance?: string | undefined;
}

const executeVerification = Effect.fnUntraced(function* ({
  command,
  cwd,
  timeoutMs,
}: VerificationRequest): Effect.fn.Return<
  VerificationResult,
  InvalidProcessCommandError | ProcessExecutionError,
  ChildProcessSpawner
> {
  const result = yield* executeProcess(["sh", "-c", command], {
    cwd,
    timeoutMs,
  });
  return {
    ...result,
    command,
    ok: !result.timedOut && result.exitCode === 0,
    stderr: result.timedOut
      ? `${result.stderr}${result.stderr.endsWith("\n") || result.stderr.length === 0 ? "" : "\n"}Timed out after ${timeoutMs}ms.\n`
      : result.stderr,
  };
});

export const verificationLayer = Layer.effect(
  Verification,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner;
    return Verification.of({
      execute: (request) =>
        executeVerification(request).pipe(
          Effect.provideService(ChildProcessSpawner, spawner),
        ),
    });
  }),
);

interface VerificationOptions {
  command: string;
  cwd: string;
  timeoutMs?: number | undefined;
  display?: VerificationDisplayContext | undefined;
}

export const runVerification = Effect.fn("runVerification")(function* (
  options: VerificationOptions,
): Effect.fn.Return<
  VerificationResult,
  InvalidProcessCommandError | ProcessExecutionError,
  Verification | Presentation
> {
  const startedAt = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
  const presentation = yield* Presentation;
  presentation.verificationStarted(options.command, options.display ?? {});
  const request = {
    command: options.command,
    cwd: options.cwd,
    timeoutMs: options.timeoutMs ?? defaultVerificationTimeoutMs,
  };
  const verification = yield* Verification;
  const result = yield* verification.execute(request).pipe(
    Effect.tapError((error) =>
      Effect.gen(function* () {
        const endedAt = yield* Effect.clockWith(
          (clock) => clock.currentTimeMillis,
        );
        presentation.verification({
          command: options.command,
          ok: false,
          exitCode: -1,
          elapsedMs: endedAt - startedAt,
          reason: "verification could not be executed",
          diagnostic: error.message,
          display: options.display,
        });
      }),
    ),
  );
  const endedAt = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
  const classification = classifyVerificationFailure(result);
  presentation.verification({
    command: options.command,
    ok: result.ok,
    exitCode: result.exitCode,
    elapsedMs: endedAt - startedAt,
    timedOut: result.timedOut,
    ...(!result.ok
      ? {
          reason: classification.reason,
          diagnostic: tailText(result.stderr || result.stdout).slice(-500),
        }
      : {}),
    display: options.display,
  });
  return result;
});

// Promise compatibility ends here; migrated callers compose runVerification.
export function runVerificationPromise(
  options: VerificationOptions,
  application?: ApplicationExecution,
): Promise<VerificationResult> {
  return runApplicationPromise(runVerification(options), application);
}

export function formatVerificationArtifact(result: VerificationResult): string {
  return formatVerificationOutput(result, tailText, " (tail)");
}

export function formatCompleteVerificationArtifact(
  result: VerificationResult,
): string {
  return formatVerificationOutput(result, (value) => value, "");
}

function formatVerificationOutput(
  result: VerificationResult,
  formatOutput: (value: string) => string,
  headingSuffix: string,
): string {
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
  application?: ApplicationExecution,
): Promise<void> {
  await writeArtifact(
    context,
    "verification",
    formatVerificationArtifact(result),
    application,
  );
  await writeArtifact(
    context,
    "verificationFull",
    formatCompleteVerificationArtifact(result),
    application,
  );
}

export async function writeVerificationBeforeFixArtifact(
  context: WorkflowContext,
  pass: number,
  result: VerificationResult,
  application?: ApplicationExecution,
): Promise<void> {
  await writeArtifact(
    context,
    verificationBeforeFixRef(pass),
    formatVerificationArtifact(result),
    application,
  );
  await writeArtifact(
    context,
    verificationBeforeFixFullRef(pass),
    formatCompleteVerificationArtifact(result),
    application,
  );
}

export function classifyVerificationFailure(
  result: VerificationResult,
): VerificationFailureClassification {
  if (result.timedOut !== true && (result.ok || result.exitCode === 0)) {
    return { repairable: false, reason: "verification passed" };
  }

  if (result.timedOut === true) {
    return {
      repairable: false,
      reason: "verification timed out",
      recoveryGuidance:
        "Run a narrower explicit verification command or increase the configured command's own timeout.",
    };
  }

  const output = `${result.stdout}\n${result.stderr}`.toLowerCase();
  if (result.exitCode === 127 || looksLikeCommandUnavailable(output)) {
    return {
      repairable: false,
      reason: `verification command exited ${result.exitCode} because a required command was not found`,
      recoveryGuidance:
        "Install dependencies in the verification workspace or configure hooks.beforeVerify, for example: bun install --frozen-lockfile.",
    };
  }
  if (
    result.exitCode === 126 ||
    /permission denied|operation not permitted/.test(output)
  ) {
    return {
      repairable: false,
      reason: `verification command exited ${result.exitCode} because a command could not be executed`,
      recoveryGuidance:
        "Fix executable permissions or workspace/sandbox permissions, then rerun verification.",
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

export function parseVerificationArtifact(
  markdown: string,
): VerificationResult | undefined {
  const exitCodeMatch = /##\s*Exit Code\s*\r?\n+\s*(-?\d+)/i.exec(markdown);
  const exitCode =
    exitCodeMatch?.[1] === undefined ? undefined : Number(exitCodeMatch[1]);
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
  return (
    /(^|\n)\s*(?:\/[^\s:\n]*(?:sh|bash|zsh|fish|dash)|sh|bash|zsh|fish|dash|env):\s*(?:(?:line\s*)?\d+:\s*)?[^:\n]+:\s*(?:command not found|not found)\s*(?:\n|$)/.test(
      output,
    ) ||
    /(^|\n)\s*(?:zsh|fish):\s*command not found:\s*[^:\n]+\s*(?:\n|$)/.test(
      output,
    )
  );
}

function extractFencedSection(markdown: string, headingPrefix: string): string {
  const heading = new RegExp(`##\\s*${headingPrefix}[^\\r\\n]*`, "i").exec(
    markdown,
  );
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
