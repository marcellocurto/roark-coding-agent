import { describe, expect, test } from "bun:test";
import { Cause, Context, Deferred, Effect, Exit, PlatformError } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { ProcessExecutionError } from "../cli/process.ts";
import { runProcessPromise } from "../cli/process-promise.ts";
import {
  applicationLayer,
  fromLegacyPromise,
  runApplicationPromise,
  type ApplicationExecution,
} from "./application.ts";

describe("explicit application scope", () => {
  test("a Promise workflow uses its caller's process service", async () => {
    const failure = PlatformError.systemError({
      _tag: "PermissionDenied",
      module: "ChildProcess",
      method: "spawn",
    });
    const spawner = ChildProcessSpawner.make(() => Effect.fail(failure));
    const exit = await Effect.runPromiseExit(
      fromLegacyPromise((application) =>
        runProcessPromise(["unused"], { cwd: process.cwd() }, application),
      ).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provide(applicationLayer),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const error = Cause.squash(exit.cause);
      expect(error).toBeInstanceOf(ProcessExecutionError);
      if (error instanceof ProcessExecutionError)
        expect(error.cause).toBe(failure);
    }
  });

  test("scope completion interrupts and joins a child even when its Promise was not awaited", async () => {
    const started = Deferred.makeUnsafe<undefined>();
    let released = false;
    await Effect.runPromise(
      fromLegacyPromise(async (application) => {
        const child = runApplicationPromise(
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(
              Effect.sync(() => {
                released = true;
              }),
            ),
          ),
          application,
        );
        void child.catch(() => undefined);
        await Effect.runPromise(Deferred.await(started));
      }).pipe(Effect.provide(applicationLayer)),
    );
    expect(released).toBe(true);
  });

  test("work cannot start through an execution value after its owner scope closes", async () => {
    let application: ApplicationExecution | undefined;
    await Effect.runPromise(
      fromLegacyPromise((value) => {
        application = value;
        return Promise.resolve();
      }).pipe(Effect.provide(applicationLayer)),
    );
    if (!application) throw new Error("Expected the explicit execution value.");
    let started = false;
    const result = await runApplicationPromise(
      Effect.sync(() => {
        started = true;
      }),
      application,
    ).then(
      () => "completed",
      () => "interrupted",
    );
    expect(result).toBe("interrupted");
    expect(started).toBe(false);
  });
});

