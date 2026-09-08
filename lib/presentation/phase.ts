import { Cause, Effect, Exit } from "effect";
import { Presentation } from "../runtime/services.ts";
import type { AgentDisplayContext } from "./presenter.ts";

export interface PresentedPhaseCompletion {
  outcome?: string | undefined;
  artifact?: string | undefined;
  failed?: boolean | undefined;
}

export const runPresentedPhase = Effect.fn("runPresentedPhase")(function* <
  T,
  E,
  R,
  E2 = never,
  R2 = never,
>(
  display: AgentDisplayContext,
  work: () => Effect.Effect<T, E, R>,
  completion: (result: T) => PresentedPhaseCompletion,
  options: {
    manageTitle?: boolean | undefined;
    onError?:
      | ((error: unknown) => Effect.Effect<void, E2, R2> | void)
      | undefined;
    failure?: ((error: unknown) => PresentedPhaseCompletion) | undefined;
  } = {},
) {
  const presentation = yield* Presentation;
  const titleOptions = { manageTitle: options.manageTitle };
  presentation.phaseStarted(display, titleOptions);
  return yield* Effect.suspend(work).pipe(
    Effect.onExit((exit) =>
      Effect.gen(function* () {
        if (Exit.isSuccess(exit)) {
          presentation.phaseCompleted(display, {
            ...completion(exit.value),
            ...titleOptions,
          });
          return;
        }
        const error = Cause.squash(exit.cause);
        yield* Effect.suspend(() => options.onError?.(error) ?? Effect.void);
        const failure = options.failure?.(error);
        presentation.phaseCompleted(display, {
          outcome:
            failure?.outcome ??
            (Cause.hasInterruptsOnly(exit.cause)
              ? "Interrupted."
              : Cause.prettyErrors(exit.cause)
                  .map((error) => error.message)
                  .join("\n")),
          artifact: failure?.artifact,
          failed: true,
          ...titleOptions,
        });
      }),
    ),
  );
});
