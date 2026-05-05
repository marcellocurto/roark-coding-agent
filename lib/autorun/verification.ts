import { runProcess } from "../cli/process.ts";
import { writeArtifact, type WorkflowContext } from "../workflow/artifacts.ts";

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

function tailText(value: string): string {
  if (value.length <= verificationOutputTailBytes) return value;
  return `... (truncated ${value.length - verificationOutputTailBytes} earlier bytes) ...\n${value.slice(-verificationOutputTailBytes)}`;
}
