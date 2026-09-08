import { runPrReview } from "./workflow.ts";
import {
  runApplicationPromise,
  type ApplicationExecution,
} from "../runtime/application.ts";

export function runPrReviewPromise(
  options: Parameters<typeof runPrReview>[0],
  application?: ApplicationExecution,
) {
  return runApplicationPromise(runPrReview(options), application);
}
