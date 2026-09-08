import { Effect } from "effect";
import { GitHub } from "./service.ts";
import {
  runApplicationPromise,
  type ApplicationExecution,
} from "../runtime/application.ts";

export function listOpenGitHubIssuesPromise(
  options: Parameters<GitHub["Service"]["listOpenGitHubIssues"]>[0],
  application?: ApplicationExecution,
) {
  return runApplicationPromise(
    Effect.flatMap(GitHub, (github) => github.listOpenGitHubIssues(options)),
    application,
  );
}

export function getCurrentGitHubLoginPromise(
  options: Parameters<GitHub["Service"]["getCurrentGitHubLogin"]>[0],
  application?: ApplicationExecution,
) {
  return runApplicationPromise(
    Effect.flatMap(GitHub, (github) => github.getCurrentGitHubLogin(options)),
    application,
  );
}

export function claimGitHubIssuePromise(
  options: Parameters<GitHub["Service"]["claimGitHubIssue"]>[0],
  application?: ApplicationExecution,
) {
  return runApplicationPromise(
    Effect.flatMap(GitHub, (github) => github.claimGitHubIssue(options)),
    application,
  );
}

export function transitionGitHubIssueLabelsPromise(
  options: Parameters<GitHub["Service"]["transitionGitHubIssueLabels"]>[0],
  application?: ApplicationExecution,
) {
  return runApplicationPromise(
    Effect.flatMap(GitHub, (github) =>
      github.transitionGitHubIssueLabels(options),
    ),
    application,
  );
}

export function fetchGitHubIssuePromise(
  input: Parameters<GitHub["Service"]["fetchGitHubIssue"]>[0],
  options: Parameters<GitHub["Service"]["fetchGitHubIssue"]>[1],
  application?: ApplicationExecution,
) {
  return runApplicationPromise(
    Effect.flatMap(GitHub, (github) => github.fetchGitHubIssue(input, options)),
    application,
  );
}

export function resolveGitHubIssueRepoPromise(
  options: Parameters<GitHub["Service"]["resolveGitHubIssueRepo"]>[0],
  application?: ApplicationExecution,
) {
  return runApplicationPromise(
    Effect.flatMap(GitHub, (github) => github.resolveGitHubIssueRepo(options)),
    application,
  );
}

export function fetchGitHubIssueRelationshipsPromise(
  options: Parameters<GitHub["Service"]["fetchGitHubIssueRelationships"]>[0],
  application?: ApplicationExecution,
) {
  return runApplicationPromise(
    Effect.flatMap(GitHub, (github) =>
      github.fetchGitHubIssueRelationships(options),
    ),
    application,
  );
}

export function postIssueCommentPromise(
  options: Parameters<GitHub["Service"]["postIssueComment"]>[0],
  application?: ApplicationExecution,
) {
  return runApplicationPromise(
    Effect.flatMap(GitHub, (github) => github.postIssueComment(options)),
    application,
  );
}

export function updateIssueCommentPromise(
  options: Parameters<GitHub["Service"]["updateIssueComment"]>[0],
  application?: ApplicationExecution,
) {
  return runApplicationPromise(
    Effect.flatMap(GitHub, (github) => github.updateIssueComment(options)),
    application,
  );
}

export function postOrUpdateIssueCommentByMarkerPromise(
  options: Parameters<GitHub["Service"]["postOrUpdateIssueCommentByMarker"]>[0],
  application?: ApplicationExecution,
) {
  return runApplicationPromise(
    Effect.flatMap(GitHub, (github) =>
      github.postOrUpdateIssueCommentByMarker(options),
    ),
    application,
  );
}

export function fetchPullRequestFeedbackPromise(
  options: Parameters<GitHub["Service"]["fetchPullRequestFeedback"]>[0],
  application?: ApplicationExecution,
) {
  return runApplicationPromise(
    Effect.flatMap(GitHub, (github) =>
      github.fetchPullRequestFeedback(options),
    ),
    application,
  );
}

export function resolvePullRequestRepoPromise(
  options: Parameters<GitHub["Service"]["resolvePullRequestRepo"]>[0],
  application?: ApplicationExecution,
) {
  return runApplicationPromise(
    Effect.flatMap(GitHub, (github) => github.resolvePullRequestRepo(options)),
    application,
  );
}

export function ensureGitHubLabelsPromise(
  options: Parameters<GitHub["Service"]["ensureGitHubLabels"]>[0],
  application?: ApplicationExecution,
) {
  return runApplicationPromise(
    Effect.flatMap(GitHub, (github) => github.ensureGitHubLabels(options)),
    application,
  );
}

export function listGitHubLabelNamesPromise(
  options: Parameters<GitHub["Service"]["listGitHubLabelNames"]>[0],
  application?: ApplicationExecution,
) {
  return runApplicationPromise(
    Effect.flatMap(GitHub, (github) => github.listGitHubLabelNames(options)),
    application,
  );
}
