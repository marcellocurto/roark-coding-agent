import { parseIssueRef } from "../github/issue.ts";

export function displayIssueTarget(issue: string | undefined, fallback: string): string;
export function displayIssueTarget(issue: string | undefined, fallback?: undefined): string | undefined;
export function displayIssueTarget(issue: string | undefined, fallback?: string): string | undefined {
  if (!issue) return fallback;
  try {
    return `#${parseIssueRef(issue).issueNumber}`;
  } catch {
    return issue;
  }
}

export function displayCommandTarget(options: {
  command: string;
  issue?: string | undefined;
  prNumber?: number | undefined;
}): string | undefined {
  if (options.prNumber !== undefined) return `PR #${options.prNumber}`;
  return displayIssueTarget(options.issue);
}

export function displayArgvTarget(argv: string[]): string {
  const value = argv[1];
  if (!value || value.startsWith("-")) return argv[0] ?? "Roark";
  if (argv[0]?.includes("pr") === true) {
    const number = /^#?(\d+)$/.exec(value)?.[1];
    return number ? `PR #${number}` : value;
  }
  return displayIssueTarget(value) ?? value;
}
