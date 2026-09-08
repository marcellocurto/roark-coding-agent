import * as BunServices from "@effect/platform-bun/BunServices";
import { Effect, Fiber, type Context, type Scope } from "effect";

export const applicationLayer = BunServices.layer;
type ApplicationServices = BunServices.BunServices;

/** Explicit runtime boundary for callers that still return Promises. */
export interface ApplicationExecution {
  readonly services: Context.Context<ApplicationServices>;
  readonly scope: Scope.Scope;
  readonly signal: AbortSignal;
}

export function fromLegacyPromise<A>(work: (application: ApplicationExecution) => Promise<A>) {
  return Effect.scoped(Effect.gen(function*() {
    const services = yield* Effect.context<ApplicationServices>();
    const scope = yield* Effect.scope;
    return yield* Effect.callback<A, unknown>((resume, signal) => {
      try {
        void work({ services, scope, signal }).then(
          (value) => { resume(Effect.succeed(value)); },
          (error: unknown) => { resume(Effect.fail(error)); },
        );
      } catch (error) {
        resume(Effect.fail(error));
      }
    });
  }));
}

export function runApplicationPromise<A, E>(
  effect: Effect.Effect<A, E, ApplicationServices>,
  application?: ApplicationExecution,
): Promise<A> {
  if (!application) return Effect.runPromise(Effect.provide(effect, applicationLayer));
  // Child lifetime belongs to the native scope, including after its Promise
  // caller stops awaiting it. Scope closure interrupts and joins finalizers.
  return Effect.runPromiseWith(application.services)(
    Effect.forkIn(effect, application.scope).pipe(Effect.flatMap(Fiber.join)),
    { signal: application.signal },
  );
}
