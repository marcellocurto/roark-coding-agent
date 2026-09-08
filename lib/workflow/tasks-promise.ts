import { Effect } from "effect";
import { providePromiseAgent } from "./promise-boundary.ts";
import { runAgentPromise, type AgentRunner } from "./agent-runner.ts";
import * as native from "./tasks.ts";
import {
  runApplicationPromise,
  type ApplicationExecution,
} from "../runtime/application.ts";

export function runReviewTaskPromise(
  context: Parameters<typeof native.runReviewTask>[0],
  runner: AgentRunner = runAgentPromise,
  task: Parameters<typeof native.runReviewTask>[1],
  retryOptions: PromiseTaskRetryOptions = {},
  application?: ApplicationExecution,
) {
  return runApplicationPromise(
    native
      .runReviewTask(context, task, toNativeRetry(retryOptions))
      .pipe(providePromiseAgent(runner)),
    application,
  );
}

export function runTriageTaskPromise(
  context: Parameters<typeof native.runTriageTask>[0],
  runner: AgentRunner = runAgentPromise,
  retryOptions: PromiseTaskRetryOptions = {},
  application?: ApplicationExecution,
) {
  return runApplicationPromise(
    native
      .runTriageTask(context, toNativeRetry(retryOptions))
      .pipe(providePromiseAgent(runner)),
    application,
  );
}

export function runPlanDraftTaskPromise(
  context: Parameters<typeof native.runPlanDraftTask>[0],
  runner: AgentRunner = runAgentPromise,
  retryOptions: PromiseTaskRetryOptions = {},
  application?: ApplicationExecution,
) {
  return runApplicationPromise(
    native
      .runPlanDraftTask(context, toNativeRetry(retryOptions))
      .pipe(providePromiseAgent(runner)),
    application,
  );
}

export function runPlanTaskPromise(
  context: Parameters<typeof native.runPlanTask>[0],
  runner: AgentRunner = runAgentPromise,
  retryOptions: PromiseTaskRetryOptions = {},
  application?: ApplicationExecution,
) {
  return runApplicationPromise(
    native
      .runPlanTask(context, toNativeRetry(retryOptions))
      .pipe(providePromiseAgent(runner)),
    application,
  );
}

export function runChangeReportTaskPromise(
  context: Parameters<typeof native.runChangeReportTask>[0],
  runner: AgentRunner = runAgentPromise,
  task: Parameters<typeof native.runChangeReportTask>[1],
  retryOptions: PromiseTaskRetryOptions = {},
  application?: ApplicationExecution,
) {
  return runApplicationPromise(
    native
      .runChangeReportTask(context, task, toNativeRetry(retryOptions))
      .pipe(providePromiseAgent(runner)),
    application,
  );
}

interface PromiseTaskRetryOptions {
  delaysMs?: readonly number[] | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
}
function toNativeRetry(options: PromiseTaskRetryOptions) {
  const sleep = options.sleep;
  return {
    delaysMs: options.delaysMs,
    sleep: sleep ? (ms: number) => Effect.promise(() => sleep(ms)) : undefined,
  };
}
