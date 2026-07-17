import { createInterface } from "node:readline/promises";
import path from "node:path";

export type InteractiveArgv = string[] | undefined;

export interface InteractivePrompt {
  question(prompt: string): Promise<string>;
  write?(text: string): void;
}

export interface WorkspaceRemovalSelection {
  selectedIndexes: number[];
}

type TtyInput = NodeJS.ReadStream & { isTTY?: boolean };
type WritableOutput = NodeJS.WriteStream | { write(text: string): unknown };

const menu = `Issue workflows
1. Work on next ready issue
   → roark auto
2. Work on a specific issue
   → roark auto <issue>
3. Resume an issue workflow
   → roark continue <issue>
4. Run issue workflow in current checkout
   → roark do <issue>

Pull requests
5. Review an existing PR
   → roark review-pr <number>
6. Address PR review feedback
   → roark revise-pr <number>

Management
7. View workflow status
   → roark status <issue>
8. Remove a managed workspace
   → roark remove
9. Help and command reference
   → roark --help
`;

export async function resolveInteractiveArgv(options: {
  stdin?: TtyInput | undefined;
  stdout?: WritableOutput | undefined;
} = {}): Promise<InteractiveArgv> {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;

  if (!stdin.isTTY) return ["--help"];
  return runReadlinePrompt(stdin, stdout, promptForInteractiveArgv);
}

export async function promptForInteractiveArgv(prompt: InteractivePrompt): Promise<InteractiveArgv> {
  for (;;) {
    prompt.write?.(menu);
    const choice = (await prompt.question("Select an option: ")).trim();

    if (choice === "1") {
      if (await confirm(prompt, "Work on the next ready issue?")) return ["auto"];
      prompt.write?.("Cancelled.\n");
      return undefined;
    }

    if (choice === "2") {
      const issue = await promptRequiredIssue(prompt);
      if (await confirm(prompt, `Work on issue ${issue}?`)) return ["auto", issue];
      prompt.write?.("Cancelled.\n");
      return undefined;
    }

    if (choice === "3") return ["continue", await promptRequiredIssue(prompt)];
    if (choice === "4") return ["do", await promptRequiredIssue(prompt)];
    if (choice === "5") return ["review-pr", await promptRequiredPrNumber(prompt)];
    if (choice === "6") return ["revise-pr", await promptRequiredPrNumber(prompt)];
    if (choice === "7") return ["status", await promptRequiredIssue(prompt)];

    if (choice === "8") {
      return ["remove"];
    }

    if (choice === "9") return ["--help"];

    prompt.write?.("Invalid choice. Please choose 1-9.\n");
  }
}

export async function resolveInteractiveWorkspaceRemoval(options: {
  workspacePaths: string[];
  stdin?: TtyInput | undefined;
  stdout?: WritableOutput | undefined;
}): Promise<WorkspaceRemovalSelection | undefined> {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  if (!stdin.isTTY) {
    throw new Error("Interactive workspace selection requires a TTY. Pass issue numbers or use --pr to select workspaces explicitly.");
  }
  return runReadlinePrompt(stdin, stdout, (prompt) => promptForWorkspaceRemoval({ workspacePaths: options.workspacePaths, prompt }));
}

export async function promptForWorkspaceRemoval(options: {
  workspacePaths: string[];
  prompt: InteractivePrompt;
}): Promise<WorkspaceRemovalSelection | undefined> {
  const { prompt, workspacePaths } = options;
  prompt.write?.("Managed workspaces:\n");
  for (const [index, workspacePath] of workspacePaths.entries()) {
    prompt.write?.(`  ${index + 1}. ${path.basename(workspacePath)}  ${workspacePath}\n`);
  }

  for (;;) {
    const answer = (await prompt.question("Select workspaces to remove (for example 1,3-5 or all; Enter to cancel): ")).trim().toLowerCase();
    if (!answer) {
      prompt.write?.("Cancelled.\n");
      return undefined;
    }

    const indexes = parseWorkspaceSelection(answer, workspacePaths.length);
    if (!indexes) {
      prompt.write?.(`Invalid selection. Choose numbers from 1 to ${workspacePaths.length}, ranges, or all.\n`);
      continue;
    }

    if (!await confirm(prompt, `Remove ${indexes.length} selected workspace${indexes.length === 1 ? "" : "s"}?`)) {
      prompt.write?.("Cancelled.\n");
      return undefined;
    }
    return { selectedIndexes: indexes.map((index) => index - 1) };
  }
}

async function runReadlinePrompt<T>(
  stdin: TtyInput,
  stdout: WritableOutput,
  run: (prompt: InteractivePrompt) => Promise<T>,
): Promise<T | undefined> {
  const rl = createInterface({ input: stdin, output: stdout as NodeJS.WriteStream });
  rl.on("SIGINT", () => {
    rl.close();
  });

  try {
    return await run({
      question: (question) => rl.question(question),
      write: (text) => stdout.write(text),
    });
  } catch (error) {
    if (isCleanReadlineExit(error)) {
      stdout.write("\n");
      return undefined;
    }
    throw error;
  } finally {
    rl.close();
  }
}

function parseWorkspaceSelection(input: string, maximum: number): number[] | undefined {
  if (input === "all") return Array.from({ length: maximum }, (_, index) => index + 1);
  const selected = new Set<number>();
  for (const part of input.split(",")) {
    const token = part.trim();
    const range = /^(\d+)-(\d+)$/.exec(token);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      if (start < 1 || end > maximum || start > end) return undefined;
      for (let index = start; index <= end; index++) selected.add(index);
      continue;
    }
    if (!/^\d+$/.test(token)) return undefined;
    const index = Number(token);
    if (index < 1 || index > maximum) return undefined;
    selected.add(index);
  }
  return selected.size > 0 ? [...selected].toSorted((left, right) => left - right) : undefined;
}

async function promptRequiredIssue(prompt: InteractivePrompt): Promise<string> {
  for (;;) {
    const issue = (await prompt.question("Issue: ")).trim();
    if (issue) return issue;
    prompt.write?.("Issue is required.\n");
  }
}

async function promptRequiredPrNumber(prompt: InteractivePrompt): Promise<string> {
  for (;;) {
    const prNumber = (await prompt.question("PR number: ")).trim();
    if (prNumber) return prNumber;
    prompt.write?.("PR number is required.\n");
  }
}

async function confirm(prompt: InteractivePrompt, message: string): Promise<boolean> {
  const answer = (await prompt.question(`${message} [y/N] `)).trim().toLowerCase();
  return answer === "y" || answer === "yes";
}

function isCleanReadlineExit(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "AbortError" || error.message.toLowerCase().includes("readline was closed");
}
