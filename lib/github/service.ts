import * as publishing from "./pr-publishing.ts";
import { Context, Effect, Layer } from "effect";
import type { GitHubRequirements } from "./errors.ts";
import * as issue from "./issue.ts";
import * as comments from "./comments.ts";
import * as pr from "./pr.ts";
import * as labels from "./labels.ts";

const operations = {
  createPullRequest: publishing.createPullRequest,
  updatePullRequest: publishing.updatePullRequest,
  listOpenGitHubIssues: issue.listOpenGitHubIssues,
  getCurrentGitHubLogin: issue.getCurrentGitHubLogin,
  claimGitHubIssue: issue.claimGitHubIssue,
  transitionGitHubIssueLabels: issue.transitionGitHubIssueLabels,
  fetchGitHubIssue: issue.fetchGitHubIssue,
  resolveGitHubIssueRepo: issue.resolveGitHubIssueRepo,
  fetchGitHubIssueRelationships: issue.fetchGitHubIssueRelationships,
  postIssueComment: comments.postIssueComment,
  updateIssueComment: comments.updateIssueComment,
  postOrUpdateIssueCommentByMarker: comments.postOrUpdateIssueCommentByMarker,
  fetchPullRequestFeedback: pr.fetchPullRequestFeedback,
  resolvePullRequestRepo: pr.resolvePullRequestRepo,
  ensureGitHubLabels: labels.ensureGitHubLabels,
  listGitHubLabelNames: labels.listGitHubLabelNames,
  addIssueLabel: labels.addIssueLabel,
  removeIssueLabel: labels.removeIssueLabel,
};

export class GitHub extends Context.Service<
  GitHub,
  {
    [K in keyof typeof operations]: (
      ...args: Parameters<(typeof operations)[K]>
    ) => Effect.Effect<
      Effect.Success<ReturnType<(typeof operations)[K]>>,
      Effect.Error<ReturnType<(typeof operations)[K]>>
    >;
  }
>()("roark/github/GitHub") {}

export const gitHubLayer = Layer.effect(
  GitHub,
  Effect.gen(function* () {
    const context = yield* Effect.context<GitHubRequirements>();
    return GitHub.of({
      createPullRequest: (...args) =>
        operations.createPullRequest(...args).pipe(Effect.provide(context)),
      updatePullRequest: (...args) =>
        operations.updatePullRequest(...args).pipe(Effect.provide(context)),
      addIssueLabel: (...args) =>
        operations.addIssueLabel(...args).pipe(Effect.provide(context)),
      removeIssueLabel: (...args) =>
        operations.removeIssueLabel(...args).pipe(Effect.provide(context)),
      listOpenGitHubIssues: (...args) =>
        operations.listOpenGitHubIssues(...args).pipe(Effect.provide(context)),
      getCurrentGitHubLogin: (...args) =>
        operations.getCurrentGitHubLogin(...args).pipe(Effect.provide(context)),
      claimGitHubIssue: (...args) =>
        operations.claimGitHubIssue(...args).pipe(Effect.provide(context)),
      transitionGitHubIssueLabels: (...args) =>
        operations
          .transitionGitHubIssueLabels(...args)
          .pipe(Effect.provide(context)),
      fetchGitHubIssue: (...args) =>
        operations.fetchGitHubIssue(...args).pipe(Effect.provide(context)),
      resolveGitHubIssueRepo: (...args) =>
        operations
          .resolveGitHubIssueRepo(...args)
          .pipe(Effect.provide(context)),
      fetchGitHubIssueRelationships: (...args) =>
        operations
          .fetchGitHubIssueRelationships(...args)
          .pipe(Effect.provide(context)),
      postIssueComment: (...args) =>
        operations.postIssueComment(...args).pipe(Effect.provide(context)),
      updateIssueComment: (...args) =>
        operations.updateIssueComment(...args).pipe(Effect.provide(context)),
      postOrUpdateIssueCommentByMarker: (...args) =>
        operations
          .postOrUpdateIssueCommentByMarker(...args)
          .pipe(Effect.provide(context)),
      fetchPullRequestFeedback: (...args) =>
        operations
          .fetchPullRequestFeedback(...args)
          .pipe(Effect.provide(context)),
      resolvePullRequestRepo: (...args) =>
        operations
          .resolvePullRequestRepo(...args)
          .pipe(Effect.provide(context)),
      ensureGitHubLabels: (...args) =>
        operations.ensureGitHubLabels(...args).pipe(Effect.provide(context)),
      listGitHubLabelNames: (...args) =>
        operations.listGitHubLabelNames(...args).pipe(Effect.provide(context)),
    });
  }),
);
