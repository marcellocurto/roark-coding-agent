export interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export async function runProcess(args: string[], options: { cwd?: string | undefined; input?: string | undefined } = {}): Promise<ProcessResult> {
  const process = Bun.spawn(args, {
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    env: processEnv(),
    stdin: options.input === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  if (options.input !== undefined) {
    const stdin = process.stdin;
    if (!stdin) throw new Error("Process stdin pipe was not created.");
    await stdin.write(options.input);
    await stdin.end();
  }

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);

  return { stdout, stderr, exitCode };
}

export async function runProcessOrThrow(args: string[], options: { cwd?: string | undefined; label?: string; input?: string | undefined } = {}): Promise<string> {
  const result = await runProcess(args, { cwd: options.cwd, input: options.input });
  if (result.exitCode !== 0) {
    const label = options.label ?? args.join(" ");
    throw new Error(`${label} failed with exit code ${result.exitCode}:\n${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function processEnv(): Record<string, string> {
  return Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
}
