import { Effect, Schema } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process";
import type { Presentation } from "../runtime/services.ts";
import type {
  InvalidProcessCommandError,
  ProcessExecutionError,
  ProcessExitError,
} from "../cli/process.ts";

export type GitHubError =
  | GitHubRequestError
  | GitHubResponseError
  | InvalidProcessCommandError
  | ProcessExecutionError
  | ProcessExitError;
export type GitHubRequirements =
  | ChildProcessSpawner.ChildProcessSpawner
  | Presentation;

export class GitHubResponseError extends Schema.TaggedError<GitHubResponseError>()(
  "GitHubResponseError",
  {
    cause: Schema.Unknown,
  },
) {
  override get message(): string {
    return this.cause instanceof Error
      ? this.cause.message
      : String(this.cause);
  }
}

export const decodeGitHubResponse = Effect.fnUntraced(function* <A>(
  decode: () => A,
) {
  return yield* Effect.try({
    try: decode,
    catch: (cause) => new GitHubResponseError({ cause }),
  });
});

export class GitHubRequestError extends Schema.TaggedError<GitHubRequestError>()(
  "GitHubRequestError",
  { message: Schema.String },
) {}
