import { Deferred, Effect, Exit, Schema } from "effect";
import { createInterface } from "node:readline/promises";
import path from "node:path";
export type InteractiveArgv = string[] | undefined;
export interface InteractivePrompt {
  question: (prompt: string) => Effect.Effect<string, InteractivePromptError>;
  write?(text: string): void;
}
export interface WorkspaceRemovalSelection {
  selectedIndexes: number[];
}
type TtyInput = NodeJS.ReadableStream & {
  isTTY?: boolean;
};
type WritableOutput = NodeJS.WritableStream;
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
export const resolveInteractiveArgv = Effect.fn("resolveInteractiveArgv")(
  function* (
    options: {
      stdin?: TtyInput | undefined;
      stdout?: WritableOutput | undefined;
    } = {},
  ) {
    const stdin = options.stdin ?? process.stdin;
    const stdout = options.stdout ?? process.stdout;
    if (stdin.isTTY !== true) return ["--help"];
    return yield* runReadlinePrompt(stdin, stdout, promptForInteractiveArgv);
  },
);
export const promptForInteractiveArgv = Effect.fn("promptForInteractiveArgv")(
  function* (prompt: InteractivePrompt) {
    for (;;) {
      prompt.write?.(menu);
      const choice = (yield* prompt.question("Select an option: ")).trim();
      if (choice === "1") {
        if (yield* confirm(prompt, "Work on the next ready issue?"))
          return ["auto"];
        prompt.write?.("Cancelled.\n");
        return undefined;
      }
      if (choice === "2") {
        const issue = yield* promptRequiredIssue(prompt);
        if (yield* confirm(prompt, `Work on issue ${issue}?`))
          return ["auto", issue];
        prompt.write?.("Cancelled.\n");
        return undefined;
      }
      if (choice === "3")
        return ["continue", yield* promptRequiredIssue(prompt)];
      if (choice === "4") return ["do", yield* promptRequiredIssue(prompt)];
      if (choice === "5")
        return ["review-pr", yield* promptRequiredPrNumber(prompt)];
      if (choice === "6")
        return ["revise-pr", yield* promptRequiredPrNumber(prompt)];
      if (choice === "7") return ["status", yield* promptRequiredIssue(prompt)];
      if (choice === "8") {
        return ["remove"];
      }
      if (choice === "9") return ["--help"];
      prompt.write?.("Invalid choice. Please choose 1-9.\n");
    }
  },
);
export const resolveInteractiveWorkspaceRemoval = Effect.fn(
  "resolveInteractiveWorkspaceRemoval",
)(function* (options: {
  workspacePaths: string[];
  stdin?: TtyInput | undefined;
  stdout?: WritableOutput | undefined;
}) {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  if (stdin.isTTY !== true) {
    return yield* Effect.fail(
      new InteractivePromptError({
        message:
          "Interactive workspace selection requires a TTY. Pass issue numbers or use --pr to select workspaces explicitly.",
      }),
    );
  }
  return yield* runReadlinePrompt(stdin, stdout, (prompt) =>
    promptForWorkspaceRemoval({
      workspacePaths: options.workspacePaths,
      prompt,
    }),
  );
});
export const promptForWorkspaceRemoval = Effect.fn("promptForWorkspaceRemoval")(
  function* (options: { workspacePaths: string[]; prompt: InteractivePrompt }) {
    const { prompt, workspacePaths } = options;
    prompt.write?.("Managed workspaces:\n");
    for (const [index, workspacePath] of workspacePaths.entries()) {
      prompt.write?.(
        `  ${index + 1}. ${path.basename(workspacePath)}  ${workspacePath}\n`,
      );
    }
    for (;;) {
      const answer = (yield* prompt.question(
        "Select workspaces to remove (for example 1,3-5 or all; Enter to cancel): ",
      ))
        .trim()
        .toLowerCase();
      if (!answer) {
        prompt.write?.("Cancelled.\n");
        return undefined;
      }
      const indexes = parseWorkspaceSelection(answer, workspacePaths.length);
      if (!indexes) {
        prompt.write?.(
          `Invalid selection. Choose numbers from 1 to ${workspacePaths.length}, ranges, or all.\n`,
        );
        continue;
      }
      if (
        !(yield* confirm(
          prompt,
          `Remove ${indexes.length} selected workspace${indexes.length === 1 ? "" : "s"}?`,
        ))
      ) {
        prompt.write?.("Cancelled.\n");
        return undefined;
      }
      return { selectedIndexes: indexes.map((index) => index - 1) };
    }
  },
);
const runReadlinePrompt = Effect.fnUntraced(function* <T>(
  stdin: TtyInput,
  stdout: WritableOutput,
  run: (prompt: InteractivePrompt) => Effect.Effect<T, InteractivePromptError>,
) {
  return yield* Effect.acquireUseRelease(
    Effect.gen(function* () {
      const closed = yield* Deferred.make<undefined>();
      const rl = yield* Effect.try({
        try: () => createInterface({ input: stdin, output: stdout }),
        catch: promptError,
      });
      const onClose = () => {
        Deferred.doneUnsafe(closed, Exit.succeed(undefined));
      };
      rl.on("SIGINT", onClose);
      rl.on("close", onClose);
      return { rl, closed, onClose };
    }),
    ({ rl, closed }) =>
      run({
        question: (question) =>
          Effect.tryPromise({
            try: (signal) => rl.question(question, { signal }),
            catch: promptError,
          }),
        write: (text) => {
          stdout.write(text);
        },
      }).pipe(
        Effect.raceFirst(
          Deferred.await(closed).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                stdout.write("\n");
              }),
            ),
            Effect.as(undefined),
          ),
        ),
      ),
    ({ rl, onClose }) =>
      Effect.sync(() => {
        rl.off("SIGINT", onClose);
        rl.off("close", onClose);
        rl.close();
      }),
  );
});
export class InteractivePromptError extends Schema.TaggedError<InteractivePromptError>()(
  "InteractivePromptError",
  { message: Schema.String, cause: Schema.optional(Schema.Unknown) },
) {}
function promptError(cause: unknown): InteractivePromptError {
  return new InteractivePromptError({
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
  });
}

function parseWorkspaceSelection(
  input: string,
  maximum: number,
): number[] | undefined {
  if (input === "all")
    return Array.from({ length: maximum }, (_, index) => index + 1);
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
  return selected.size > 0
    ? [...selected].toSorted((left, right) => left - right)
    : undefined;
}
const promptRequiredIssue = Effect.fn("promptRequiredIssue")(function* (
  prompt: InteractivePrompt,
) {
  for (;;) {
    const issue = (yield* prompt.question("Issue: ")).trim();
    if (issue) return issue;
    prompt.write?.("Issue is required.\n");
  }
});
const promptRequiredPrNumber = Effect.fn("promptRequiredPrNumber")(function* (
  prompt: InteractivePrompt,
) {
  for (;;) {
    const prNumber = (yield* prompt.question("PR number: ")).trim();
    if (prNumber) return prNumber;
    prompt.write?.("PR number is required.\n");
  }
});
const confirm = Effect.fn("confirm")(function* (
  prompt: InteractivePrompt,
  message: string,
) {
  const answer = (yield* prompt.question(`${message} [y/N] `))
    .trim()
    .toLowerCase();
  return answer === "y" || answer === "yes";
});
