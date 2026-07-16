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
): Promise<T> {
  const titleOptions = { manageTitle: options.manageTitle };
  presenter().phaseStarted(display, titleOptions);
  try {
    const result = await work();
    presenter().phaseCompleted(display, { ...completion(result), ...titleOptions });
    return result;
  } catch (error) {
    await options.onError?.(error);
    const failure = options.failure?.(error);
    presenter().phaseCompleted(display, {
      outcome: failure?.outcome ?? (error instanceof Error ? error.message : String(error)),
      artifact: failure?.artifact,
      failed: true,
      ...titleOptions,
    });
    throw error;
  }
}
