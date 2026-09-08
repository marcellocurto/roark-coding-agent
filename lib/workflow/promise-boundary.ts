import { Effect } from "effect";
import { AgentExecution } from "../runtime/services.ts";
import { AgentExecutionError } from "../pi/agent.ts";
import {
  fromLegacyPromise,
  type ApplicationServices,
} from "../runtime/application.ts";
import { runAgentPromise, type AgentRunner } from "./agent-runner.ts";

export const providePromiseAgent =
  (runner: AgentRunner = runAgentPromise) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    runner === runAgentPromise
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
