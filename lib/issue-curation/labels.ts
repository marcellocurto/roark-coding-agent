import { ensureGitHubLabels, type EnsureGitHubLabelsResult, type RequiredGitHubLabel } from "../github/labels.ts";

export const reviewerIssueTriageLabels = ["needs-triage"] as const;
export const reviewerIssueClassificationLabels = ["external-blocker", "follow-up", "suggestion"] as const;

export type ReviewerIssueClassificationLabel = typeof reviewerIssueClassificationLabels[number];

export function reviewerIssueLabelForClassification(classification: ReviewerIssueClassificationLabel): string {
  return `review:${classification}`;
}

export const reviewerIssueManagedLabels = [
  "needs-triage",
  "needs-human",
  ...reviewerIssueClassificationLabels,
  ...reviewerIssueClassificationLabels.map(reviewerIssueLabelForClassification),
] as const;

export const requiredReviewerIssueLabels: RequiredGitHubLabel[] = [
  {
    role: "reviewer-generated-needs-triage",
    name: "needs-triage",
    color: "FBCA04",
    description: "Needs human triage before work proceeds.",
  },
  {
    role: "reviewer-generated-external-blocker",
    name: "review:external-blocker",
    color: "D73A4A",
    description: "Reviewer classification for an issue generated from an external blocker finding.",
  },
  {
    role: "reviewer-generated-follow-up",
    name: "review:follow-up",
    color: "0E8A16",
    description: "Reviewer classification for generated non-blocking follow-up work.",
  },
  {
    role: "reviewer-generated-suggestion",
    name: "review:suggestion",
    color: "C5DEF5",
    description: "Reviewer classification for a generated optional suggestion.",
  },
];

export async function ensureReviewerIssueLabels(options: { cwd: string; repo?: string | undefined }): Promise<EnsureGitHubLabelsResult> {
  return ensureGitHubLabels({ cwd: options.cwd, repo: options.repo, labels: requiredReviewerIssueLabels });
}
