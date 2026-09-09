import {
  type RevisionReporting,
  revisionReportingLayer,
} from "../pr-revision/comments.ts";
import {
  type Workspace,
  workspaceLayer,
} from "../autorun/workspace-service.ts";
import {
  type IssuePublishing,
  issuePublishingLayer,
} from "../issue-publishing/service.ts";
import {
  type RunObservation,
  runObservationLayer,
} from "../observability/observer.ts";
import { type AttemptStore, attemptStoreLayer } from "../autorun/attempts.ts";
import {
  type ArtifactStore,
  artifactStoreLayer,
} from "../workflow/artifact-store.ts";
import { agentExecutionLayer } from "../pi/agent.ts";
import { type GitHub, gitHubLayer } from "../github/service.ts";
import {
  type Presentation,
  type AgentExecution,
  type RepositoryConfiguration,
  type Verification,
  type ExitNotifications,
} from "./services.ts";
import { presentationLayer } from "../presentation/presenter.ts";
import { repositoryConfigurationLayer } from "../cli/config.ts";
import { verificationLayer } from "../autorun/verification.ts";
import { exitNotificationsLayer } from "../cli/notifications.ts";
import * as BunServices from "@effect/platform-bun/BunServices";
import { Effect, Layer } from "effect";
export const applicationServicesLayer = Layer.suspend(() =>
  Layer.mergeAll(
    exitNotificationsLayer.pipe(
      Layer.provideMerge(repositoryConfigurationLayer),
    ),
    verificationLayer,
    workspaceLayer,
    revisionReportingLayer.pipe(Layer.provide(gitHubLayer)),
    gitHubLayer,
    agentExecutionLayer,
    artifactStoreLayer,
    attemptStoreLayer,
    runObservationLayer,
    issuePublishingLayer.pipe(Layer.provide(gitHubLayer)),
  ),
);
export const applicationLayer = Layer.suspend(() =>
  applicationServicesLayer.pipe(
    Layer.provideMerge(Layer.mergeAll(BunServices.layer, presentationLayer())),
  ),
);
export type ApplicationServices =
  | BunServices.BunServices
  | Presentation
  | RepositoryConfiguration
  | Verification
  | ExitNotifications
  | GitHub
  | AgentExecution
  | ArtifactStore
  | AttemptStore
  | RunObservation
  | IssuePublishing
  | Workspace
  | RevisionReporting;
/** Run an application Effect at an imperative boundary such as a test or script. */
export function runApplicationPromise<A, E>(
  effect: Effect.Effect<A, E, ApplicationServices>,
): Promise<A> {
  return Effect.runPromise(effect.pipe(Effect.provide(applicationLayer)));
}
