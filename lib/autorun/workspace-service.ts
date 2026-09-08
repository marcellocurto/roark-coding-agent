import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import { Presentation } from "../runtime/services.ts";
import { Context, Effect, FileSystem, Layer } from "effect";
import * as workspace from "./workspace.ts";
const operations = {
  prepareClone: workspace.prepareCloneWorkspace,
  preparePrReview: workspace.preparePrReviewWorkspace,
  preparePrRevision: workspace.preparePrRevisionWorkspace,
  refreshCopy: workspace.refreshCopyToWorktree,
  assertPinnedReview: workspace.assertPinnedPrReviewWorkspace,
};
type WorkspaceOperations = {
  [K in keyof typeof operations]: (
    input: Omit<Parameters<(typeof operations)[K]>[0], "runner">,
  ) => Effect.Effect<
    Effect.Success<ReturnType<(typeof operations)[K]>>,
    Effect.Error<ReturnType<(typeof operations)[K]>>,
    Exclude<
      Effect.Services<ReturnType<(typeof operations)[K]>>,
      workspace.WorkspaceRequirements
    >
  >;
};
export class Workspace extends Context.Service<
  Workspace,
  WorkspaceOperations & {
    runHook: (
      name: Parameters<typeof workspace.runLifecycleHook>[0],
      hooks: Parameters<typeof workspace.runLifecycleHook>[1],
      cwd: string,
    ) => Effect.Effect<
      void,
      Effect.Error<ReturnType<typeof workspace.runLifecycleHook>>
    >;
  }
>()("roark/autorun/Workspace") {}
export const workspaceLayer = Layer.effect(
  Workspace,
  Effect.gen(function* () {
    const services = Context.make(
      FileSystem.FileSystem,
      yield* FileSystem.FileSystem,
    ).pipe(
      Context.add(ChildProcessSpawner, yield* ChildProcessSpawner),
      Context.add(Presentation, yield* Presentation),
    );
    return Workspace.of({
      preparePrRevision: (input) =>
        workspace
          .preparePrRevisionWorkspace(input)
          .pipe(Effect.provide(services)),
      prepareClone: (input) =>
        workspace.prepareCloneWorkspace(input).pipe(Effect.provide(services)),
      preparePrReview: (input) =>
        workspace
          .preparePrReviewWorkspace(input)
          .pipe(Effect.provide(services)),
      refreshCopy: (input) =>
        workspace.refreshCopyToWorktree(input).pipe(Effect.provide(services)),
      assertPinnedReview: (input) =>
        workspace
          .assertPinnedPrReviewWorkspace(input)
          .pipe(Effect.provide(services)),
      runHook: (...args) =>
        workspace.runLifecycleHook(...args).pipe(Effect.provide(services)),
    });
  }),
);
