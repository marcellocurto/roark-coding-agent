import { Effect } from "effect";
import {
  createIssuesFromCurationPlan,
  createIssuesPhase,
  type CreateIssuesOptions,
} from "./create-issues.ts";
import { IssuePublishing } from "../issue-publishing/service.ts";
import type {
  IssuePublishRequest,
  IssuePublishResult,
} from "../issue-publishing/github.ts";
import { GitHubResponseError } from "../github/errors.ts";
import {
  fromLegacyPromise,
  runApplicationPromise,
  type ApplicationExecution,
  type ApplicationServices,
} from "../runtime/application.ts";
import { runAgentPromise, type AgentRunner } from "../workflow/agent-runner.ts";
import { providePromiseAgent } from "../workflow/promise-boundary.ts";

export type IssuePublisher = (
  request: IssuePublishRequest,
  application?: ApplicationExecution,
) => Promise<IssuePublishResult>;
export interface PromiseCreateIssuesOptions extends CreateIssuesOptions {
  agentRunner?: AgentRunner | undefined;
  labelEnsurer?:
    | false
    | ((
        options: { cwd: string; repo?: string | undefined },
        application?: ApplicationExecution,
      ) => Promise<unknown>)
    | undefined;
  issuePublisher?: IssuePublisher | undefined;
}
export function createIssuesPhasePromise(
  context: Parameters<typeof createIssuesPhase>[0],
  runner: AgentRunner = runAgentPromise,
  application?: ApplicationExecution,
) {
  return runApplicationPromise(
    createIssuesPhase(context).pipe(providePromiseAgent(runner)),
    application,
  );
}
export function createIssuesFromCurationPlanPromise(
  options: PromiseCreateIssuesOptions,
  application?: ApplicationExecution,
) {
  return runApplicationPromise(
    Effect.gen(function* () {
      const live = yield* IssuePublishing;
      const services = yield* Effect.context<ApplicationServices>();
      const labels = options.labelEnsurer;
      const publish = options.issuePublisher;
      return yield* createIssuesFromCurationPlan(options).pipe(
        Effect.provideService(IssuePublishing, {
          publish: publish
            ? (request) =>
                fromLegacyPromise((inner) => publish(request, inner)).pipe(
                  Effect.mapError(
                    (cause) => new GitHubResponseError({ cause }),
                  ),
                  Effect.provide(services),
                )
            : (request) => live.publish(request),
          ensureLabels:
            labels === false
              ? () => Effect.void
              : labels
                ? (request) =>
                    fromLegacyPromise((inner) => labels(request, inner)).pipe(
                      Effect.asVoid,
                      Effect.mapError(
                        (cause) => new GitHubResponseError({ cause }),
                      ),
                      Effect.provide(services),
                    )
                : (request) => live.ensureLabels(request),
        }),
        providePromiseAgent(options.agentRunner),
      );
    }),
    application,
  );
}