describe("Effect causes across Promise boundaries", () => {
  test("preserves defects across nested bridges and bypasses ordinary error recovery", async () => {
    const defect = new Error("unexpected defect");
    let recovered = false;
    const exit = await Effect.runPromiseExit(
      fromLegacyPromise((application) =>
        runApplicationPromise(
          fromLegacyPromise((inner) =>
            runApplicationPromise(Effect.die(defect), inner),
          ),
          application,
        ),
      ).pipe(
        Effect.catch(() => {
          recovered = true;
          return Effect.void;
        }),
        Effect.provide(applicationLayer),
      ),
    );
    expect(recovered).toBe(false);
    expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
    expect(Exit.isFailure(exit) && Cause.hasFails(exit.cause)).toBe(false);
    if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBe(defect);
  });

  test("preserves combined reasons and their annotations", async () => {
    const phase = Context.Reference<string>("test/phase", {
      defaultValue: () => "",
    });
    const original = Cause.fromReasons([
      Cause.makeFailReason(new Error("operation failed")).annotate(
        Context.make(phase, "verification"),
      ),
      Cause.makeDieReason(new Error("cleanup defect")),
      Cause.makeInterruptReason(123),
    ]);
    const exit = await Effect.runPromiseExit(
      fromLegacyPromise((application) =>
        runApplicationPromise(Effect.failCause(original), application),
      ).pipe(Effect.provide(applicationLayer)),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit))
      expect(exit.cause.reasons).toEqual(original.reasons);
  });

  test("preserves interruption as interruption rather than an ordinary failure", async () => {
    const exit = await Effect.runPromiseExit(
      fromLegacyPromise((application) =>
        runApplicationPromise(
          Effect.failCause(Cause.interrupt(321)),
          application,
        ),
      ).pipe(Effect.provide(applicationLayer)),
    );
    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(
      true,
    );
    if (Exit.isFailure(exit))
      expect(exit.cause.reasons).toEqual(Cause.interrupt(321).reasons);
  });

  test("retains both the operation failure and a finalizer defect", async () => {
    const failure = new Error("operation failure");
    const defect = new Error("finalizer defect");
    const operation = Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.addFinalizer(() => Effect.die(defect));
        return yield* Effect.fail(failure);
      }),
    );
    const direct = await Effect.runPromiseExit(operation);
    const bridged = await Effect.runPromiseExit(
      fromLegacyPromise((application) =>
        runApplicationPromise(operation, application),
      ).pipe(Effect.provide(applicationLayer)),
    );
    expect(Exit.isFailure(bridged)).toBe(true);
    if (Exit.isFailure(direct) && Exit.isFailure(bridged)) {
      expect(bridged.cause.reasons).toEqual(direct.cause.reasons);
      expect(Cause.hasFails(bridged.cause)).toBe(true);
      expect(Cause.hasDies(bridged.cause)).toBe(true);
    }
  });

  test("preserves ordinary typed error identity through the round trip", async () => {
    const error = new ProcessExecutionError({
      args: ["test"],
      cause: PlatformError.systemError({
        _tag: "NotFound",
        module: "ChildProcess",
        method: "spawn",
      }),
    });
    const received = await Effect.runPromise(
      fromLegacyPromise((application) =>
        runApplicationPromise(Effect.fail(error), application),
      ).pipe(Effect.provide(applicationLayer)),
    ).catch((failure: unknown) => failure);
    expect(received).toBe(error);
  });

  test("keeps unrelated Promise rejections in the typed error channel", async () => {
    const error = new Error("foreign rejection", {
      cause: Cause.die("not a bridge carrier"),
    });
    const exit = await Effect.runPromiseExit(
      fromLegacyPromise(() => Promise.reject(error)).pipe(
        Effect.provide(applicationLayer),
      ),
    );
    expect(Exit.isFailure(exit) && Cause.hasFails(exit.cause)).toBe(true);
    expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(false);
    if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBe(error);
  });
});

test("interruption waits for the Promise cancellation acknowledgement after child cleanup", async () => {
  const started = Deferred.makeUnsafe<undefined>();
  const cleanupStarted = Deferred.makeUnsafe<undefined>();
  const allowCleanup = Deferred.makeUnsafe<undefined>();
  const controller = new AbortController();
  let childFinished = false;
  let cleanupFinished = false;
  let ownerFinished = false;
  let cleanupSawFinishedChild = false;
  const running = Effect.runPromiseExit(
    fromLegacyPromise(async (application) => {
      try {
        await runApplicationPromise(
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(
              Effect.sync(() => {
                childFinished = true;
              }),
            ),
          ),
          application,
        );
      } finally {
        cleanupSawFinishedChild = childFinished;
        await Effect.runPromise(Deferred.succeed(cleanupStarted, undefined));
        await Effect.runPromise(Deferred.await(allowCleanup));
        cleanupFinished = true;
      }
    }).pipe(Effect.provide(applicationLayer)),
    { signal: controller.signal },
  ).then((exit) => {
    ownerFinished = true;
    return exit;
  });
  await Effect.runPromise(Deferred.await(started));
  controller.abort();
  await Effect.runPromise(Deferred.await(cleanupStarted));
  expect(cleanupSawFinishedChild).toBe(true);
  expect(ownerFinished).toBe(false);
  await Effect.runPromise(Deferred.succeed(allowCleanup, undefined));
  const exit = await running;
  expect(cleanupFinished).toBe(true);
  expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(
    true,
  );
});
