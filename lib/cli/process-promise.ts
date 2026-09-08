import {
  runApplicationPromise,
  type ApplicationExecution,
} from "../runtime/application.ts";
import {
  runProcess,
  runProcessOrThrow,
  type ProcessOptions,
  type ProcessResult,
} from "./process.ts";

// Remove these adapters as the remaining git/gh/workspace callers migrate.
export function runProcessPromise(
  args: string[],
  options: ProcessOptions = {},
  application?: ApplicationExecution,
): Promise<ProcessResult> {
  return runApplicationPromise(runProcess(args, options), application);
}

export function runProcessOrThrowPromise(
  args: string[],
  options: ProcessOptions & { label?: string } = {},
  application?: ApplicationExecution,
): Promise<string> {
  return runApplicationPromise(runProcessOrThrow(args, options), application);
}
