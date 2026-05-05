import { runProcessOrThrow } from "../cli/process.ts";
import type { AutorunClaimPlan } from "../autorun/claim.ts";

export type ParsedIssueRef = {
  issueNumber: string;
  repo?: string;
};

export type GitHubIssue = {
  number: number;
  title: string;
  body?: string;
  state?: string;
  labels?: Array<{ name: string }>;
  assignees?: Array<{ login: string }>;
  milestone?: { title: string } | null;
  url?: string;
  comments?: Array<{
    author?: { login: string };
    body?: string;
    createdAt?: string;
  }>;
};

export type GitHubIssueListItem = {
  number: number;
  title: string;
  url?: string;
  createdAt?: string;
  labels?: Array<{ name: string }>;
};

export function parseIssueRef(input: string, explicitRepo?: string): ParsedIssueRef {
  const urlMatch = input.match(/^https?:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/(\d+)/i);
  if (urlMatch?.[1] && urlMatch[2]) return { repo: explicitRepo ?? urlMatch[1], issueNumber: urlMatch[2] };

  const shorthandMatch = input.match(/^([^/\s]+\/[^#\s]+)#(\d+)$/);
  if (shorthandMatch?.[1] && shorthandMatch[2]) {
    return { repo: explicitRepo ?? shorthandMatch[1], issueNumber: shorthandMatch[2] };
  }

  const numberMatch = input.match(/^#?(\d+)$/);
  if (numberMatch?.[1]) return { repo: explicitRepo, issueNumber: numberMatch[1] };

  throw new Error(`Could not parse issue '${input}'. Use a number, GitHub issue URL, or owner/repo#123.`);
}

export async function listOpenGitHubIssues(options: { cwd: string; repo?: string; limit: number }): Promise<GitHubIssueListItem[]> {
  const args = [
    "gh",
    "issue",
    "list",
    "--state",
    "open",
    "--limit",
    String(options.limit),
    "--json",
    "number,title,url,createdAt,labels",
  ];
  if (options.repo) args.push("--repo", options.repo);

  const stdout = await runProcessOrThrow(args, { cwd: options.cwd, label: "gh issue list" });
  return JSON.parse(stdout) as GitHubIssueListItem[];
}

export async function getCurrentGitHubLogin(options: { cwd: string }): Promise<string> {
  return (await runProcessOrThrow(["gh", "api", "user", "--jq", ".login"], { cwd: options.cwd, label: "gh api user" })).trim();
}

export async function claimGitHubIssue(options: { cwd: string; repo?: string; plan: AutorunClaimPlan }): Promise<void> {
  const issueNumber = String(options.plan.issueNumber);
  const repoArgs = options.repo ? ["--repo", options.repo] : [];

  await runProcessOrThrow(
    ["gh", "issue", "edit", issueNumber, "--add-label", options.plan.inProgressLabel, ...repoArgs],
    { cwd: options.cwd, label: "gh issue edit --add-label" },
  );

  if (options.plan.assignee) {
    await runProcessOrThrow(
      ["gh", "issue", "edit", issueNumber, "--add-assignee", options.plan.assignee, ...repoArgs],
      { cwd: options.cwd, label: "gh issue edit --add-assignee" },
    );
  }

  await runProcessOrThrow(
    ["gh", "issue", "comment", issueNumber, "--body", options.plan.commentBody, ...repoArgs],
    { cwd: options.cwd, label: "gh issue comment" },
  );
}

export async function fetchGitHubIssue(input: string, options: { cwd: string; repo?: string }): Promise<{
  issue: GitHubIssue;
  issueNumber: string;
  repo?: string;
}> {
  const parsed = parseIssueRef(input, options.repo);
  const args = [
    "gh",
    "issue",
    "view",
    parsed.issueNumber,
    "--json",
    "number,title,body,state,labels,assignees,milestone,url,comments",
  ];
  if (parsed.repo) args.push("--repo", parsed.repo);

  const stdout = await runProcessOrThrow(args, { cwd: options.cwd, label: "gh issue view" });
  return {
    issue: JSON.parse(stdout) as GitHubIssue,
    issueNumber: parsed.issueNumber,
    repo: parsed.repo,
  };
}

export function formatIssueMarkdown(issue: GitHubIssue): string {
  const labels = (issue.labels ?? []).map((label) => label.name).join(", ") || "none";
  const assignees = (issue.assignees ?? []).map((assignee) => assignee.login).join(", ") || "none";
  const comments = issue.comments?.length
    ? issue.comments
        .map((comment, index) => `### Comment ${index + 1} - ${comment.author?.login ?? "unknown"} - ${comment.createdAt ?? "unknown time"}\n\n${comment.body ?? ""}`)
        .join("\n\n")
    : "No comments.";

  return `# Issue #${issue.number}: ${issue.title}

URL: ${issue.url ?? "unknown"}
State: ${issue.state ?? "unknown"}
Labels: ${labels}
Assignees: ${assignees}
Milestone: ${issue.milestone?.title ?? "none"}

## Body

${issue.body ?? ""}

## Comments

${comments}
`;
}
