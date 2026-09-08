import {
  fromLegacyPromise,
  runApplicationPromise,
  type ApplicationExecution,
} from "../runtime/application.ts";
import { runPresentedPhase, type PresentedPhaseCompletion } from "./phase.ts";
import type { AgentDisplayContext } from "./presenter.ts";

export function runPresentedPhasePromise<T>(
  display: AgentDisplayContext,
  work: () => Promise<T>,
  completion: (result: T) => PresentedPhaseCompletion,
  options: {
    manageTitle?: boolean | undefined;
    onError?: ((error: unknown) => void | Promise<void>) | undefined;
    failure?: ((error: unknown) => PresentedPhaseCompletion) | undefined;
  } = {},
  application?: ApplicationExecution,
): Promise<T> {
  return runApplicationPromise(
    runPresentedPhase(display, () => fromLegacyPromise(work), completion, {
      ...options,
      onError: (error) =>
        fromLegacyPromise(async () => {
          await options.onError?.(error);
        }),
    }),
    application,
  );
}
