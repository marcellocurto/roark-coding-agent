import { Deferred, Effect, Exit, Fiber } from "effect";
import { PassThrough } from "node:stream";
import { describe, expect, test } from "bun:test";
import {
  promptForInteractiveArgv,
  promptForWorkspaceRemoval,
  resolveInteractiveArgv,
} from "./interactive.ts";
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
      question: (prompt: string) =>
        Effect.sync(() => {
          prompts.push(prompt);
          const response = responses.shift();
          if (response === undefined)
            throw new Error(`No scripted response for ${prompt}`);
          return response;
        }),
    },
  };
}
describe("promptForInteractiveArgv", () => {
  test("maps confirmed next ready issue selection to argv", async () => {
    await Promise.resolve();
    const { prompt, output } = scriptedPrompt(["1", "yes"]);
    expect(
      Effect.runPromise(promptForInteractiveArgv(prompt)),
    ).resolves.toEqual(["auto"]);
    expect(output.join("")).toContain(
      "1. Work on next ready issue\n   → roark auto",
    );
  });
  test("maps confirmed auto issue to argv and retries empty issue input", async () => {
    await Promise.resolve();
    const { prompt, output } = scriptedPrompt(["2", "", "42", "y"]);
    expect(
      Effect.runPromise(promptForInteractiveArgv(prompt)),
    ).resolves.toEqual(["auto", "42"]);
    expect(output.join("")).toContain("Issue is required.");
  });
  test("declined auto confirmation exits cleanly", async () => {
    await Promise.resolve();
    const { prompt, output } = scriptedPrompt(["1", "no"]);
    expect(
      Effect.runPromise(promptForInteractiveArgv(prompt)),
    ).resolves.toBeUndefined();
    expect(output.join("")).toContain("Cancelled.");
  });
  test("maps issue commands without confirmation", async () => {
    await Promise.resolve();
    const cases: [string, string[]][] = [
      ["3", ["continue", "42"]],
      ["4", ["do", "42"]],
      ["7", ["status", "42"]],
    ];
    for (const [choice, argv] of cases) {
      const { prompt, prompts } = scriptedPrompt([choice, "42"]);
      expect(
        Effect.runPromise(promptForInteractiveArgv(prompt)),
      ).resolves.toEqual(argv);
      expect(prompts).toEqual(["Select an option: ", "Issue: "]);
    }
  });
  test("keeps fresh PR review separate from feedback revision", async () => {
    await Promise.resolve();
    const review = scriptedPrompt(["5", "", "123"]);
    expect(
      Effect.runPromise(promptForInteractiveArgv(review.prompt)),
    ).resolves.toEqual(["review-pr", "123"]);
    expect(review.prompts).toEqual([
      "Select an option: ",
      "PR number: ",
      "PR number: ",
    ]);
    expect(review.output.join("")).toContain("PR number is required.");
    const revise = scriptedPrompt(["6", "123"]);
    expect(
      Effect.runPromise(promptForInteractiveArgv(revise.prompt)),
    ).resolves.toEqual(["revise-pr", "123"]);
  });
  test("maps workspace removal to the interactive remove command", async () => {
    await Promise.resolve();
    const { prompt, prompts } = scriptedPrompt(["8"]);
    expect(
      Effect.runPromise(promptForInteractiveArgv(prompt)),
    ).resolves.toEqual(["remove"]);
    expect(prompts).toEqual(["Select an option: "]);
  });
  test("maps help to argv", async () => {
    await Promise.resolve();
    const { prompt } = scriptedPrompt(["9"]);
    expect(
      Effect.runPromise(promptForInteractiveArgv(prompt)),
    ).resolves.toEqual(["--help"]);
  });
  test("retries invalid menu choices", async () => {
    await Promise.resolve();
    const { prompt, output } = scriptedPrompt(["bad", "9"]);
    expect(
      Effect.runPromise(promptForInteractiveArgv(prompt)),
    ).resolves.toEqual(["--help"]);
    expect(output.join("")).toContain("Invalid choice. Please choose 1-9.");
  });
});
describe("promptForWorkspaceRemoval", () => {
  const workspacePaths: [string, string, string] = [
    "/workspaces/repo/issue-12",
    "/workspaces/repo/issue-34",
    "/workspaces/repo/pr-56",
  ];
  test("lists workspaces and supports multi-selection with ranges", async () => {
    await Promise.resolve();
    const { prompt, prompts, output } = scriptedPrompt(["1,3-3", "yes"]);
    expect(
      Effect.runPromise(promptForWorkspaceRemoval({ workspacePaths, prompt })),
    ).resolves.toEqual({
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
    await Promise.resolve();
    const invalid = scriptedPrompt(["4", "all", "yes"]);
    expect(
      Effect.runPromise(
        promptForWorkspaceRemoval({ workspacePaths, prompt: invalid.prompt }),
      ),
    ).resolves.toEqual({ selectedIndexes: [0, 1, 2] });
    expect(invalid.output.join("")).toContain("Invalid selection.");
    const cancelled = scriptedPrompt([""]);
    expect(
      Effect.runPromise(
        promptForWorkspaceRemoval({ workspacePaths, prompt: cancelled.prompt }),
      ),
    ).resolves.toBeUndefined();
    expect(cancelled.output.join("")).toContain("Cancelled.");
  });
});
describe("resolveInteractiveArgv", () => {
  test("returns help argv for no-args non-TTY mode without waiting for input", async () => {
    await Promise.resolve();
    const stdin = Object.assign(new PassThrough(), { isTTY: false });
    const writes: string[] = [];
    const stdout = new PassThrough();
    stdout.on("data", (chunk: Buffer) => {
      writes.push(chunk.toString());
    });
    expect(
      Effect.runPromise(resolveInteractiveArgv({ stdin, stdout })),
    ).resolves.toEqual(["--help"]);
    expect(writes).toEqual([]);
  });
});

for (const shutdown of ["EOF", "Ctrl-C", "interruption"] as const) {
  test(`interactive ${shutdown} closes readline before completion`, async () => {
    const stdin = Object.assign(new PassThrough(), { isTTY: true });
    const stdout = Object.assign(new PassThrough(), { isTTY: true });
    await Effect.runPromise(
      Effect.gen(function* () {
        const ready = yield* Deferred.make<undefined>();
        stdout.on("data", (chunk: Buffer) => {
          if (chunk.toString().includes("Select an option:")) {
            Deferred.doneUnsafe(ready, Exit.succeed(undefined));
          }
        });
        const prompt = yield* Effect.forkScoped(
          resolveInteractiveArgv({ stdin, stdout }),
        );
        yield* Deferred.await(ready);
        if (shutdown === "interruption") yield* Fiber.interrupt(prompt);
        else if (shutdown === "EOF") stdin.end();
        else stdin.write("\u0003");
        const exit = yield* Fiber.await(prompt);
        if (shutdown === "interruption")
          expect(Exit.hasInterrupts(exit)).toBe(true);
        else {
          expect(Exit.isSuccess(exit)).toBe(true);
          if (Exit.isSuccess(exit)) expect(exit.value).toBeUndefined();
        }
        expect(stdin.isPaused()).toBe(true);
        expect(stdin.listenerCount("keypress")).toBe(0);
        expect(stdin.listenerCount("end")).toBe(0);
      }).pipe(
        Effect.scoped,
        Effect.ensuring(
          Effect.sync(() => {
            stdin.destroy();
            stdout.destroy();
          }),
        ),
      ),
    );
  });
}
