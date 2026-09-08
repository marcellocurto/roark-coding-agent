import * as native from "./issue-curation.ts";
import {
  runApplicationPromise,
  type ApplicationExecution,
} from "../runtime/application.ts";

export function issueCurationPhasePromise(
  context: Parameters<typeof native.issueCurationPhase>[0],
  clock?: Parameters<typeof native.issueCurationPhase>[1],
  options: Parameters<typeof native.issueCurationPhase>[2] = {},
  application?: ApplicationExecution,
) {
  return runApplicationPromise(
    native.issueCurationPhase(context, clock, options),
    application,
  );
}

export function buildIssueCurationPlanPromise(
  context: Parameters<typeof native.buildIssueCurationPlan>[0],
  clock?: Parameters<typeof native.buildIssueCurationPlan>[1],
  options: Parameters<typeof native.buildIssueCurationPlan>[2] = {},
  application?: ApplicationExecution,
) {
  return runApplicationPromise(
    native.buildIssueCurationPlan(context, clock, options),
    application,
  );
}
