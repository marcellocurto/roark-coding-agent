import { ensureGitHubLabels, type EnsureGitHubLabelsResult, type RequiredGitHubLabel } from "../github/labels.ts";

export const reviewerIssueHumanLabels = ["needs-triage", "needs-human"] as const;
export const reviewerIssueClassificationLabels = ["external-blocker", "follow-up", "suggestion"] as const;

export type ReviewerIssueClassificationLabel = typeof reviewerIssueClassificationLabels[number];

export const requiredReviewerIssueLabels: RequiredGitHubLabel[] = [
  {
    role: "reviewer-generated-needs-triage",
    name: "needs-triage",
    color: "FBCA04",
    description: "Needs human triage before work proceeds.",
  },
  {
    role: "reviewer-generated-needs-human",
    name: "needs-human",
    color: "FBCA04",
    description: "Needs human review or decision.",
  },
  {
    role: "reviewer-generated-external-blocker",
    name: "external-blocker",
    color: "D73A4A",
    description: "Reviewer-generated issue for an external blocker.",
  },
  {
    role: "reviewer-generated-follow-up",
    name: "follow-up",
    color: "0E8A16",
    description: "Reviewer-generated follow-up work.",
  },
  {
    role: "reviewer-generated-suggestion",
    name: "suggestion",
    color: "C5DEF5",
    description: "Reviewer-generated suggestion for human triage.",
  },
];

export async function ensureReviewerIssueLabels(options: { cwd: string; repo?: string | undefined }): Promise<EnsureGitHubLabelsResult> {
  return ensureGitHubLabels({ cwd: options.cwd, repo: options.repo, labels: requiredReviewerIssueLabels });
}
