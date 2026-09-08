import { runProcess, ProcessExecutionError } from "../cli/process.ts";
import { describe, expect, test } from "bun:test";
import { Cause, Effect, Exit, PlatformError } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { applicationLayer } from "./application.ts";
describe("application services", () => {
  test("native operations use their caller's process service", async () => {
    const failure = PlatformError.systemError({
      _tag: "PermissionDenied",
      module: "ChildProcess",
      method: "spawn",
    });
    const spawner = ChildProcessSpawner.make(() => Effect.fail(failure));
    const exit = await Effect.runPromiseExit(
      runProcess(["unused"], { cwd: process.cwd() }).pipe(
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
});
