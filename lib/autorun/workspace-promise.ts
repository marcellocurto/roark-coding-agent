import * as native from "./workspace.ts";
import { Effect, Exit, Scope } from "effect";
import {
  runApplicationPromise,
  type ApplicationExecution,
} from "../runtime/application.ts";
import { runProcessPromise } from "../cli/process-promise.ts";
export type ProcessRunner = typeof runProcessPromise;
type Input<T> = Omit<T, "runner"> & { runner?: ProcessRunner | undefined };
function adaptRunner(
  runner: ProcessRunner | undefined,
  application?: ApplicationExecution,
): native.ProcessRunner | undefined {
  if (!runner || runner === runProcessPromise) return undefined;
  return (args, options) =>
    Effect.tryPromise({
      try: () => runner([...args], options, application),
      catch: (cause) => new native.WorkspaceCommandError({ cause }),
    });
}

export function assertWorkspacePathSafePromise(
  input: Parameters<typeof native.assertWorkspacePathSafe>[0],
  application?: ApplicationExecution,
) {
  return runApplicationPromise(
    native.assertWorkspacePathSafe(input),
    application,
  );
}

export function resolveCloneRemotePromise(
  input: Input<Parameters<typeof native.resolveCloneRemote>[0]>,
  application?: ApplicationExecution,
) {
  return runApplicationPromise(
    native.resolveCloneRemote({
      ...input,
      runner: adaptRunner(input.runner, application),
    }),
    application,
  );
}

export function resolvePrReviewCloneRemotePromise(
  input: Input<Parameters<typeof native.resolvePrReviewCloneRemote>[0]>,
  application?: ApplicationExecution,
) {
  return runApplicationPromise(
    native.resolvePrReviewCloneRemote({
      ...input,
      runner: adaptRunner(input.runner, application),
    }),
    application,
  );
}

export function prepareCloneWorkspacePromise(
  input: Input<Parameters<typeof native.prepareCloneWorkspace>[0]>,
  application?: ApplicationExecution,
) {
  return runApplicationPromise(
    native.prepareCloneWorkspace({
      ...input,
      runner: adaptRunner(input.runner, application),
    }),
    application,
  );
}

export async function preparePrRevisionWorkspacePromise(
  input: Input<Parameters<typeof native.preparePrRevisionWorkspace>[0]>,
  application?: ApplicationExecution,
) {
  // This Promise API transfers the lock to its caller's workflow finalizer.
  // Closing the intervening Promise bridge must not release that lock early.
  const scope = await Effect.runPromise(Scope.make());
  try {
    const prepared = await runApplicationPromise(
      native
        .preparePrRevisionWorkspace({
          ...input,
          runner: adaptRunner(input.runner, application),
        })
        .pipe(Effect.provideService(Scope.Scope, scope)),
      application,
    );
    return {
      ...prepared,
      releaseLock: () => Effect.runPromise(Scope.close(scope, Exit.void)),
    };
  } catch (error) {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    throw error;
  }
}

export async function preparePrReviewWorkspacePromise(
  input: Input<Parameters<typeof native.preparePrReviewWorkspace>[0]>,
  application?: ApplicationExecution,
) {
  // This Promise API transfers the lock to its caller's workflow finalizer.
  // Closing the intervening Promise bridge must not release that lock early.
  const scope = await Effect.runPromise(Scope.make());
  try {
    const prepared = await runApplicationPromise(
      native
        .preparePrReviewWorkspace({
          ...input,
          runner: adaptRunner(input.runner, application),
        })
        .pipe(Effect.provideService(Scope.Scope, scope)),
      application,
    );
    return {
      ...prepared,
      releaseLock: () => Effect.runPromise(Scope.close(scope, Exit.void)),
    };
  } catch (error) {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    throw error;
  }
}

export function assertPinnedPrReviewWorkspacePromise(
  input: Input<Parameters<typeof native.assertPinnedPrReviewWorkspace>[0]>,
  application?: ApplicationExecution,
) {
  return runApplicationPromise(
    native.assertPinnedPrReviewWorkspace({
      ...input,
      runner: adaptRunner(input.runner, application),
    }),
    application,
  );
}

export function refreshCopyToWorktreePromise(
  input: Input<Parameters<typeof native.refreshCopyToWorktree>[0]>,
  application?: ApplicationExecution,
) {
  return runApplicationPromise(
    native.refreshCopyToWorktree({
      ...input,
      runner: adaptRunner(input.runner, application),
    }),
    application,
  );
}

export function listManagedWorkspacesPromise(
  options: Parameters<typeof native.listManagedWorkspaces>[0],
  application?: ApplicationExecution,
) {
  return runApplicationPromise(
    native.listManagedWorkspaces(options),
    application,
  );
}

export function listWorkspacesPromise(
  options: Parameters<typeof native.listWorkspaces>[0],
  application?: ApplicationExecution,
) {
  return runApplicationPromise(native.listWorkspaces(options), application);
}

export function runWorkspaceCommandPromise(
  options: Parameters<typeof native.runWorkspaceCommand>[0],
  application?: ApplicationExecution,
) {
  return runApplicationPromise(
    native.runWorkspaceCommand(options),
    application,
  );
}

export function runRemoveCommandPromise(
  options: Parameters<typeof native.runRemoveCommand>[0],
  application?: ApplicationExecution,
) {
  return runApplicationPromise(native.runRemoveCommand(options), application);
}

export function removeWorkspacePromise(
  input: Parameters<typeof native.removeWorkspace>[0],
  application?: ApplicationExecution,
) {
  return runApplicationPromise(native.removeWorkspace(input), application);
}

export function runLifecycleHookPromise(
  name: Parameters<typeof native.runLifecycleHook>[0],
  hooks: Parameters<typeof native.runLifecycleHook>[1],
  cwd: string,
  runner?: ProcessRunner,
  application?: ApplicationExecution,
) {
  return runApplicationPromise(
    native.runLifecycleHook(name, hooks, cwd, adaptRunner(runner, application)),
    application,
  );
}

export type PreparedPrReviewWorkspace = Omit<
  native.PreparedPrReviewWorkspace,
  "releaseLock"
> & { releaseLock: () => Promise<void> };
export type PreparedPrRevisionWorkspace = Omit<
  native.PreparedPrRevisionWorkspace,
  "releaseLock"
> & { releaseLock: () => Promise<void> };
