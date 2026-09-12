import { Effect, Schedule } from "effect";
import { AgentExecution, Presentation } from "../runtime/services.ts";
import { effectiveModelForStage } from "./model-routing.ts";
import type {
  WorkflowThinkingConfig,
  WorkflowThinkingStage,
} from "./thinking.ts";
import { isTransientAgentConnectionError } from "./transient-agent-errors.ts";
import { type ThinkingLevel } from "../cli/args.ts";
import { type RunObserver } from "../observability/observer.ts";
import { type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type AgentDisplayContext } from "../presentation/presenter.ts";
export interface AgentRunRequest {
  cwd: string;
  model?: string | undefined;
  thinkingLevel: ThinkingLevel;
  systemPrompt: string;
  prompt: string;
  fileEditingToolsEnabled: boolean;
  skillPaths?: string[] | undefined;
  observer?: RunObserver | undefined;
  customTools?: ToolDefinition[] | undefined;
  display: AgentDisplayContext;
}

export function createAgentRunRequest(
  config: {
    model?: string | undefined;
    thinkingConfig: WorkflowThinkingConfig;
  },
  stage: WorkflowThinkingStage,
  request: Omit<AgentRunRequest, "model" | "thinkingLevel">,
): AgentRunRequest {
  return {
    ...request,
    model: effectiveModelForStage(config.model, stage),
    thinkingLevel: config.thinkingConfig[stage],
  };
}

export interface AgentRetryOptions {
  delaysMs?: readonly number[] | undefined;
  sleep?: ((ms: number) => Effect.Effect<void>) | undefined;
  completionInstruction?: string | undefined;
}
const transientAgentRetryDelaysMs = [0, 60000, 180000] as const;

export const runAgentRequestWithTransientRetries = Effect.fn(
  "runAgentRequestWithTransientRetries",
)(function* (request: AgentRunRequest, options: AgentRetryOptions) {
  const agent = yield* AgentExecution;
  const presentation = yield* Presentation;
  const delays = options.delaysMs ?? transientAgentRetryDelaysMs;
  let attemptIndex = 0;
  const schedule = Schedule.recurs(delays.length).pipe(
    Schedule.while(({ input }) =>
      Effect.succeed(isTransientAgentConnectionError(input)),
    ),
    Schedule.tap(({ attempt, input }) =>
      Effect.sync(() => {
        presentation.warning(
          `WARNING ${request.display.phaseLabel}: transient agent connection error: ${input instanceof Error ? input.message : String(input)}; retry ${attempt}/${delays.length} ${formatRetryDelay(delays[attempt - 1] ?? 0)}.`,
        );
      }),
    ),
    Schedule.addDelay(({ attempt }) => {
      const delay = delays[attempt - 1] ?? 0;
      return options.sleep && delay > 0
        ? options.sleep(delay).pipe(Effect.as(0))
        : Effect.succeed(delay);
    }),
  );
  return yield* Effect.suspend(() => {
    const next =
      attemptIndex++ === 0
        ? request
        : withTransientConnectionRetryPrompt(
            request,
            options.completionInstruction,
          );
    return agent.run(next);
  }).pipe(Effect.retry(schedule));
});
function withTransientConnectionRetryPrompt(
  request: AgentRunRequest,
  completionInstruction?: string,
): AgentRunRequest {
  if (!request.fileEditingToolsEnabled) return request;
  return {
    ...request,
    prompt: `${request.prompt}\n\n<transient_connection_retry>\nA previous invocation of this same phase failed because the provider/harness connection ended.\nIt may have already modified files in the working tree.\nInspect the current diff before editing, preserve useful completed work, avoid duplicate changes, ${completionInstruction ?? "finish the phase and complete its required output contract"}.\n</transient_connection_retry>`,
  };
}
function formatRetryDelay(delayMs: number): string {
  if (delayMs <= 0) return "immediately";
  if (delayMs % 60000 === 0) {
    const minutes = delayMs / 60000;
    return `in ${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  if (delayMs % 1000 === 0) {
    const seconds = delayMs / 1000;
    return `in ${seconds} second${seconds === 1 ? "" : "s"}`;
  }
  return `in ${delayMs}ms`;
}
