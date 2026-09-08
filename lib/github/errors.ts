import { Schema } from "effect";
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
    cause: Schema.instanceOf(Schema.SchemaError),
  },
) {
  override get message(): string {
    return this.cause.message;
  }
}

export class GitHubRequestError extends Schema.TaggedError<GitHubRequestError>()(
  "GitHubRequestError",
  { message: Schema.String },
) {}
