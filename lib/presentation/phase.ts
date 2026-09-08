import { fromLegacyPromise } from "../runtime/application.ts";
import { runApplicationPromise } from "../runtime/application.ts";
import type { ApplicationExecution } from "../runtime/application.ts";
import { presenter, type AgentDisplayContext } from "./presenter.ts";

export interface PresentedPhaseCompletion {
  outcome?: string | undefined;
  artifact?: string | undefined;
  failed?: boolean | undefined;
}

export async function runPresentedPhase<T>(
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
  if (!application)
    return runApplicationPromise(
      fromLegacyPromise((application) =>
        runPresentedPhase(display, work, completion, options, application),
      ),
      application,
    );

  const titleOptions = { manageTitle: options.manageTitle };
  presenter(application).phaseStarted(display, titleOptions);
  try {
    const result = await work();
    presenter(application).phaseCompleted(display, {
      ...completion(result),
      ...titleOptions,
    });
    return result;
  } catch (error) {
    await options.onError?.(error);
    const failure = options.failure?.(error);
    presenter(application).phaseCompleted(display, {
      outcome:
        failure?.outcome ??
        (error instanceof Error ? error.message : String(error)),
      artifact: failure?.artifact,
      failed: true,
      ...titleOptions,
    });
    throw error;
  }
}
