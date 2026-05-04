export type ProcessResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export async function runProcess(args: string[], options: { cwd?: string } = {}): Promise<ProcessResult> {
  const process = Bun.spawn(args, {
    cwd: options.cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);

  return { stdout, stderr, exitCode };
}

export async function runProcessOrThrow(args: string[], options: { cwd?: string; label?: string } = {}): Promise<string> {
  const result = await runProcess(args, { cwd: options.cwd });
  if (result.exitCode !== 0) {
    const label = options.label ?? args.join(" ");
    throw new Error(`${label} failed with exit code ${result.exitCode}:\n${result.stderr || result.stdout}`);
  }
  return result.stdout;
}
