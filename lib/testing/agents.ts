import { Context, Effect, Scope } from "effect";
import { AgentExecution } from "../runtime/services.ts";
import { AgentExecutionError } from "../pi/agent.ts";
import type { ApplicationServices } from "../runtime/application.ts";
import type { AgentRunRequest } from "../workflow/agent-runner.ts";

export type AgentRunner = (
  request: AgentRunRequest,
) => Effect.Effect<string, unknown, ApplicationServices | Scope.Scope>;
export const provideTestAgent =
  (runner?: AgentRunner) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    runner === undefined
      ? effect
      : effect.pipe(
          Effect.provideServiceEffect(
            AgentExecution,
            Effect.map(Effect.context<ApplicationServices>(), (services) =>
              AgentExecution.of({
                run: (request) =>
                  runner(request).pipe(
                    Effect.mapError(
                      (cause) =>
                        new AgentExecutionError({
                          operation: "Run agent",
                          cause,
                        }),
                    ),
                    Effect.provide(Context.omit(Scope.Scope)(services)),
                    Effect.scoped,
                  ),
              }),
            ),
          ),
        );
