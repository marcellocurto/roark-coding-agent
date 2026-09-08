import * as native from "./verification.ts";
import {
  runApplicationPromise,
  type ApplicationExecution,
} from "../runtime/application.ts";
export function runVerificationPromise(
  options: Parameters<typeof native.runVerification>[0],
  application?: ApplicationExecution,
) {
  return runApplicationPromise(native.runVerification(options), application);
}
export function inferVerificationCommandPromise(
  cwd: string,
  options: Parameters<typeof native.inferVerificationCommand>[1] = {},
  application?: ApplicationExecution,
) {
  return runApplicationPromise(
    native.inferVerificationCommand(cwd, options),
    application,
  );
}
export function writeVerificationArtifactPromise(
  context: Parameters<typeof native.writeVerificationArtifact>[0],
  result: Parameters<typeof native.writeVerificationArtifact>[1],
  application?: ApplicationExecution,
) {
  return runApplicationPromise(
    native.writeVerificationArtifact(context, result),
    application,
  );
}
export function writeVerificationBeforeFixArtifactPromise(
  context: Parameters<typeof native.writeVerificationBeforeFixArtifact>[0],
  pass: number,
  result: Parameters<typeof native.writeVerificationBeforeFixArtifact>[2],
  application?: ApplicationExecution,
) {
  return runApplicationPromise(
    native.writeVerificationBeforeFixArtifact(context, pass, result),
    application,
  );
}
