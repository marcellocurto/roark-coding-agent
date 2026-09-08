import * as native from "./progression.ts";
import {
  runApplicationPromise,
  type ApplicationExecution,
} from "../runtime/application.ts";

export function planWorkflowProgressionPromise(
  context: Parameters<typeof native.planWorkflowProgression>[0],
  options: Parameters<typeof native.planWorkflowProgression>[1] = {},
  application?: ApplicationExecution,
) {
  return runApplicationPromise(
    native.planWorkflowProgression(context, options),
    application,
  );
}
