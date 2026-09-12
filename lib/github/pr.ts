import { getCurrentGitHubRepository } from "./gh.ts";
import {
  githubCommentAuthorSchema,
  parseRestCommentPages,
} from "./comments.ts";
import { GitHubRequestError } from "./errors.ts";
import { GitHubResponseError } from "./errors.ts";
import { DateTime, Effect, Schema } from "effect";
import type { GitHubError, GitHubRequirements } from "./errors.ts";
import { runProcessOrThrow } from "../cli/process.ts";
export interface PullRequestComment {
  id?: string | undefined;
  databaseId?: number | undefined;
  author?: string | undefined;
  body: string;
  createdAt?: string | undefined;
  url?: string | undefined;
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
  url?: string | undefined;
  state: string;
  isDraft?: boolean | undefined;
  baseRefName: string;
  headRefName: string;
  baseRefOid: string;
  headRefOid: string;
  baseRepository?: string | undefined;
  baseRepositoryUrl?: string | undefined;
  headRepository?: string | undefined;
  author?: string | undefined;
}
export interface PullRequestClosingIssue {
  number: number;
  title: string;
  body: string;
  state: string;
  url?: string | undefined;
  repository?: string | undefined;
  comments?: PullRequestComment[] | undefined;
}
export interface PullRequestFeedback {
  repo: string;
  pr: PullRequestMetadata;
  comments: PullRequestComment[];
  reviewThreads: PullRequestReviewThread[];
  plannerComments: PullRequestComment[];
  excludedRoarkSummaryCommentIds: (string | number)[];
  closingIssues?: PullRequestClosingIssue[] | undefined;
  reviewThreadsTruncated?: boolean | undefined;
  fetchedAt: string;
}
export const roarkPrRevisionSummaryMarkerPattern =
  /<!--\s*roark:pr=\d+\s+revision=\d+\s+phase=revision-summary\s*-->/;
export const roarkPrReviewSummaryMarkerPattern =
  /<!--\s*roark:pr=\d+\s+phase=pr-review(?:\s+reviewer=[ab])?\s*-->/;
