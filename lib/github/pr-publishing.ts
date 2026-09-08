import { Effect } from "effect";
import { runProcessOrThrow } from "../cli/process.ts";

export function buildPrCreateArgv(input: {
  repo?: string | undefined;
  baseBranch: string;
  branchName: string;
  title: string;
}): string[] {
  return [
    "gh",
    "pr",
    "create",
    "--base",
    input.baseBranch,
    "--head",
    input.branchName,
    "--title",
    input.title,
    "--body-file",
    "-",
    ...(input.repo ? ["--repo", input.repo] : []),
  ];
}

export const createPullRequest = Effect.fn("GitHub.createPullRequest")(
  function* (input: {
    cwd: string;
    repo?: string | undefined;
    baseBranch: string;
    branchName: string;
    title: string;
    body: string;
  }) {
    return yield* runProcessOrThrow(buildPrCreateArgv(input), {
      cwd: input.cwd,
      label: "gh pr create",
      input: input.body,
    });
  },
);

export const updatePullRequest = Effect.fn("GitHub.updatePullRequest")(
  function* (input: {
    cwd: string;
    repo?: string | undefined;
    pr: string;
    title: string;
    body: string;
  }) {
    yield* runProcessOrThrow(
      [
        "gh",
        "pr",
        "edit",
        input.pr,
        "--title",
        input.title,
        "--body-file",
        "-",
        ...(input.repo ? ["--repo", input.repo] : []),
      ],
      { cwd: input.cwd, label: "gh pr edit", input: input.body },
    );
  },
);
