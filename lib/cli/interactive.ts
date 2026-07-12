import { createInterface } from "node:readline/promises";

export type InteractiveArgv = string[] | undefined;

interface InteractivePrompt {
  question(prompt: string): Promise<string>;
  write?(text: string): void;
}

type TtyInput = NodeJS.ReadStream & { isTTY?: boolean };
type WritableOutput = NodeJS.WriteStream | { write(text: string): unknown };

const menu = `1. Auto discover
2. Auto specific issue
3. Continue
4. Do full workflow
5. Review PR
6. Address PR feedback
7. Status
8. Workspace remove
9. Help
`;

export async function resolveInteractiveArgv(options: {
  stdin?: TtyInput | undefined;
  stdout?: WritableOutput | undefined;
} = {}): Promise<InteractiveArgv> {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;

  if (!stdin.isTTY) return ["--help"];

  const rl = createInterface({ input: stdin, output: stdout as NodeJS.WriteStream });
  rl.on("SIGINT", () => {
    rl.close();
  });

  try {
    return await promptForInteractiveArgv({
      question: (prompt) => rl.question(prompt),
      write: (text) => {
        stdout.write(text);
      },
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

export async function promptForInteractiveArgv(prompt: InteractivePrompt): Promise<InteractiveArgv> {
  for (;;) {
    prompt.write?.(menu);
    const choice = (await prompt.question("Select an option: ")).trim();

    if (choice === "1") {
      if (await confirm(prompt, "Run auto discover?")) return ["auto"];
      prompt.write?.("Cancelled.\n");
      return undefined;
    }

    if (choice === "2") {
      const issue = await promptRequiredIssue(prompt);
      if (await confirm(prompt, `Run auto for issue ${issue}?`)) return ["auto", issue];
      prompt.write?.("Cancelled.\n");
      return undefined;
    }

    if (choice === "3") return ["continue", await promptRequiredIssue(prompt)];
    if (choice === "4") return ["do", await promptRequiredIssue(prompt)];
    if (choice === "5") return ["review-pr", await promptRequiredPrNumber(prompt)];
    if (choice === "6") return ["revise-pr", await promptRequiredPrNumber(prompt)];
    if (choice === "7") return ["status", await promptRequiredIssue(prompt)];

    if (choice === "8") {
      const targetKind = await promptWorkspaceRemoveTargetKind(prompt);
      const flag = targetKind === "pr" ? "--pr" : "--issue";
      const number = targetKind === "pr" ? await promptRequiredPrNumber(prompt) : await promptRequiredIssue(prompt);
      const force = await confirm(prompt, "Force remove dirty workspace?");
      return force ? ["workspace", "remove", flag, number, "--force"] : ["workspace", "remove", flag, number];
    }

    if (choice === "9") return ["--help"];

    prompt.write?.("Invalid choice. Please choose 1-9.\n");
  }
}

async function promptWorkspaceRemoveTargetKind(prompt: InteractivePrompt): Promise<"issue" | "pr"> {
  for (;;) {
    const target = (await prompt.question("Remove issue or PR workspace? [issue/pr] ")).trim().toLowerCase();
    if (target === "issue" || target === "i") return "issue";
    if (target === "pr" || target === "p") return "pr";
    prompt.write?.("Please enter issue or pr.\n");
  }
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
