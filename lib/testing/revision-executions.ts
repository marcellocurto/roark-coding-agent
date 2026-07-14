import type { RevisionExecutionResult } from "../pr-revision/execution.ts";
import type { AgentRunRequest } from "../workflow/agent-runner.ts";

export function revisionExecutionResult(
  overrides: Partial<RevisionExecutionResult> = {},
): RevisionExecutionResult {
  return {
    summary: "Completed the requested PR revision.",
    addressedItems: [{ item: "Required revision", resolution: "Implemented the requested change." }],
    skippedItems: [],
    changedFiles: [{ path: "fixed.txt", description: "Applied the requested revision." }],
    validation: [{ command: "bun test", status: "passed", details: "Relevant tests passed." }],
    ...overrides,
  };
}

export async function submitRevisionExecution(
  request: AgentRunRequest,
  result: RevisionExecutionResult,
): Promise<string> {
  const tool = request.customTools?.find((candidate) => candidate.name === "submit_revision_execution");
  if (!tool) throw new Error("Request did not expose submit_revision_execution.");
  await tool.execute("test-submit-revision-execution", result, undefined, undefined, {} as never);
  return "";
}
