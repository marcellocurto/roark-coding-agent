import type { GitHubError } from "../github/errors.ts";
import { Context, Effect, Layer } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process";
import { type GitHub } from "../github/service.ts";
import { type IssuePublishRequest, type IssuePublishResult } from "./github.ts";
import { publishIssueWithGitHub } from "./github.ts";
import { ensureReviewerIssueLabels } from "../issue-curation/labels.ts";

export class IssuePublishing extends Context.Service<
  IssuePublishing,
  {
    publish(
      request: IssuePublishRequest,
    ): Effect.Effect<
      IssuePublishResult,
      Effect.Error<ReturnType<typeof publishIssueWithGitHub>>
    >;
    ensureLabels(options: {
      cwd: string;
      repo?: string | undefined;
    }): Effect.Effect<void, GitHubError>;
  }
>()("roark/issue-publishing/IssuePublishing") {}

export const issuePublishingLayer = Layer.effect(
  IssuePublishing,
  Effect.gen(function* () {
    const services = yield* Effect.context<
      GitHub | ChildProcessSpawner.ChildProcessSpawner
    >();
    return IssuePublishing.of({
      publish: (request) =>
        publishIssueWithGitHub(request).pipe(Effect.provide(services)),
      ensureLabels: (options) =>
        ensureReviewerIssueLabels(options).pipe(
          Effect.asVoid,
          Effect.provide(services),
        ),
    });
  }),
);
