import type { ContinuationResult } from "../issue-continuation/result.ts";
import type { AgentRunRequest } from "../workflow/agent-runner.ts";
import { toolContext } from "./tool-context.ts";

export function continuationResult(
  overrides: Partial<ContinuationResult> = {},
): ContinuationResult {
  return {
    status: "continue",
    summary: "The new discussion agrees with the saved plan.",
    resumeFrom: "unchanged",
    pass: null,
    requirementsChanged: false,
    resolutions: [],
    blockingQuestions: [],
    externalBlockers: [],
    ...overrides,
  };
}
export async function submitContinuation(
  request: AgentRunRequest,
  result: ContinuationResult,
): Promise<string> {
  const tool = request.customTools?.find(
    (candidate) => candidate.name === "submit_continuation",
  );
  if (!tool) throw new Error("Continuation submission tool is missing.");
  await tool.execute(
    "test-continuation",
    result,
    undefined,
    undefined,
    toolContext,
  );
  return "";
}
