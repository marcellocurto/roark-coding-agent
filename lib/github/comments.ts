import { runProcessOrThrow } from "../cli/process.ts";

export const githubIssueCommentMaxChars = 65_536;

export type RoarkCommentPhase = string;

export interface RoarkMarkerInput {
  issueNumber: number | string;
  attempt: number;
  phase: RoarkCommentPhase;
}

export interface GitHubCommentRef {
  id: number;
  url?: string | undefined  ;
  marker: string;
}

interface GitHubIssueComment {
  id?: number | undefined;
  body?: string | undefined;
  html_url?: string | undefined;
  url?: string | undefined  ;
  authorLogin?: string | undefined;
}

export interface IssueCommentOptions {
  cwd: string;
  repo?: string | undefined  ;
  issueNumber: number | string;
  body: string;
}

export type IssueCommentByMarkerOptions = IssueCommentOptions & {
  marker: string;
  existingCommentId?: number | undefined  ;
};

export function buildRoarkMarker(input: RoarkMarkerInput): string {
  return `<!-- roark:issue=${input.issueNumber} attempt=${input.attempt} phase=${input.phase} -->`;
}

export function ensureCommentStartsWithMarker(body: string, marker: string): string {
  return body.startsWith(marker) ? body : `${marker}\n${body}`;
}

export function formatBoundedMarkdownDetails(summary: string, markdown: string, maxChars = 10_000): string {
  const bounded = markdown.length <= maxChars
    ? markdown
    : `${markdown.slice(0, maxChars)}\n\n... (details truncated; full output is retained in the run artifacts) ...`;
  const fence = "`".repeat(Math.max(3, longestBacktickRun(bounded) + 1));
  return [
    `<details><summary>${summary}</summary>`,
    "",
    fence,
    bounded.trimEnd(),
    fence,
    "",
    "</details>",
  ].join("\n");
}

export function buildListIssueCommentsArgv(options: { repo: string; issueNumber: number | string }): string[] {
  return ["gh", "api", `repos/${options.repo}/issues/${options.issueNumber}/comments`, "--paginate", "--slurp"];
}

export function buildPostIssueCommentArgv(options: { repo: string; issueNumber: number | string; body: string }): string[] {
  return [
    "gh",
    "api",
    `repos/${options.repo}/issues/${options.issueNumber}/comments`,
    "--method",
    "POST",
    "--field",
    `body=${truncateGitHubIssueComment(options.body)}`,
  ];
}

export function buildUpdateIssueCommentArgv(options: { repo: string; commentId: number; body: string }): string[] {
  return [
    "gh",
    "api",
    `repos/${options.repo}/issues/comments/${options.commentId}`,
    "--method",
    "PATCH",
    "--field",
    `body=${truncateGitHubIssueComment(options.body)}`,
  ];
}

export function truncateGitHubIssueComment(body: string): string {
  // Intentionally use a hard cutoff even though it may split a Markdown fence or
  // <details> block. We accept imperfect rendering at this extreme: the complete
  // output remains available in local run artifacts, and oversized comments have
  // not been an observed operational problem worth more complex truncation logic.
  let characters = 0;
  let end = 0;
  for (const character of body) {
    if (characters === githubIssueCommentMaxChars) return body.slice(0, end);
    characters += 1;
    end += character.length;
  }
  return body;
}

export function buildCurrentRepoArgv(): string[] {
  return ["gh", "repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"];
}

export function buildCurrentCommentAuthorArgv(): string[] {
  return ["gh", "api", "user", "--jq", ".login"];
}

export function parseGitHubCommentRef(raw: string, marker: string): GitHubCommentRef {
  const parsed = JSON.parse(raw) as unknown;
  const comment = normalizeComment(parsed);
  if (comment.id === undefined) throw new Error("GitHub comment response did not include a numeric id.");
  return { id: comment.id, url: comment.html_url ?? comment.url, marker };
}

export function parseIssueComments(raw: string): GitHubIssueComment[] {
  const parsed = JSON.parse(raw) as unknown;
  return flattenComments(parsed);
}

export function findIssueCommentByMarker(comments: GitHubIssueComment[], marker: string, authorLogin?: string): GitHubIssueComment | undefined {
  return comments.find((comment) =>
    comment.body?.includes(marker) === true &&
    typeof comment.id === "number" &&
    (authorLogin === undefined || comment.authorLogin === authorLogin));
}

