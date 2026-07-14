import type { ImplementationPlanResult } from "../implementation-plan/result.ts";
import type { TriageResult, TriageVerdict } from "../triage/result.ts";
import type { AgentRunRequest } from "../workflow/agent-runner.ts";
import type { ReadinessResult, ReadinessStatus } from "../workflow/readiness.ts";

export function triageResult(
  verdict: TriageVerdict = "proceed",
  overrides: Partial<TriageResult> = {},
): TriageResult {
  return {
    verdict,
    reasoning: verdict === "proceed" ? "Repository evidence supports proceeding." : "Repository evidence supports stopping.",
    claimVerification: "confirmed",
    evidence: ["lib/example.ts:1 supports the triage decision."],
    establishedFacts: ["The relevant workflow exists in this repository."],
    blockingQuestions: verdict === "needs-human-decision" ? ["A maintainer decision is required."] : [],
    recommendedNextStep: verdict === "proceed" ? "Prepare an implementation plan." : "Resolve the triage outcome.",
    ...overrides,
  };
}

export function implementationPlanResult(
  readyForImplementation = true,
  overrides: Partial<ImplementationPlanResult> = {},
): ImplementationPlanResult {
  return {
    issue: "Implement the requested issue.",
    workClassification: "backend",
    goal: "Satisfy the issue with the smallest complete change.",
    nonGoals: ["Do not broaden scope."],
    currentCodeFindings: ["The current behavior is missing the requested contract."],
    simplificationsFromDraft: [],
    proposedChanges: ["Implement the requested contract."],
    filesLikelyToChange: ["lib/example.ts — implement the behavior."],
    detailedSteps: ["Update the production seam."],
    testsAndValidation: ["Run the focused regression test."],
    risks: ["Incorrect routing could preserve the bug."],
    rollbackPlan: ["Revert the focused change."],
    readyForImplementation,
    ...overrides,
  };
}

export async function submitTriage(request: AgentRunRequest, result: TriageResult): Promise<string> {
  return submit(request, "submit_triage", result);
}

export async function submitImplementationPlan(request: AgentRunRequest, result: ImplementationPlanResult): Promise<string> {
  return submit(request, "submit_implementation_plan", result);
}

export function readinessResult(status: ReadinessStatus): ReadinessResult {
  return {
    version: 1,
    issueNumber: "12",
    runDirectory: ".roark/runs/issue/12",
    latestReviewCycle: status === "ready-for-pr" ? 0 : null,
    maxFixPasses: 1,
    decision: {
      status,
      triageVerdict: "proceed",
      reviewAVerdict: status === "ready-for-pr" ? "approve" : "missing",
      reviewBVerdict: status === "ready-for-pr" ? "approve" : "missing",
      planReady: true,
      fixesWereNeeded: false,
      restartRequired: false,
      blockedByReview: false,
      currentIssueBlockingFindings: [],
      externalBlockers: [],
      followUpFindings: [],
      suggestions: [],
    },
  };
}

async function submit(request: AgentRunRequest, toolName: string, result: unknown): Promise<string> {
  const tool = request.customTools?.find((candidate) => candidate.name === toolName);
  if (!tool) throw new Error(`Request did not expose ${toolName}.`);
  await tool.execute(`test-${toolName}`, result, undefined, undefined, {} as never);
  return "";
}
