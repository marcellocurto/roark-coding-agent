import {
  runApplicationPromise,
  type ApplicationExecution,
} from "../runtime/application.ts";
import {
  finalizeAttemptObservability,
  type FinalizeAttemptObservabilityInput,
} from "./observability.ts";
export function finalizeAttemptObservabilityPromise(
  input: FinalizeAttemptObservabilityInput,
  application?: ApplicationExecution,
) {
  return runApplicationPromise(
    finalizeAttemptObservability(input),
    application,
  );
}
