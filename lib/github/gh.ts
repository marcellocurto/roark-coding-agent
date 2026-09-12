import { Effect } from "effect";
import { runProcessOrThrow } from "../cli/process.ts";

export function buildCurrentRepoArgv(): string[] {
  return [
    "gh",
    "repo",
    "view",
    "--json",
    "nameWithOwner",
    "--jq",
    ".nameWithOwner",
  ];
}
export function buildCurrentUserArgv(): string[] {
  return ["gh", "api", "user", "--jq", ".login"];
}

export const getCurrentGitHubRepository = Effect.fn(
  "GitHub.getCurrentGitHubRepository",
)(function* (options: { cwd: string }) {
  return (yield* runProcessOrThrow(buildCurrentRepoArgv(), {
    cwd: options.cwd,
    label: "gh repo view",
  })).trim();
});
export const getCurrentGitHubLogin = Effect.fn("GitHub.getCurrentGitHubLogin")(
  function* (options: { cwd: string; label?: string }) {
    return (yield* runProcessOrThrow(buildCurrentUserArgv(), {
      cwd: options.cwd,
      label: options.label ?? "gh api user",
    })).trim();
  },
);
