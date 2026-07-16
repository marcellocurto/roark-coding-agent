import type { IssueDraft, IssueDraftCollection } from "../issue-publishing/result.ts";
import type { PrDraft } from "../pr-publishing/result.ts";
import type { AgentRunRequest } from "../workflow/agent-runner.ts";

export function prDraft(overrides: Partial<PrDraft> = {}): PrDraft {
  return {
    title: "Fix the reported behavior",
    simpleSummary: "This change fixes the reported behavior and is ready for review.",
    summary: ["Fix the behavior described by the source issue."],
    changes: ["Apply the implementation recorded in the workflow artifacts."],
    reviewInstructions: ["Review the behavior change and its regression coverage."],
    verification: ["The configured verification command passed."],
    risksAndNonGoals: [],
    additionalSections: [],
    additionalClosingIssueNumbers: [],
    ...overrides,
  };
}

export async function submitPrDraft(request: AgentRunRequest, draft: PrDraft): Promise<string> {
  const tool = request.customTools?.find((candidate) => candidate.name === "submit_pr_draft");
  if (!tool) throw new Error("Request did not expose submit_pr_draft.");
  await tool.execute("test-submit-pr-draft", draft, undefined, undefined, {} as never);
  return "";
}

export function issueDraft(planItemId: string, overrides: Partial<IssueDraft> = {}): IssueDraft {
  return {
    planItemId,
    title: `Track ${planItemId}`,
    simpleSummary: "This issue records a concrete reviewer finding for follow-up.",
    whyThisIssueExists: ["The structured review recorded concrete evidence."],
    impact: ["The behavior can affect future users."],
    suggestedFix: ["Implement the smallest complete correction."],
    acceptanceCriteria: ["The reported behavior is covered and corrected."],
    risksAndNonGoals: [],
    additionalSections: [],
    ...overrides,
  };
}

export async function submitIssueDrafts(request: AgentRunRequest, collection: IssueDraftCollection): Promise<string> {
  const tool = request.customTools?.find((candidate) => candidate.name === "submit_issue_drafts");
  if (!tool) throw new Error("Request did not expose submit_issue_drafts.");
  await tool.execute("test-submit-issue-drafts", collection, undefined, undefined, {} as never);
  return "";
}
