import type { RevisionPlanResult, RevisionPlanStatus } from "../pr-revision/plan.ts";
import type { AgentRunRequest } from "../workflow/agent-runner.ts";

export function revisionPlanResult(
  status: RevisionPlanStatus,
  overrides: Partial<RevisionPlanResult> = {},
): RevisionPlanResult {
  const defaults: RevisionPlanResult = status === "needs-human"
    ? {
        status,
        classifiedFeedback: ["[needs-human] Feedback requires a human decision."],
        mustFixCurrent: [],
        humanNeeds: ["Please decide how this feedback should be handled."],
      }
    : status === "revise"
      ? {
          status,
          classifiedFeedback: ["[must-fix-current] Feedback requires a code revision."],
          mustFixCurrent: ["Address the current PR feedback."],
          humanNeeds: [],
        }
      : {
          status,
          classifiedFeedback: [],
          mustFixCurrent: [],
          humanNeeds: [],
        };
  return { ...defaults, ...overrides };
}

export async function submitRevisionPlan(request: AgentRunRequest, result: RevisionPlanResult): Promise<string> {
  const tool = request.customTools?.find((candidate) => candidate.name === "submit_revision_plan");
  if (!tool) throw new Error("Revision plan request did not expose submit_revision_plan.");
  await tool.execute("test-submit-revision-plan", result, undefined, undefined, {} as never);
  return "";
}
