import { runProcessOrThrow } from "../cli/process.ts";

export interface PullRequestComment {
  id?: string | undefined;
  databaseId?: number | undefined;
  author?: string | undefined;
  body: string;
  createdAt?: string | undefined;
  url?: string | undefined  ;
}

export type PullRequestReviewThreadComment = PullRequestComment & {
  path?: string | undefined;
  line?: number | undefined;
  originalLine?: number | undefined;
};

export interface PullRequestReviewThread {
  id: string;
  isResolved: boolean;
  isOutdated?: boolean | undefined;
  path?: string | undefined;
  line?: number | undefined;
  startLine?: number | undefined;
  originalLine?: number | undefined;
  comments: PullRequestReviewThreadComment[];
}

export interface PullRequestMetadata {
  id?: string | undefined;
  number: number;
  title: string;
  body: string;
  url?: string | undefined  ;
  state: string;
  isDraft?: boolean | undefined;
  baseRefName: string;
  headRefName: string;
  baseRepository?: string | undefined;
  headRepository?: string | undefined;
  author?: string | undefined;
}

export interface PullRequestFeedback {
  repo: string;
  pr: PullRequestMetadata;
  comments: PullRequestComment[];
  reviewThreads: PullRequestReviewThread[];
  plannerComments: PullRequestComment[];
  excludedRoarkSummaryCommentIds: (string | number)[];
  fetchedAt: string;
}

export interface PullRequestGraphQLResult {
  data?: {
    repository?: {
      pullRequest?: unknown;
    };
  };
  repository?: {
    pullRequest?: unknown;
  };
}

export const roarkPrRevisionSummaryMarkerPattern = /<!--\s*roark:pr=\d+\s+revision=\d+\s+phase=revision-summary\s*-->/;

export function buildPullRequestFeedbackGraphqlArgv(input: { repo: string; prNumber: number }): string[] {
  const [owner, name] = splitRepo(input.repo);
  return [
    "gh",
    "api",
    "graphql",
    "-f",
    `owner=${owner}`,
    "-f",
    `name=${name}`,
    "-F",
    `number=${input.prNumber}`,
    "-f",
    `query=${pullRequestFeedbackQuery}`,
  ];
}

export async function fetchPullRequestFeedback(options: { cwd: string; repo?: string | undefined; prNumber: number }): Promise<PullRequestFeedback> {
  const repo = await resolvePullRequestRepo({ cwd: options.cwd, repo: options.repo });
  const stdout = await runProcessOrThrow(buildPullRequestFeedbackGraphqlArgv({ repo, prNumber: options.prNumber }), {
    cwd: options.cwd,
    label: "gh api graphql pull request feedback",
  });
  return parsePullRequestFeedback(stdout, { repo, prNumber: options.prNumber });
}

export async function resolvePullRequestRepo(options: { cwd: string; repo?: string  | undefined}): Promise<string> {
  if (options.repo) return options.repo;
  const stdout = await runProcessOrThrow(["gh", "repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], {
    cwd: options.cwd,
    label: "gh repo view",
  });
  const repo = stdout.trim();
  if (!repo) throw new Error("Could not resolve GitHub repository. Pass --repo owner/repo.");
  return repo;
}

export function parsePullRequestFeedback(raw: string, input: { repo: string; prNumber: number }): PullRequestFeedback {
  const parsed = JSON.parse(raw) as PullRequestGraphQLResult;
  const pullRequest = parsed.data?.repository?.pullRequest ?? parsed.repository?.pullRequest;
  if (!isRecord(pullRequest)) throw new Error(`GitHub GraphQL response did not include pull request #${input.prNumber}.`);

  const pr = normalizePullRequestMetadata(pullRequest, input.prNumber);
  const comments = connectionNodes(pullRequest["comments"]).map(normalizePullRequestComment);
  const reviewThreads = requiredConnectionNodes(pullRequest["reviewThreads"], "pull request reviewThreads").map(normalizeReviewThread);
  const excludedRoarkSummaryCommentIds: (string | number)[] = [];
  const plannerComments = comments.filter((comment) => {
    if (!roarkPrRevisionSummaryMarkerPattern.test(comment.body)) return true;
    excludedRoarkSummaryCommentIds.push(comment.databaseId ?? comment.id ?? "unknown");
    return false;
  });

  return {
    repo: input.repo,
    pr,
    comments,
    reviewThreads,
    plannerComments,
    excludedRoarkSummaryCommentIds,
    fetchedAt: new Date().toISOString(),
  };
}

