import * as native from "./labels.ts";
import {
  runApplicationPromise,
  type ApplicationExecution,
} from "../runtime/application.ts";

export function ensureReviewerIssueLabelsPromise(
  options: Parameters<typeof native.ensureReviewerIssueLabels>[0],
  application?: ApplicationExecution,
) {
  return runApplicationPromise(
    native.ensureReviewerIssueLabels(options),
    application,
  );
}
