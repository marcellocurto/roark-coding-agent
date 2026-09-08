import { providePromiseAgent } from "./promise-boundary.ts";
import { runAgentPromise, type AgentRunner } from "./agent-runner.ts";
import * as native from "./phases.ts";
import {
  runApplicationPromise,
  type ApplicationExecution,
} from "../runtime/application.ts";

export function fetchIssuePhasePromise(
  context: Parameters<typeof native.fetchIssuePhase>[0],
  suppliedSnapshot?: Parameters<typeof native.fetchIssuePhase>[1],
  application?: ApplicationExecution,
) {
  return runApplicationPromise(
    native.fetchIssuePhase(context, suppliedSnapshot),
    application,
  );
}

export function triagePhasePromise(
  context: Parameters<typeof native.triagePhase>[0],
  runner: AgentRunner = runAgentPromise,
  application?: ApplicationExecution,
) {
  return runApplicationPromise(
    native.triagePhase(context).pipe(providePromiseAgent(runner)),
    application,
  );
}

export function planDraftPhasePromise(
  context: Parameters<typeof native.planDraftPhase>[0],
  runner: AgentRunner = runAgentPromise,
  application?: ApplicationExecution,
) {
  return runApplicationPromise(
    native.planDraftPhase(context).pipe(providePromiseAgent(runner)),
    application,
  );
}

export function planPhasePromise(
  context: Parameters<typeof native.planPhase>[0],
  runner: AgentRunner = runAgentPromise,
  application?: ApplicationExecution,
) {
  return runApplicationPromise(
    native.planPhase(context).pipe(providePromiseAgent(runner)),
    application,
  );
}

export function captureBaselinePhasePromise(
  context: Parameters<typeof native.captureBaselinePhase>[0],
  application?: ApplicationExecution,
) {
  return runApplicationPromise(
    native.captureBaselinePhase(context),
    application,
  );
}

export function implementationPhasePromise(
  context: Parameters<typeof native.implementationPhase>[0],
  runner: AgentRunner = runAgentPromise,
  restartPass: Parameters<typeof native.implementationPhase>[1] = 0,
  application?: ApplicationExecution,
) {
  return runApplicationPromise(
    native
      .implementationPhase(context, restartPass)
      .pipe(providePromiseAgent(runner)),
    application,
  );
}

export function codeRefinementPhasePromise(
  context: Parameters<typeof native.codeRefinementPhase>[0],
  pass?: Parameters<typeof native.codeRefinementPhase>[1],
  runner: AgentRunner = runAgentPromise,
  application?: ApplicationExecution,
) {
  return runApplicationPromise(
    native.codeRefinementPhase(context, pass).pipe(providePromiseAgent(runner)),
    application,
  );
}

export function reviewPhasePromise(
  context: Parameters<typeof native.reviewPhase>[0],
  pass?: Parameters<typeof native.reviewPhase>[1],
  runner: AgentRunner = runAgentPromise,
  application?: ApplicationExecution,
) {
  return runApplicationPromise(
    native.reviewPhase(context, pass).pipe(providePromiseAgent(runner)),
    application,
  );
}

export function fixPhasePromise(
  context: Parameters<typeof native.fixPhase>[0],
  pass?: Parameters<typeof native.fixPhase>[1],
  runner: AgentRunner = runAgentPromise,
  application?: ApplicationExecution,
) {
  return runApplicationPromise(
    native.fixPhase(context, pass).pipe(providePromiseAgent(runner)),
    application,
  );
}

export function resetBaselinePhasePromise(
  context: Parameters<typeof native.resetBaselinePhase>[0],
  pass: Parameters<typeof native.resetBaselinePhase>[1],
  application?: ApplicationExecution,
) {
  return runApplicationPromise(
    native.resetBaselinePhase(context, pass),
    application,
  );
}

export function readinessPhasePromise(
  context: Parameters<typeof native.readinessPhase>[0],
  application?: ApplicationExecution,
) {
  return runApplicationPromise(native.readinessPhase(context), application);
}

export function runFullWorkflowPromise(
  context: Parameters<typeof native.runFullWorkflow>[0],
  runner: AgentRunner = runAgentPromise,
  options: Parameters<typeof native.runFullWorkflow>[1] = {},
  application?: ApplicationExecution,
) {
  return runApplicationPromise(
    native.runFullWorkflow(context, options).pipe(providePromiseAgent(runner)),
    application,
  );
}

export function runSinglePhasePromise(
  context: Parameters<typeof native.runSinglePhase>[0],
  phase: Parameters<typeof native.runSinglePhase>[1],
  runner: AgentRunner = runAgentPromise,
  application?: ApplicationExecution,
) {
  return runApplicationPromise(
    native.runSinglePhase(context, phase).pipe(providePromiseAgent(runner)),
    application,
  );
}
