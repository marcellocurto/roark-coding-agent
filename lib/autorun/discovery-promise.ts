import { runAutoDiscovery } from "./discovery.ts";
import {
  runApplicationPromise,
  type ApplicationExecution,
} from "../runtime/application.ts";

export function runAutoDiscoveryPromise(
  options: Parameters<typeof runAutoDiscovery>[0],
  application?: ApplicationExecution,
) {
  return runApplicationPromise(runAutoDiscovery(options), application);
}