export function isRoarkGeneratedPrSummaryComment(body: string): boolean {
  return (
    roarkPrRevisionSummaryMarkerPattern.test(body) ||
    roarkPrReviewSummaryMarkerPattern.test(body)
  );
}
export function buildPullRequestFeedbackGraphqlArgv(input: {
  repo: string;
  prNumber: number;
}): string[] {
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
export const fetchPullRequestFeedback = Effect.fn(
  "GitHub.fetchPullRequestFeedback",
)(function* (options: {
  cwd: string;
  repo?: string | undefined;
  prNumber: number;
}): Effect.fn.Return<PullRequestFeedback, GitHubError, GitHubRequirements> {
  const repo = yield* resolvePullRequestRepo({
    cwd: options.cwd,
    repo: options.repo,
  });
  const stdout = yield* runProcessOrThrow(
    buildPullRequestFeedbackGraphqlArgv({ repo, prNumber: options.prNumber }),
    {
      cwd: options.cwd,
      label: "gh api graphql pull request feedback",
    },
  );
  const feedback = yield* parsePullRequestFeedback(stdout, {
    repo,
    prNumber: options.prNumber,
  });
  const closingIssues = yield* Effect.all(
    (feedback.closingIssues ?? []).map(
      Effect.fnUntraced(function* (issue) {
        if (issue.repository?.toLowerCase() !== repo.toLowerCase())
          return issue;
        const raw = yield* runProcessOrThrow(
          [
            "gh",
            "api",
            `repos/${repo}/issues/${issue.number}/comments`,
            "--paginate",
            "--slurp",
          ],
          {
            cwd: options.cwd,
            label: `gh api closing issue #${issue.number} comments`,
          },
        );
        return {
          ...issue,
          comments: yield* parseRestPullRequestComments(raw),
        };
      }),
    ),
    { concurrency: "unbounded" },
  );
  const commentsRaw = yield* runProcessOrThrow(
    [
      "gh",
      "api",
      `repos/${repo}/issues/${options.prNumber}/comments`,
      "--paginate",
      "--slurp",
    ],
    { cwd: options.cwd, label: "gh api pull request comments" },
  );
  return withPlannerComments(
    { ...feedback, closingIssues },
    yield* parseRestPullRequestComments(commentsRaw),
  );
});
export const resolvePullRequestRepo = Effect.fn(
  "GitHub.resolvePullRequestRepo",
)(function* (options: {
  cwd: string;
  repo?: string | undefined;
}): Effect.fn.Return<string, GitHubError, GitHubRequirements> {
  if (options.repo) return options.repo;
  const repo = yield* getCurrentGitHubRepository(options);
  if (!repo)
    return yield* Effect.fail(
      new GitHubRequestError({
        message: "Could not resolve GitHub repository. Pass --repo owner/repo.",
      }),
    );
  return repo;
});
const optionalText = Schema.optional(Schema.NullOr(Schema.String));
const optionalNumber = Schema.optional(Schema.NullOr(Schema.Number));
const optionalBoolean = Schema.optional(Schema.NullOr(Schema.Boolean));
const repositorySchema = Schema.Struct({
  nameWithOwner: optionalText,
  url: optionalText,
});
const graphCommentSchema = Schema.Struct({
  id: optionalText,
  databaseId: optionalNumber,
  body: optionalText,
  createdAt: optionalText,
  url: optionalText,
  author: Schema.optional(Schema.NullOr(githubCommentAuthorSchema)),
  path: optionalText,
  line: optionalNumber,
  originalLine: optionalNumber,
});
const graphCommentsSchema = Schema.Struct({
  nodes: Schema.mutable(Schema.Array(Schema.NullOr(graphCommentSchema))),
});
const threadSchema = Schema.Struct({
  id: optionalText,
  isResolved: Schema.Boolean,
  isOutdated: optionalBoolean,
  path: optionalText,
  line: optionalNumber,
  startLine: optionalNumber,
  originalLine: optionalNumber,
  comments: Schema.optional(Schema.NullOr(graphCommentsSchema)),
});
const closingIssueSchema = Schema.Struct({
  number: optionalNumber,
  title: optionalText,
  body: optionalText,
  state: optionalText,
  url: optionalText,
  repository: Schema.optional(Schema.NullOr(repositorySchema)),
});
const pullRequestSchema = Schema.Struct({
  id: optionalText,
  number: optionalNumber,
  title: optionalText,
  body: optionalText,
  url: optionalText,
  state: optionalText,
  isDraft: optionalBoolean,
  baseRefName: optionalText,
  headRefName: optionalText,
  baseRefOid: optionalText,
  headRefOid: optionalText,
  baseRepository: Schema.optional(Schema.NullOr(repositorySchema)),
  headRepository: Schema.optional(Schema.NullOr(repositorySchema)),
  author: Schema.optional(Schema.NullOr(githubCommentAuthorSchema)),
  comments: Schema.optional(Schema.NullOr(graphCommentsSchema)),
  closingIssuesReferences: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        nodes: Schema.mutable(Schema.Array(Schema.NullOr(closingIssueSchema))),
      }),
    ),
  ),
  reviewThreads: Schema.Struct({
    nodes: Schema.mutable(Schema.Array(Schema.NullOr(threadSchema))),
    pageInfo: Schema.optional(
      Schema.NullOr(
        Schema.Struct({
          hasNextPage: optionalBoolean,
          endCursor: optionalText,
        }),
      ),
    ),
  }),
});
const feedbackRepositorySchema = Schema.Struct({
  pullRequest: pullRequestSchema,
});
const feedbackPayloadSchema = Schema.Union([
  Schema.Struct({
    data: Schema.Struct({ repository: feedbackRepositorySchema }),
  }),
  Schema.Struct({ repository: feedbackRepositorySchema }),
]);
const decodeFeedback = Schema.decodeUnknownEffect(
  Schema.fromJsonString(feedbackPayloadSchema),
);
export const parsePullRequestFeedback = Effect.fn("parsePullRequestFeedback")(
  function* (
    raw: string,
    input: { repo: string; prNumber: number },
  ): Effect.fn.Return<PullRequestFeedback, GitHubResponseError> {
    const payload = yield* decodeFeedback(raw).pipe(
      Effect.mapError((cause) => new GitHubResponseError({ cause })),
    );
    const pullRequest =
      "data" in payload
        ? payload.data.repository.pullRequest
        : payload.repository.pullRequest;
    const comments = (pullRequest.comments?.nodes ?? [])
      .filter((comment) => comment !== null)
      .map(normalizePullRequestComment);
    const reviewThreads = pullRequest.reviewThreads.nodes
      .filter((thread) => thread !== null)
      .map((thread) => ({
        id: thread.id ?? "",
        isResolved: thread.isResolved,
        isOutdated: thread.isOutdated ?? undefined,
        path: thread.path ?? undefined,
        line: thread.line ?? undefined,
        startLine: thread.startLine ?? undefined,
        originalLine: thread.originalLine ?? undefined,
        comments: (thread.comments?.nodes ?? [])
          .filter((comment) => comment !== null)
          .map((comment) => ({
            ...normalizePullRequestComment(comment),
            path: comment.path ?? undefined,
            line: comment.line ?? undefined,
            originalLine: comment.originalLine ?? undefined,
          })),
      }));
    const closingIssues = (pullRequest.closingIssuesReferences?.nodes ?? [])
      .filter((issue) => issue !== null)
      .map((issue) => ({
        number: issue.number ?? 0,
        title: issue.title ?? "",
        body: issue.body ?? "",
        state: issue.state ?? "UNKNOWN",
        url: issue.url ?? undefined,
        repository: issue.repository?.nameWithOwner ?? undefined,
      }));
    return withPlannerComments(
      {
        repo: input.repo,
        pr: {
          id: pullRequest.id ?? undefined,
          number: pullRequest.number ?? input.prNumber,
          title: pullRequest.title ?? "",
          body: pullRequest.body ?? "",
          url: pullRequest.url ?? undefined,
          state: pullRequest.state ?? "UNKNOWN",
          isDraft: pullRequest.isDraft ?? undefined,
          baseRefName: pullRequest.baseRefName ?? "",
          headRefName: pullRequest.headRefName ?? "",
          baseRefOid: pullRequest.baseRefOid ?? "",
          headRefOid: pullRequest.headRefOid ?? "",
          baseRepository:
            pullRequest.baseRepository?.nameWithOwner ?? undefined,
          baseRepositoryUrl: pullRequest.baseRepository?.url ?? undefined,
          headRepository:
            pullRequest.headRepository?.nameWithOwner ?? undefined,
          author: pullRequest.author?.login ?? undefined,
        },
        comments,
        reviewThreads,
        plannerComments: [],
        excludedRoarkSummaryCommentIds: [],
        closingIssues,
        reviewThreadsTruncated:
          pullRequest.reviewThreads.pageInfo?.hasNextPage === true,
        fetchedAt: DateTime.formatIso(yield* DateTime.now),
      },
      comments,
    );
  },
);

