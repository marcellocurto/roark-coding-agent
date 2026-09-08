import { type AttemptStore, attemptStoreLayer } from "../autorun/attempts.ts";
import {
  type ArtifactStore,
  artifactStoreLayer,
} from "../workflow/artifact-store.ts";
import { agentExecutionLayer } from "../pi/agent.ts";
import { type GitHub, gitHubLayer } from "../github/service.ts";
import type {
  Presentation,
  AgentExecution,
  RepositoryConfiguration,
  Verification,
  ExitNotifications,
} from "./services.ts";
import { presentationLayer } from "../presentation/presenter.ts";
import { repositoryConfigurationLayer } from "../cli/config.ts";
import { verificationLayer } from "../autorun/verification.ts";
import { exitNotificationsLayer } from "../cli/notifications.ts";
import * as BunServices from "@effect/platform-bun/BunServices";
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Schema,
  type Context,
  Scope,
} from "effect";

export const applicationServicesLayer = Layer.suspend(() =>
  Layer.mergeAll(
    exitNotificationsLayer.pipe(
      Layer.provideMerge(repositoryConfigurationLayer),
    ),
    verificationLayer,
    gitHubLayer,
    agentExecutionLayer,
    artifactStoreLayer,
    attemptStoreLayer,
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
  | AttemptStore;

// Only internal Promise hops use this carrier. A rejection value alone cannot
// distinguish typed failure from defect, interruption, or combined failures.
class EffectPromiseFailure extends Schema.TaggedError<EffectPromiseFailure>()(
  "EffectPromiseFailure",
  {
    // This is an in-memory handoff: preserve the Cause object and its annotations.
    cause: Schema.declare(Cause.isCause),
  },
) {
  override get message(): string {
    return (
      Cause.prettyErrors(this.cause)
        .map((error) => error.message)
        .join("\n") || "Effect interrupted"
    );
  }
}

/** Explicit runtime boundary for callers that still return Promises. */
export interface ApplicationExecution {
  readonly services: Context.Context<ApplicationServices>;
  readonly scope: Scope.Scope;
  readonly signal: AbortSignal;
}

export const fromLegacyPromise = Effect.fnUntraced(function* <A>(
  work: (application: ApplicationExecution) => Promise<A>,
): Effect.fn.Return<A, unknown, ApplicationServices | Scope.Scope> {
  const services = yield* Effect.context<ApplicationServices>();
  const scope = yield* Scope.make();
  yield* Effect.addFinalizer((exit) => Scope.close(scope, exit));
  const settled = yield* Deferred.make<undefined>();
  return yield* Effect.callback<A, unknown>((resume, signal) => {
    const resumeFailure = (error: unknown) => {
      Deferred.doneUnsafe(settled, Exit.succeed(undefined));
      resume(
        error instanceof EffectPromiseFailure
          ? Effect.failCause(error.cause)
          : Effect.fail(error),
      );
    };
    try {
      void work({ services, scope, signal }).then((value) => {
        Deferred.doneUnsafe(settled, Exit.succeed(undefined));
        resume(Effect.succeed(value));
      }, resumeFailure);
    } catch (error) {
      resumeFailure(error);
    }
    // A cancelled Promise operation must settle before its owner can finalize.
    // Stop scoped children first, then await the cooperative Promise boundary.
    return Scope.close(scope, Exit.interrupt()).pipe(
      Effect.ensuring(Deferred.await(settled)),
    );
  });
}, Effect.scoped);

export function runApplicationPromise<A, E>(
  effect: Effect.Effect<A, E, ApplicationServices>,
  application?: ApplicationExecution,
): Promise<A> {
  if (!application)
    return Effect.runPromise(Effect.provide(effect, applicationLayer));
  // Child lifetime belongs to the native scope, including after its Promise
  // caller stops awaiting it. Scope closure interrupts and joins finalizers.
  return Effect.runPromiseExitWith(application.services)(
    Effect.forkIn(effect, application.scope).pipe(
      Effect.flatMap((fiber) =>
        Fiber.join(fiber).pipe(
          Effect.onInterrupt(() => Fiber.interrupt(fiber)),
        ),
      ),
    ),
    { signal: application.signal },
  ).then((exit) => {
    if (Exit.isFailure(exit))
      throw new EffectPromiseFailure({ cause: exit.cause });
    return exit.value;
  });
}

/** Inspect legacy diagnostics without discarding the carrier when rethrowing. */
export function applicationFailureCause(error: unknown): Cause.Cause<unknown> {
  return error instanceof EffectPromiseFailure
    ? error.cause
    : Cause.fail(error);
}