export async function postIssueComment(options: IssueCommentOptions): Promise<GitHubCommentRef> {
  const repo = await resolveCommentRepo({ cwd: options.cwd, repo: options.repo });
  const marker = markerFromBody(options.body) ?? "";
  const stdout = await runProcessOrThrow(
    buildPostIssueCommentArgv({ repo, issueNumber: options.issueNumber, body: options.body }),
    { cwd: options.cwd, label: "gh api issue comment create" },
  );
  return parseGitHubCommentRef(stdout, marker);
}

export async function updateIssueComment(options: { cwd: string; repo?: string | undefined; commentId: number; body: string; marker?: string }): Promise<GitHubCommentRef> {
  const repo = await resolveCommentRepo({ cwd: options.cwd, repo: options.repo });
  const marker = options.marker ?? markerFromBody(options.body) ?? "";
  const stdout = await runProcessOrThrow(
    buildUpdateIssueCommentArgv({ repo, commentId: options.commentId, body: options.body }),
    { cwd: options.cwd, label: "gh api issue comment update" },
  );
  return parseGitHubCommentRef(stdout, marker);
}

export async function postOrUpdateIssueCommentByMarker(options: IssueCommentByMarkerOptions): Promise<GitHubCommentRef> {
  const repo = await resolveCommentRepo({ cwd: options.cwd, repo: options.repo });
  const body = ensureCommentStartsWithMarker(options.body, options.marker);

  if (options.existingCommentId !== undefined) {
    try {
      return await updateIssueComment({
        cwd: options.cwd,
        repo,
        commentId: options.existingCommentId,
        body,
        marker: options.marker,
      });
    } catch {
      // Fall through to marker lookup. The stored comment may have been deleted.
    }
  }

  const commentsRaw = await runProcessOrThrow(
    buildListIssueCommentsArgv({ repo, issueNumber: options.issueNumber }),
    { cwd: options.cwd, label: "gh api issue comments list" },
  );
  const currentAuthor = (await runProcessOrThrow(buildCurrentCommentAuthorArgv(), { cwd: options.cwd, label: "gh api current comment author" })).trim();
  if (!currentAuthor) throw new Error("Could not resolve the authenticated GitHub comment author.");
  const existing = findIssueCommentByMarker(parseIssueComments(commentsRaw), options.marker, currentAuthor);
  if (existing?.id !== undefined) {
    return await updateIssueComment({ cwd: options.cwd, repo, commentId: existing.id, body, marker: options.marker });
  }

  return await postIssueComment({ cwd: options.cwd, repo, issueNumber: options.issueNumber, body });
}

async function resolveCommentRepo(options: { cwd: string; repo?: string  | undefined}): Promise<string> {
  if (options.repo) return options.repo;
  const stdout = await runProcessOrThrow(buildCurrentRepoArgv(), { cwd: options.cwd, label: "gh repo view" });
  const repo = stdout.trim();
  if (!repo) throw new Error("Could not resolve GitHub repository for issue comment publishing.");
  return repo;
}

function markerFromBody(body: string): string | undefined {
  return (/^<!--\s*roark:[\s\S]*?-->/.exec(body))?.[0];
}

function normalizeComment(value: unknown): GitHubIssueComment {
  if (!isRecord(value)) return {};
  return {
    id: typeof value["id"] === "number" ? value["id"] : undefined,
    body: typeof value["body"] === "string" ? value["body"] : undefined,
    html_url: typeof value["html_url"] === "string" ? value["html_url"] : undefined,
    url: typeof value["url"] === "string" ? value["url"] : undefined,
    authorLogin: isRecord(value["user"]) && typeof value["user"]["login"] === "string" ? value["user"]["login"] : undefined,
  };
}

function flattenComments(value: unknown): GitHubIssueComment[] {
  if (!Array.isArray(value)) return [];
  const flattened: unknown[] = value.flatMap((entry: unknown) => Array.isArray(entry) ? entry as unknown[] : [entry]);
  return flattened.map(normalizeComment).filter((comment) => comment.id !== undefined);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function longestBacktickRun(value: string): number {
  let longest = 0;
  let current = 0;
  for (const character of value) {
    if (character === "`") {
      current += 1;
      longest = Math.max(longest, current);
    } else {
      current = 0;
    }
  }
  return longest;
}
