import * as BunServices from "@effect/platform-bun/BunServices";
import { AsyncLocalStorage } from "node:async_hooks";
import { Effect, type Context } from "effect";

export const applicationLayer = BunServices.layer;
type ApplicationServices = BunServices.BunServices;

interface LegacyExecution {
  context: Context.Context<ApplicationServices>;
  signal: AbortSignal;
  pending: Set<Promise<unknown>>;
}

// Temporary migration boundary: remove this storage and the Promise bridges when
// workflow callers compose Effects directly. Nested migrated operations inherit
// the application's services and interruption, rather than starting detached work.
const legacyExecution = new AsyncLocalStorage<LegacyExecution>();

export function fromLegacyPromise<A>(work: () => Promise<A>) {
  return Effect.gen(function*() {
    const context = yield* Effect.context<ApplicationServices>();
    return yield* Effect.callback<A, unknown>((resume, signal) => {
      const execution: LegacyExecution = { context, signal, pending: new Set() };
      try {
        const result = legacyExecution.run(execution, work);
        void result.then(
          (value) => { resume(Effect.succeed(value)); },
          (error: unknown) => { resume(Effect.fail(error)); },
        );
      } catch (error) {
        resume(Effect.fail(error));
      }
      // The callback's signal is aborted before this interruption finalizer.
      // Wait for migrated children to finish their scoped cleanup before exit.
      return Effect.promise(async () => {
        await Promise.allSettled(execution.pending);
      });
    });
  });
}

export function runApplicationPromise<A, E>(effect: Effect.Effect<A, E, ApplicationServices>): Promise<A> {
  const execution = legacyExecution.getStore();
  if (!execution) return Effect.runPromise(Effect.provide(effect, applicationLayer));
  const promise = Effect.runPromiseWith(execution.context)(effect, { signal: execution.signal });
  execution.pending.add(promise);
  void promise.then(
    () => { execution.pending.delete(promise); },
    () => { execution.pending.delete(promise); },
  );
  return promise;
}
