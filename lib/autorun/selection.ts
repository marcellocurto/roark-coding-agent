export interface AutorunIssueCandidate {
  number: number;
  title: string;
  body?: string | undefined;
  url?: string | undefined  ;
  createdAt?: string | undefined;
  labels?: { name: string }[] | undefined;
}

export interface IssueSelectionOptions {
  readyLabel: string;
  skipLabels: readonly string[];
  limit: number;
}

export const defaultAutorunReadyLabel = "afk";
export const defaultAutorunInProgressLabel = "roark-in-progress";

export const defaultAutorunSkipLabels = [
  "blocked",
  "needs-human",
  "triage-rejected",
  "wontfix",
  "roark-in-progress",
  "roark-failed",
  "roark-ready-for-review",
  "roark-pr-opened",
] as const;

export function selectEligibleIssues(
  issues: readonly AutorunIssueCandidate[],
  options: IssueSelectionOptions,
): AutorunIssueCandidate[] {
  return rankEligibleIssues(issues, options).slice(0, options.limit);
}

export function rankEligibleIssues(
  issues: readonly AutorunIssueCandidate[],
  options: IssueSelectionOptions,
): AutorunIssueCandidate[] {
  return issues
    .filter((issue) => isEligibleIssue(issue, options))
    .toSorted(compareOldestIssueFirst);
}

export function isEligibleIssue(issue: AutorunIssueCandidate, options: IssueSelectionOptions): boolean {
  const labels = normalizedLabelSet(issue);
  if (!labels.has(normalizeLabel(options.readyLabel))) return false;
  return findMatchingSkipLabel(issue, options.skipLabels) === undefined;
}

export function findMatchingSkipLabel(
  issue: AutorunIssueCandidate,
  skipLabels: readonly string[],
): string | undefined {
  const normalizedSkipLabels = new Set(skipLabels.map(normalizeLabel));
  return issue.labels?.find((label) => normalizedSkipLabels.has(normalizeLabel(label.name)))?.name;
}

function compareOldestIssueFirst(left: AutorunIssueCandidate, right: AutorunIssueCandidate): number {
  const leftTime = parseCreatedAt(left.createdAt);
  const rightTime = parseCreatedAt(right.createdAt);
  if (leftTime !== rightTime) return leftTime - rightTime;
  return left.number - right.number;
}

function parseCreatedAt(value: string | undefined): number {
  if (!value) return Number.MAX_SAFE_INTEGER;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Number.MAX_SAFE_INTEGER : parsed;
}

function normalizedLabelSet(issue: AutorunIssueCandidate): Set<string> {
  return new Set((issue.labels ?? []).map((label) => normalizeLabel(label.name)));
}

function normalizeLabel(label: string): string {
  return label.trim().toLowerCase();
}
