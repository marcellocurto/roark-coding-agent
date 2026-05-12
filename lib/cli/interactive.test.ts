import { describe, expect, test } from "bun:test";
import { promptForInteractiveArgv, resolveInteractiveArgv } from "./interactive.ts";
import { noopAsync } from "../utils/async.ts";

function scriptedPrompt(responses: string[]) {
  const prompts: string[] = [];
  const output: string[] = [];
  return {
    prompts,
    output,
    prompt: {
      write(text: string) {
        output.push(text);
      },
      async question(prompt: string): Promise<string> {
        await noopAsync();
        prompts.push(prompt);
        const response = responses.shift();
        if (response === undefined) throw new Error(`No scripted response for ${prompt}`);
        return response;
      },
    },
  };
}

describe("promptForInteractiveArgv", () => {
  test("maps confirmed auto discover to argv", async () => {
    await noopAsync();
    const { prompt, output } = scriptedPrompt(["1", "yes"]);

    expect(promptForInteractiveArgv(prompt)).resolves.toEqual(["auto"]);
    expect(output.join("")).toContain("1. Auto discover");
  });

  test("maps confirmed auto issue to argv and retries empty issue input", async () => {
    await noopAsync();
    const { prompt, output } = scriptedPrompt(["2", "", "42", "y"]);

    expect(promptForInteractiveArgv(prompt)).resolves.toEqual(["auto", "42"]);
    expect(output.join("")).toContain("Issue is required.");
  });

  test("declined auto confirmation exits cleanly", async () => {
    await noopAsync();
    const { prompt, output } = scriptedPrompt(["1", "no"]);

    expect(promptForInteractiveArgv(prompt)).resolves.toBeUndefined();
    expect(output.join("")).toContain("Cancelled.");
  });

  test("maps issue commands without confirmation", async () => {
    await noopAsync();
    const cases: [string, string[]][] = [
      ["3", ["continue", "42"]],
      ["4", ["do", "42"]],
      ["6", ["status", "42"]],
    ];

    for (const [choice, argv] of cases) {
      const { prompt, prompts } = scriptedPrompt([choice, "42"]);
      expect(promptForInteractiveArgv(prompt)).resolves.toEqual(argv);
      expect(prompts).toEqual(["Select an option: ", "Issue: "]);
    }
  });

  test("maps revise PR to argv and retries empty PR input", async () => {
    await noopAsync();
    const { prompt, output, prompts } = scriptedPrompt(["5", "", "123"]);

    expect(promptForInteractiveArgv(prompt)).resolves.toEqual(["revise-pr", "123"]);
    expect(prompts).toEqual(["Select an option: ", "PR number: ", "PR number: "]);
    expect(output.join("")).toContain("PR number is required.");
  });

  test("maps workspace remove to argv and asks whether to force", async () => {
    await noopAsync();
    const forcePrompt = scriptedPrompt(["7", "issue", "42", "yes"]);
    expect(promptForInteractiveArgv(forcePrompt.prompt)).resolves.toEqual(["workspace", "remove", "--issue", "42", "--force"]);
    expect(forcePrompt.prompts).toEqual(["Select an option: ", "Remove issue or PR workspace? [issue/pr] ", "Issue: ", "Force remove dirty workspace? [y/N] "]);

    const cleanPrompt = scriptedPrompt(["7", "pr", "98", "no"]);
    expect(promptForInteractiveArgv(cleanPrompt.prompt)).resolves.toEqual(["workspace", "remove", "--pr", "98"]);
  });

  test("maps help to argv", async () => {
    await noopAsync();
    const { prompt } = scriptedPrompt(["8"]);

    expect(promptForInteractiveArgv(prompt)).resolves.toEqual(["--help"]);
  });

  test("retries invalid menu choices", async () => {
    await noopAsync();
    const { prompt, output } = scriptedPrompt(["bad", "8"]);

    expect(promptForInteractiveArgv(prompt)).resolves.toEqual(["--help"]);
    expect(output.join("")).toContain("Invalid choice. Please choose 1-8.");
  });
});

describe("resolveInteractiveArgv", () => {
  test("returns help argv for no-args non-TTY mode without waiting for input", async () => {
    await noopAsync();
    const stdin = { isTTY: false } as NodeJS.ReadStream & { isTTY?: boolean };
    const writes: string[] = [];
    const stdout = { write: (text: string) => writes.push(text) };

    expect(resolveInteractiveArgv({ stdin, stdout })).resolves.toEqual(["--help"]);
    expect(writes).toEqual([]);
  });
});
