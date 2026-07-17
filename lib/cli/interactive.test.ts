import { describe, expect, test } from "bun:test";
import { promptForInteractiveArgv, promptForWorkspaceRemoval, resolveInteractiveArgv } from "./interactive.ts";
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
  test("maps confirmed next ready issue selection to argv", async () => {
    await noopAsync();
    const { prompt, output } = scriptedPrompt(["1", "yes"]);

    expect(promptForInteractiveArgv(prompt)).resolves.toEqual(["auto"]);
    expect(output.join("")).toContain("1. Work on next ready issue\n   → roark auto");
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
      ["7", ["status", "42"]],
    ];

    for (const [choice, argv] of cases) {
      const { prompt, prompts } = scriptedPrompt([choice, "42"]);
      expect(promptForInteractiveArgv(prompt)).resolves.toEqual(argv);
      expect(prompts).toEqual(["Select an option: ", "Issue: "]);
    }
  });

  test("keeps fresh PR review separate from feedback revision", async () => {
    await noopAsync();
    const review = scriptedPrompt(["5", "", "123"]);
    expect(promptForInteractiveArgv(review.prompt)).resolves.toEqual(["review-pr", "123"]);
    expect(review.prompts).toEqual(["Select an option: ", "PR number: ", "PR number: "]);
    expect(review.output.join("")).toContain("PR number is required.");

    const revise = scriptedPrompt(["6", "123"]);
    expect(promptForInteractiveArgv(revise.prompt)).resolves.toEqual(["revise-pr", "123"]);
  });

  test("maps workspace removal to the interactive remove command", async () => {
    await noopAsync();
    const { prompt, prompts } = scriptedPrompt(["8"]);
    expect(promptForInteractiveArgv(prompt)).resolves.toEqual(["remove"]);
    expect(prompts).toEqual(["Select an option: "]);
  });

  test("maps help to argv", async () => {
    await noopAsync();
    const { prompt } = scriptedPrompt(["9"]);

    expect(promptForInteractiveArgv(prompt)).resolves.toEqual(["--help"]);
  });

  test("retries invalid menu choices", async () => {
    await noopAsync();
    const { prompt, output } = scriptedPrompt(["bad", "9"]);

    expect(promptForInteractiveArgv(prompt)).resolves.toEqual(["--help"]);
    expect(output.join("")).toContain("Invalid choice. Please choose 1-9.");
  });
});

describe("promptForWorkspaceRemoval", () => {
  const workspacePaths: [string, string, string] = ["/workspaces/repo/issue-12", "/workspaces/repo/issue-34", "/workspaces/repo/pr-56"];

  test("lists workspaces and supports multi-selection with ranges", async () => {
    await noopAsync();
    const { prompt, prompts, output } = scriptedPrompt(["1,3-3", "yes"]);
    expect(promptForWorkspaceRemoval({ workspacePaths, prompt })).resolves.toEqual({
      selectedIndexes: [0, 2],
    });
    expect(output.join("")).toContain("1. issue-12");
    expect(output.join("")).toContain("3. pr-56");
    expect(prompts).toEqual([
      "Select workspaces to remove (for example 1,3-5 or all; Enter to cancel): ",
      "Remove 2 selected workspaces? [y/N] ",
    ]);
  });

  test("retries invalid selections and allows cancellation", async () => {
    await noopAsync();
    const invalid = scriptedPrompt(["4", "all", "yes"]);
    expect(promptForWorkspaceRemoval({ workspacePaths, prompt: invalid.prompt })).resolves.toEqual({ selectedIndexes: [0, 1, 2] });
    expect(invalid.output.join("")).toContain("Invalid selection.");

    const cancelled = scriptedPrompt([""]);
    expect(promptForWorkspaceRemoval({ workspacePaths, prompt: cancelled.prompt })).resolves.toBeUndefined();
    expect(cancelled.output.join("")).toContain("Cancelled.");
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
