import { runAutoContinue } from "./continue.ts";
import {
  runApplicationPromise,
  type ApplicationExecution,
} from "../runtime/application.ts";

export function runAutoContinuePromise(
  options: Parameters<typeof runAutoContinue>[0],
  application?: ApplicationExecution,
) {
  return runApplicationPromise(runAutoContinue(options), application);
}
