import { runProcess } from "../cli/process.ts";
import { verificationBeforeFixRef, writeArtifact, type WorkflowContext } from "../workflow/artifacts.ts";

export const defaultAutorunVerifyCommand = "bun run typecheck";

const verificationOutputTailBytes = 4_000;

export type VerificationResult = {
  ok: boolean;
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type VerificationRunner = (request: { command: string; cwd: string }) => Promise<VerificationResult>;

export type VerificationFailureClassification = {
  repairable: boolean;
  reason: string;
  recoveryGuidance?: string;
};

export const defaultVerificationRunner: VerificationRunner = async ({ command, cwd }) => {
  const result = await runProcess(["sh", "-c", command], { cwd });
  return {
    ok: result.exitCode === 0,
    command,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  };
};

export async function runVerification(options: {
  command: string;
  cwd: string;
  runner?: VerificationRunner;
}): Promise<VerificationResult> {
  const runner = options.runner ?? defaultVerificationRunner;
  console.log(`\n=== Verification ===`);
  console.log(`Command: ${options.command}`);
  console.log(`Cwd: ${options.cwd}`);
  const result = await runner({ command: options.command, cwd: options.cwd });
  if (result.ok) {
    console.log(`✓ Verification: command exited 0`);
  } else {
    console.log(`✗ Verification: command exited ${result.exitCode}`);
  }
  return result;
}

export function formatVerificationArtifact(result: VerificationResult): string {
  return `# Verification

## Command
\`${result.command}\`

## Exit Code
${result.exitCode}

## Stdout (tail)
\`\`\`
${tailText(result.stdout)}
\`\`\`

## Stderr (tail)
\`\`\`
${tailText(result.stderr)}
\`\`\`
`;
}

export async function writeVerificationArtifact(
  context: WorkflowContext,
  result: VerificationResult,
): Promise<void> {
  await writeArtifact(context, "verification", formatVerificationArtifact(result));
}

export async function writeVerificationBeforeFixArtifact(
  context: WorkflowContext,
  pass: number,
  result: VerificationResult,
): Promise<void> {
  await writeArtifact(context, verificationBeforeFixRef(pass), formatVerificationArtifact(result));
}

export function classifyVerificationFailure(result: VerificationResult): VerificationFailureClassification {
  if (result.ok || result.exitCode === 0) {
    return { repairable: false, reason: "verification passed" };
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
  const exitCodeMatch = markdown.match(/##\s*Exit Code\s*\r?\n+\s*(-?\d+)/i);
  const exitCode = exitCodeMatch?.[1] === undefined ? undefined : Number(exitCodeMatch[1]);
  if (exitCode === undefined || !Number.isFinite(exitCode)) return undefined;

  const commandMatch = markdown.match(/##\s*Command\s*\r?\n+\s*`([^`]+)`/i);
  const command = commandMatch?.[1] ?? "unknown verification command";

  return {
    ok: exitCode === 0,
    command,
    exitCode,
    stdout: extractFencedSection(markdown, "Stdout"),
    stderr: extractFencedSection(markdown, "Stderr"),
  };
}

function looksLikeCommandUnavailable(output: string): boolean {
  return /(^|\n)\s*(?:\/[^\s:\n]*(?:sh|bash|zsh|fish|dash)|sh|bash|zsh|fish|dash|env):\s*(?:(?:line\s*)?\d+:\s*)?[^:\n]+:\s*(?:command not found|not found)\s*(?:\n|$)/.test(output)
    || /(^|\n)\s*(?:zsh|fish):\s*command not found:\s*[^:\n]+\s*(?:\n|$)/.test(output);
}

function extractFencedSection(markdown: string, headingPrefix: string): string {
  const heading = new RegExp(`##\\s*${headingPrefix}[^\\r\\n]*`, "i").exec(markdown);
  if (!heading || heading.index === undefined) return "";
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
