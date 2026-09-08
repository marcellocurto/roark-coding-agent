import * as native from "./readiness.ts";
import {
  runApplicationPromise,
  type ApplicationExecution,
} from "../runtime/application.ts";

export function buildReadinessArtifactsPromise(
  context: Parameters<typeof native.buildReadinessArtifacts>[0],
  application?: ApplicationExecution,
) {
  return runApplicationPromise(
    native.buildReadinessArtifacts(context),
    application,
  );
}
