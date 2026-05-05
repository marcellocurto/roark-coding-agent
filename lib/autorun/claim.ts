import type { AutorunIssueCandidate } from "./selection.ts";

export type AutorunClaimPlan = {
  issueNumber: number;
  branchName: string;
  inProgressLabel: string;
  assignee?: string;
  commentBody: string;
};

export function createClaimPlan(
  issue: AutorunIssueCandidate,
  options: { inProgressLabel: string; assignee?: string },
): AutorunClaimPlan {
  const branchName = plannedIssueBranchName(issue.number);
  return {
    issueNumber: issue.number,
    branchName,
    inProgressLabel: options.inProgressLabel,
    assignee: options.assignee,
    commentBody: buildClaimComment({ issueNumber: issue.number, branchName, assignee: options.assignee }),
  };
}

export function plannedIssueBranchName(issueNumber: number): string {
  return `roark/issue-${issueNumber}`;
}

export function buildClaimComment(options: { issueNumber: number; branchName: string; assignee?: string }): string {
  const actor = options.assignee ? `@${options.assignee}` : "Roark";
  return `${actor} is attempting this issue in branch \`${options.branchName}\`.`;
}
