import { describe, expect, test } from "bun:test";
import { Cause, Deferred, Effect, Exit, PlatformError } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { fetchGitHubIssue } from "../github/issue.ts";
import { ProcessExecutionError } from "../cli/process.ts";
import { applicationLayer, fromLegacyPromise, runApplicationPromise, type ApplicationExecution } from "./application.ts";

describe("explicit application scope", () => {
  test("a Promise workflow uses its caller's process service", async () => {
    const failure = PlatformError.systemError({ _tag: "PermissionDenied", module: "ChildProcess", method: "spawn" });
    const spawner = ChildProcessSpawner.make(() => Effect.fail(failure));
    const exit = await Effect.runPromiseExit(fromLegacyPromise((application) =>
      fetchGitHubIssue("1", { cwd: process.cwd(), repo: "owner/repo" }, application)
    ).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provide(applicationLayer),
    ));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const error = Cause.squash(exit.cause);
      expect(error).toBeInstanceOf(ProcessExecutionError);
      if (error instanceof ProcessExecutionError) expect(error.cause).toBe(failure);
    }
  });

  test("scope completion interrupts and joins a child even when its Promise was not awaited", async () => {
    const started = Deferred.makeUnsafe<undefined>();
    let released = false;
    await Effect.runPromise(fromLegacyPromise(async (application) => {
      const child = runApplicationPromise(Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.ensuring(Effect.sync(() => { released = true; })),
      ), application);
      void child.catch(() => undefined);
      await Effect.runPromise(Deferred.await(started));
    }).pipe(Effect.provide(applicationLayer)));
    expect(released).toBe(true);
  });

  test("work cannot start through an execution value after its owner scope closes", async () => {
    let application: ApplicationExecution | undefined;
    await Effect.runPromise(fromLegacyPromise((value) => {
      application = value;
      return Promise.resolve();
    }).pipe(Effect.provide(applicationLayer)));
    if (!application) throw new Error("Expected the explicit execution value.");
    let started = false;
    const result = await runApplicationPromise(Effect.sync(() => { started = true; }), application).then(
      () => "completed",
      () => "interrupted",
    );
    expect(result).toBe("interrupted");
    expect(started).toBe(false);
  });
});
