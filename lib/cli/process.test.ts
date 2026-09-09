import {
  runApplicationPromise,
  applicationLayer,
} from "../runtime/application.ts";
import {
  runProcess,
  runProcessOrThrow,
  executeProcess,
  InvalidProcessCommandError,
  ProcessExecutionError,
  ProcessExitError,
} from "./process.ts";
import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Effect, Result } from "effect";
async function waitForPid(file: string): Promise<number> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const value = await readFile(file, "utf8").catch(() => "");
    if (/^\d+\n$/.test(value)) return Number(value);
    await Bun.sleep(10);
  }
  throw new Error(`Child did not start: ${file}`);
}
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
async function expectStopped(pid: number): Promise<void> {
  const deadline = Date.now() + 1000;
  while (isAlive(pid) && Date.now() < deadline) await Bun.sleep(10);
  expect(isAlive(pid)).toBe(false);
}
function killIfAlive(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* Already reaped. */
  }
}
describe("Effect process execution", () => {
  test("preserves stdin, Unicode output, stderr, inherited environment and cwd", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "roark-process-"));
    const input = "hello 🦊\n".repeat(20000);
    try {
      const result = await runApplicationPromise(
        runProcess(
          [
            process.execPath,
            "-e",
            `
        const input = await Bun.stdin.text();
        process.stdout.write(JSON.stringify({ input, cwd: process.cwd(), path: process.env.PATH }));
        process.stderr.write("diagnostic 🦊");
      `,
          ],
          { cwd, input },
        ),
      );
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        input,
        cwd: await realpath(cwd),
        path: process.env["PATH"],
      });
      expect(result.stderr).toBe("diagnostic 🦊");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
  test("closes absent stdin and retains nonzero exits until explicitly rejected", async () => {
    expect(
      await runApplicationPromise(
        runProcess(["sh", "-c", "cat; printf failure >&2; exit 7"], {}),
      ),
    ).toEqual({ stdout: "", stderr: "failure", exitCode: 7 });
    expect(
      runApplicationPromise(
        runProcessOrThrow(["sh", "-c", "printf failure >&2; exit 7"], {
          label: "verification",
        }),
      ),
    ).rejects.toBeInstanceOf(ProcessExitError);
  });
  test("rejects when the child exits before stdin can be delivered", async () => {
    const result = await runApplicationPromise(
      runProcess(["sh", "-c", "exit 0"], {
        input: "x".repeat(10000000),
      }),
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(result).toBeInstanceOf(ProcessExecutionError);
  });
  test("returns signal exit codes", async () => {
    expect(
      (
        await runApplicationPromise(
          runProcess(["sh", "-c", "kill -TERM $$"], {}),
        )
      ).exitCode,
    ).toBe(143);
  });
  test("distinguishes invalid input from a missing executable with typed platform details", async () => {
    for (const args of [[], [""], ["roark-command-that-does-not-exist"]]) {
      const result = await Effect.runPromise(
        executeProcess(args).pipe(
          Effect.result,
          Effect.provide(applicationLayer),
        ),
      );
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        if (!args[0]) {
          expect(result.failure).toBeInstanceOf(InvalidProcessCommandError);
        } else {
          expect(result.failure._tag).toBe("ProcessExecutionError");
          if (result.failure._tag === "ProcessExecutionError") {
            expect(result.failure.args).toEqual(args);
            expect(result.failure.cause.reason._tag).toBe("NotFound");
            expect(result.failure.cause.reason.module).toBe("ChildProcess");
            expect(result.failure.cause.reason.method).toBe("spawn");
          }
        }
      }
    }
  });
  test("retains both output streams on timeout and kills the descendant", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "roark-timeout-"));
    let pid: number | undefined;
    try {
      const result = await Effect.runPromise(
        executeProcess(
          [
            "sh",
            "-c",
            "printf before; printf diagnostic >&2; sleep 30 & echo $! > child.pid; wait",
          ],
          { cwd, timeoutMs: 200 },
        ).pipe(Effect.provide(applicationLayer)),
      );
      pid = await waitForPid(path.join(cwd, "child.pid"));
      expect(result).toEqual({
        stdout: "before",
        stderr: "diagnostic",
        exitCode: 137,
        timedOut: true,
      });
      await expectStopped(pid);
    } finally {
      killIfAlive(pid);
      await rm(cwd, { recursive: true, force: true });
    }
  });
  for (const parentExit of [false, true]) {
    test(`interruption through a legacy caller cleans descendants when parent ${parentExit ? "has exited" : "is alive"}`, async () => {
      const cwd = await mkdtemp(path.join(tmpdir(), "roark-interrupt-"));
      const controller = new AbortController();
      let pid: number | undefined;
      const running = Effect.runPromiseExit(
        Effect.gen(function* () {
          return yield* runProcess(
            [
              "sh",
              "-c",
              `sleep 30 & echo $! > child.pid; ${parentExit ? "exit 0" : "wait"}`,
            ],
            { cwd },
          );
        }).pipe(Effect.provide(applicationLayer)),
        { signal: controller.signal },
      );
      try {
        pid = await waitForPid(path.join(cwd, "child.pid"));
        controller.abort();
        expect((await running)._tag).toBe("Failure");
        await expectStopped(pid);
      } finally {
        controller.abort();
        killIfAlive(pid);
        await running;
        await rm(cwd, { recursive: true, force: true });
      }
    });
  }
});