function normalizePullRequestMetadata(value: Record<string, unknown>, fallbackNumber: number): PullRequestMetadata {
  return {
    id: stringField(value, "id"),
    number: numberField(value, "number") ?? fallbackNumber,
    title: stringField(value, "title") ?? "",
    body: stringField(value, "body") ?? "",
    url: stringField(value, "url"),
    state: stringField(value, "state") ?? "UNKNOWN",
    isDraft: booleanField(value, "isDraft"),
    baseRefName: stringField(value, "baseRefName") ?? "",
    headRefName: stringField(value, "headRefName") ?? "",
    baseRepository: repositoryName(value["baseRepository"]),
    headRepository: repositoryName(value["headRepository"]),
    author: login(value["author"]),
  };
}

function normalizePullRequestComment(value: unknown): PullRequestComment {
  if (!isRecord(value)) return { body: "" };
  return {
    id: stringField(value, "id"),
    databaseId: numberField(value, "databaseId"),
    author: login(value["author"]),
    body: stringField(value, "body") ?? "",
    createdAt: stringField(value, "createdAt"),
    url: stringField(value, "url"),
  };
}

function normalizeReviewThread(value: unknown): PullRequestReviewThread {
  if (!isRecord(value)) throw new Error("GitHub GraphQL response included an invalid review thread node.");
  if (typeof value["isResolved"] !== "boolean") {
    const id = stringField(value, "id") ?? "unknown";
    throw new Error(`GitHub GraphQL response for review thread ${id} did not include boolean isResolved.`);
  }
  return {
    id: stringField(value, "id") ?? "",
    isResolved: value["isResolved"],
    isOutdated: booleanField(value, "isOutdated"),
    path: stringField(value, "path"),
    line: numberField(value, "line"),
    startLine: numberField(value, "startLine"),
    originalLine: numberField(value, "originalLine"),
    comments: connectionNodes(value["comments"]).map((comment) => ({
      ...normalizePullRequestComment(comment),
      path: isRecord(comment) ? stringField(comment, "path") : undefined,
      line: isRecord(comment) ? numberField(comment, "line") : undefined,
      originalLine: isRecord(comment) ? numberField(comment, "originalLine") : undefined,
    })),
  };
}

function connectionNodes(value: unknown): unknown[] {
  if (!isRecord(value) || !Array.isArray(value["nodes"])) return [];
  return value["nodes"].filter((node) => node !== null && node !== undefined);
}

function requiredConnectionNodes(value: unknown, label: string): unknown[] {
  if (!isRecord(value) || !Array.isArray(value["nodes"])) {
    throw new Error(`GitHub GraphQL response did not include a valid ${label}.nodes connection.`);
  }
  return value["nodes"].filter((node) => node !== null && node !== undefined);
}

function splitRepo(repo: string): [string, string] {
  const match = /^([^/]+)\/([^/]+)$/.exec(repo);
  if (!match?.[1] || !match[2]) throw new Error(`Repository must be in owner/repo format. Got '${repo}'.`);
  return [match[1], match[2]];
}

function repositoryName(value: unknown): string | undefined {
  return isRecord(value) ? stringField(value, "nameWithOwner") : undefined;
}

function login(value: unknown): string | undefined {
  return isRecord(value) ? stringField(value, "login") : undefined;
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === "string" ? field : undefined;
}

function numberField(value: Record<string, unknown>, key: string): number | undefined {
  const field = value[key];
  return typeof field === "number" ? field : undefined;
}

function booleanField(value: Record<string, unknown>, key: string): boolean | undefined {
  const field = value[key];
  return typeof field === "boolean" ? field : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const pullRequestFeedbackQuery = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      id
      number
      title
      body
      url
      state
      isDraft
      baseRefName
      headRefName
      baseRepository { nameWithOwner }
      headRepository { nameWithOwner }
      author { login }
      comments(first: 100) {
        nodes {
          id
          databaseId
          body
          createdAt
          url
          author { login }
        }
      }
      reviewThreads(first: 100) {
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          startLine
          originalLine
          comments(first: 50) {
            nodes {
              id
              databaseId
              body
              createdAt
              url
              author { login }
              path
              line
              originalLine
            }
          }
        }
      }
    }
  }
}`;
