import {
  fromLegacyPromise,
  runApplicationPromise,
  type ApplicationExecution,
} from "../runtime/application.ts";
import { providePromiseAgent } from "../workflow/promise-boundary.ts";
import type { AgentRunRequest, AgentRunner } from "../workflow/agent-runner.ts";
import {
  runStructuredArtifact,
  type StructuredArtifactDefinition,
} from "./runner.ts";

export interface StructuredArtifactWritersPromise {
  writeJson: (content: string) => Promise<void>;
  writeMarkdown: (content: string) => Promise<void>;
}
export function runStructuredArtifactPromise<T>(
  request: AgentRunRequest,
  runner: AgentRunner,
  definition: StructuredArtifactDefinition<T>,
  writers: StructuredArtifactWritersPromise,
  application?: ApplicationExecution,
) {
  return runApplicationPromise(
    runStructuredArtifact(request, definition, {
      writeJson: (content) =>
        fromLegacyPromise(() => writers.writeJson(content)),
      writeMarkdown: (content) =>
        fromLegacyPromise(() => writers.writeMarkdown(content)),
    }).pipe(providePromiseAgent(runner)),
    application,
  );
}
