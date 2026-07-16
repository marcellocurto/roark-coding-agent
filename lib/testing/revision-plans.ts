import type { RevisionPlanResult, RevisionPlanStatus } from "../pr-revision/plan.ts";
import type { AgentRunRequest } from "../workflow/agent-runner.ts";

export function revisionPlanResult(
  status: RevisionPlanStatus,
  overrides: Partial<RevisionPlanResult> = {},
): RevisionPlanResult {
  const defaults: RevisionPlanResult = status === "needs-human"
    ? {
        status,
        feedbackItems: [{
          id: "pr:12",
          sourceIds: ["pr:12"],
          summary: "Feedback requires a human decision.",
          classification: "needs-human",
          rationale: "Please decide how this feedback should be handled.",
        }],
      }
    : status === "revise"
      ? {
          status,
          feedbackItems: [{
            id: "pr:12",
            sourceIds: ["pr:12"],
            summary: "Address the current PR feedback.",
            classification: "must-fix-current",
            rationale: "The feedback identifies a current defect.",
          }],
        }
      : {
          status,
          feedbackItems: [],
        };
  return { ...defaults, ...overrides };
}

export async function submitRevisionPlan(request: AgentRunRequest, result: RevisionPlanResult): Promise<string> {
  const tool = request.customTools?.find((candidate) => candidate.name === "submit_revision_plan");
  if (!tool) throw new Error("Revision plan request did not expose submit_revision_plan.");
  await tool.execute("test-submit-revision-plan", result, undefined, undefined, {} as never);
  return "";
}
