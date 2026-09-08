import { Effect } from "effect";
import { AgentExecution } from "../runtime/services.ts";
import { AgentExecutionError } from "../pi/agent.ts";
import {
  fromLegacyPromise,
  type ApplicationServices,
  type ApplicationExecution,
} from "../runtime/application.ts";
import { type AgentRunRequest } from "../workflow/agent-runner.ts";
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
                  fromLegacyPromise((application) =>
                    runner(request, application),
                  ).pipe(
                    Effect.mapError(
                      (cause) =>
                        new AgentExecutionError({
                          operation: "Run agent",
                          cause,
                        }),
                    ),
                    Effect.provide(services),
                  ),
              }),
            ),
          ),
        );
export type AgentRunner = (
  request: AgentRunRequest,
  application?: ApplicationExecution,
) => Promise<string>;