function withPlannerComments(
  feedback: PullRequestFeedback,
  comments: PullRequestComment[],
): PullRequestFeedback {
  const excludedRoarkSummaryCommentIds: (string | number)[] = [];
  const plannerComments = comments.filter((comment) => {
    if (!roarkPrRevisionSummaryMarkerPattern.test(comment.body)) return true;
    excludedRoarkSummaryCommentIds.push(
      comment.databaseId ?? comment.id ?? "unknown",
    );
    return false;
  });
  return {
    ...feedback,
    comments,
    plannerComments,
    excludedRoarkSummaryCommentIds,
  };
}
export const parseRestPullRequestComments = Effect.fn(
  "parseRestPullRequestComments",
)(function* (
  raw: string,
): Effect.fn.Return<PullRequestComment[], GitHubResponseError> {
  return (yield* parseRestCommentPages(raw)).map((comment) => ({
    id: comment.node_id ?? undefined,
    databaseId: comment.id ?? undefined,
    author: comment.user?.login ?? undefined,
    body: comment.body ?? "",
    createdAt: comment.created_at ?? undefined,
    url: comment.html_url ?? undefined,
  }));
});
function normalizePullRequestComment(
  comment: typeof graphCommentSchema.Type,
): PullRequestComment {
  return {
    id: comment.id ?? undefined,
    databaseId: comment.databaseId ?? undefined,
    author: comment.author?.login ?? undefined,
    body: comment.body ?? "",
    createdAt: comment.createdAt ?? undefined,
    url: comment.url ?? undefined,
  };
}

function splitRepo(repo: string): [string, string] {
  const match = /^([^/]+)\/([^/]+)$/.exec(repo);
  if (!match?.[1] || !match[2])
    throw new Error(`Repository must be in owner/repo format. Got '${repo}'.`);
  return [match[1], match[2]];
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
      baseRefOid
      headRefOid
      baseRepository { nameWithOwner url }
      headRepository { nameWithOwner }
      author { login }
      closingIssuesReferences(first: 100) {
        nodes {
          number
          title
          body
          state
          url
          repository { nameWithOwner }
        }
      }
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
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;
