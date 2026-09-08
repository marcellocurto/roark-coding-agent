import * as native from "./github.ts";
import {
  runApplicationPromise,
  type ApplicationExecution,
} from "../runtime/application.ts";

export function publishIssueWithGitHubPromise(
  request: Parameters<typeof native.publishIssueWithGitHub>[0],
  application?: ApplicationExecution,
) {
  return runApplicationPromise(
    native.publishIssueWithGitHub(request),
    application,
  );
}
