import {
  runApplicationPromise,
  applicationLayer,
} from "../runtime/application.ts";
import * as nativeVerification from "./verification.ts";
import {
  artifactExists,
  readArtifact,
  createWorkflowContext,
  verificationBeforeFixFullRef,
} from "../workflow/artifacts.ts";
import { Presentation, Verification } from "../runtime/services.ts";
import { Cause, Deferred, Effect, Exit, PlatformError } from "effect";
import { TestClock } from "effect/testing";
import { ProcessExecutionError } from "../cli/process.ts";
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Presenter } from "../presentation/presenter.ts";
import {
  classifyVerificationFailure,
  formatCompleteVerificationArtifact,
  formatVerificationArtifact,
  parseVerificationArtifact,
  runVerification,
  verificationFailureReason,
  type VerificationResult,
} from "./verification.ts";
describe("autorun verification", () => {
  test("classifies a timeout as failure even when the shell exited zero", () => {
    expect(
      classifyVerificationFailure({
        command: "sleep 30 & exit 0",
        ok: false,
        exitCode: 0,
        stdout: "",
        stderr: "Timed out",
        timedOut: true,
      }).reason,
    ).toBe("verification timed out");
  });
  test("announces verification before waiting for the service", async () => {
    let output = "";
    const presentation = new Presenter({
      stream: {
        isTTY: true,
        columns: 80,
        write(chunk) {
          output += chunk;
        },
      },
      env: { TERM: "xterm" },
    });
    const started = Deferred.makeUnsafe<undefined>();
    const result = Deferred.makeUnsafe<VerificationResult>();
    const running = Effect.runPromise(
      runVerification({
        command: "bun test",
        cwd: "/tmp/wt",
        display: {
          target: "PR #12",
          repository: "owner/repo",
          revision: 2,
          pass: 1,
        },
      }).pipe(
        Effect.provideService(Verification, {
          execute: () =>
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Deferred.await(result)),
            ),
        }),
        Effect.provideService(Presentation, presentation),
        Effect.provide(applicationLayer),
      ),
    );
    await Effect.runPromise(Deferred.await(started));
    expect(output).toContain("PR #12 · Verification · r2 · p1 · repo");
    expect(output).not.toContain("PASSED");
    await Effect.runPromise(
      Deferred.succeed(result, {
        ok: true,
        command: "bun test",
        exitCode: 0,
        stdout: "",
        stderr: "",
      }),
    );
    await running;
    expect(output).toContain("VERIFY PASSED");
  });
  test("returns successful and failed verification results unchanged", async () => {
    for (const result of [
      { ok: true, command: "check", exitCode: 0, stdout: "passed", stderr: "" },
      { ok: false, command: "check", exitCode: 2, stdout: "", stderr: "boom" },
    ]) {
      expect(
        await Effect.runPromise(
          runVerification({ command: "check", cwd: "/tmp/wt" }).pipe(
            Effect.provideService(Verification, {
              execute: () => Effect.succeed(result),
            }),
            Effect.provide(applicationLayer),
          ),
        ),
      ).toEqual(result);
    }
  });
  test("typed failures are presented with elapsed time and retain identity", async () => {
    let output = "";
    const presentation = new Presenter({
      stream: {
        isTTY: false,
        write(chunk) {
          output += chunk;
        },
      },
    });
    const failure = new ProcessExecutionError({
      args: ["bun", "test"],
      cause: PlatformError.systemError({
        _tag: "NotFound",
        module: "ChildProcess",
        method: "spawn",
        description: "spawn failed\u001b]0;owned",
      }),
    });
    const received = await Effect.runPromise(
      runVerification({ command: "bun test", cwd: "/tmp/wt" }).pipe(
        Effect.provideService(Verification, {
          execute: () =>
            TestClock.adjust(250).pipe(Effect.andThen(Effect.fail(failure))),
        }),
        Effect.provideService(Presentation, presentation),
        Effect.provide(TestClock.layer()),
        Effect.provide(applicationLayer),
      ),
    ).catch((error: unknown) => error);
    expect(received).toBe(failure);
    expect(output).toContain("VERIFY FAILED");
    expect(output).toContain("250ms");
    expect(output).not.toContain("\u001b]0;owned");
  });
  test("interruption waits for cleanup without reporting an execution failure", async () => {
    let output = "";
    let released = false;
    const started = Deferred.makeUnsafe<undefined>();
    const controller = new AbortController();
    const running = Effect.runPromiseExit(
      runVerification({ command: "bun test", cwd: "/tmp/wt" }).pipe(
        Effect.provideService(Verification, {
          execute: () =>
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(
                Effect.sync(() => {
                  released = true;
                }),
              ),
            ),
        }),
        Effect.provideService(
          Presentation,
          new Presenter({
            stream: {
              isTTY: false,
              write(chunk) {
                output += chunk;
              },
            },
          }),
        ),
        Effect.provide(applicationLayer),
      ),
      { signal: controller.signal },
    );
    await Effect.runPromise(Deferred.await(started));
    controller.abort();
    const exit = await running;
    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(
      true,
    );
    expect(released).toBe(true);
    expect(output).not.toContain("VERIFY FAILED");
  });
  test("service defects remain defects", async () => {
    const exit = await Effect.runPromiseExit(
      runVerification({ command: "bun test", cwd: "/tmp/wt" }).pipe(
        Effect.provideService(Verification, {
          execute: () => Effect.die(new Error("defect")),
        }),
        Effect.provide(applicationLayer),
      ),
    );
    expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
    expect(Exit.isFailure(exit) && Cause.hasFails(exit.cause)).toBe(false);
  });
  test("default verification terminates the process tree when a command exceeds its timeout", async () => {
    const startedAt = Date.now();
    const result = await runApplicationPromise(
      nativeVerification.runVerification({
        command: "sh -c 'sleep 2 & wait'",
        cwd: "/tmp",
        timeoutMs: 10,
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(classifyVerificationFailure(result).reason).toBe(
      "verification timed out",
    );
  });
  test("formatVerificationArtifact includes command, exit code, and outputs", () => {
    const result: VerificationResult = {
      ok: false,
      command: "bun run typecheck",
      exitCode: 1,
      stdout: "out-line",
      stderr: "err-line",
    };
    const artifact = formatVerificationArtifact(result);
    expect(artifact).toContain("# Verification");
    expect(artifact).toContain("`bun run typecheck`");
    expect(artifact).toContain("## Exit Code\n1");
    expect(artifact).toContain("out-line");
    expect(artifact).toContain("err-line");
  });
  test("formatVerificationArtifact tail-truncates very long output", () => {
    const long = `diagnostic-at-start\n${"a".repeat(10000)}\ndiagnostic-at-end`;
    const result: VerificationResult = {
      ok: false,
      command: "noisy",
      exitCode: 1,
      stdout: long,
      stderr: "",
    };
    const artifact = formatVerificationArtifact(result);
    const completeArtifact = formatCompleteVerificationArtifact(result);
    expect(artifact).toContain("(truncated");
    expect(artifact.length).toBeLessThan(long.length + 600);
    expect(artifact).not.toContain("diagnostic-at-start");
    expect(completeArtifact).toContain("diagnostic-at-start");
    expect(completeArtifact).toContain("diagnostic-at-end");
    expect(completeArtifact).not.toContain("(truncated");
  });
  test("writes complete verification companions through the workflow artifact catalog", async () => {
    const cwd = await mkdtemp(
      path.join(tmpdir(), "roark-verification-artifacts-"),
    );
    const context = createWorkflowContext({
      command: "do",
      issue: "1",
      cwd,
      outDir: ".roark/runs",
      force: false,
      yes: false,
      maxFixPasses: 1,
    });
    const result: VerificationResult = {
      ok: false,
      command: "bun test",
      exitCode: 1,
      stdout: "complete stdout",
      stderr: "complete stderr",
    };
    try {
      await runApplicationPromise(
        nativeVerification.writeVerificationArtifact(context, result),
      );
      await runApplicationPromise(
        nativeVerification.writeVerificationBeforeFixArtifact(
          context,
          2,
          result,
        ),
      );
      expect(
        await runApplicationPromise(
          artifactExists(context, "verificationFull"),
        ),
      ).toBe(true);
      expect(
        await runApplicationPromise(
          artifactExists(context, verificationBeforeFixFullRef(2)),
        ),
      ).toBe(true);
      expect(
        await runApplicationPromise(readArtifact(context, "verificationFull")),
      ).toContain("complete stdout");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
  test("classifies command-unavailable failures as non-repairable with hook guidance", () => {
    const classification = classifyVerificationFailure({
      ok: false,
      command: "bun run typecheck",
      exitCode: 127,
      stdout: "",
      stderr: "/bin/bash: tsc: command not found",
    });
    expect(classification.repairable).toBe(false);
    expect(classification.reason).toContain("required command was not found");
    expect(classification.recoveryGuidance).toContain("hooks.beforeVerify");
    expect(
      verificationFailureReason({
        ok: false,
        command: "bun run typecheck",
        exitCode: 127,
        stdout: "",
        stderr: "/bin/bash: tsc: command not found",
      }),
    ).toContain("bun install --frozen-lockfile");
  });
  test("classifies deterministic verification exits as repairable", () => {
    expect(
      classifyVerificationFailure({
        ok: false,
        command: "bun run check",
        exitCode: 1,
        stdout: "",
        stderr: "lint failed",
      }).repairable,
    ).toBe(true);
  });
  test("does not treat generic test not-found output as command unavailable", () => {
    expect(
      classifyVerificationFailure({
        ok: false,
        command: "bun test",
        exitCode: 1,
        stdout: "",
        stderr: "AssertionError: expected element to be not found",
      }).repairable,
    ).toBe(true);
    expect(
      classifyVerificationFailure({
        ok: false,
        command: "bun test",
        exitCode: 1,
        stdout: "",
        stderr: "Error: not found",
      }).repairable,
    ).toBe(true);
  });
  test("parses verification artifacts for continuation planning", () => {
    const parsed = parseVerificationArtifact(
      formatVerificationArtifact({
        ok: false,
        command: "bun run typecheck",
        exitCode: 127,
        stdout: "",
        stderr: "/bin/bash: tsc: command not found",
      }),
    );
    expect(parsed).toEqual({
      ok: false,
      command: "bun run typecheck",
      exitCode: 127,
      stdout: "",
      stderr: "/bin/bash: tsc: command not found",
    });
  });
});
