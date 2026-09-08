import * as native from "./git.ts";
import {
  runApplicationPromise,
  type ApplicationExecution,
} from "../runtime/application.ts";

export function assertCleanGitPromise(
  context: Parameters<typeof native.assertCleanGit>[0],
  application?: ApplicationExecution,
) {
  return runApplicationPromise(native.assertCleanGit(context), application);
}

export function assertCleanAutorunGitPromise(
  context: Parameters<typeof native.assertCleanAutorunGit>[0],
  application?: ApplicationExecution,
) {
  return runApplicationPromise(
    native.assertCleanAutorunGit(context),
    application,
  );
}

export function assertCleanGitTreePromise(
  context: Parameters<typeof native.assertCleanGitTree>[0],
  application?: ApplicationExecution,
) {
  return runApplicationPromise(native.assertCleanGitTree(context), application);
}

export function gitDirtyLinesPromise(
  cwd: Parameters<typeof native.gitDirtyLines>[0],
  application?: ApplicationExecution,
) {
  return runApplicationPromise(native.gitDirtyLines(cwd), application);
}

export function capturePreImplementationBaselinePromise(
  context: Parameters<typeof native.capturePreImplementationBaseline>[0],
  application?: ApplicationExecution,
) {
  return runApplicationPromise(
    native.capturePreImplementationBaseline(context),
    application,
  );
}

export function resetWorktreeToPreImplementationBaselinePromise(
  context: Parameters<
    typeof native.resetWorktreeToPreImplementationBaseline
  >[0],
  application?: ApplicationExecution,
) {
  return runApplicationPromise(
    native.resetWorktreeToPreImplementationBaseline(context),
    application,
  );
}
