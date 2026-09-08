import { Schema, Cause, Effect, Exit } from "effect";
import {
  runApplicationPromise,
  applicationLayer,
} from "../runtime/application.ts";
import * as nativeVerification from "../autorun/verification.ts";
import {
  InvalidProcessCommandError,
  runProcess,
  runProcessOrThrow,
} from "./process.ts";
import { runWithPresenter } from "../testing/presentation.ts";
import {
  Verification,
  CommandExecution,
  ExitNotifications,
  Presentation,
} from "../runtime/services.ts";
import { type ExitNotificationRequest } from "./notifications.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  main,
  presentAutorunOutcome,
  runCli,
  workflowOutcomeStatus,
} from "../../roark.ts";
import { Presenter } from "../presentation/presenter.ts";
const projectRoot = path.resolve(import.meta.dir, "../..");
const entrypoint = path.join(projectRoot, "roark.ts");
const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
describe("CLI lifecycle services", () => {
  test.each([false, true])(
    "verification defects bypass ordinary CLI failure handling (expected failure: %s)",
    async (withFailure) => {
      const defect = new Error("verification service defect");
      let output = "";
      let notified = false;
      const stream = {
        isTTY: false,
        write(chunk: string) {
          output += chunk;
        },
      };
      const exit = await Effect.runPromiseExit(
        runCli(["do", "1"]).pipe(
          Effect.provideService(CommandExecution, {
            execute: () =>
              Effect.gen(function* () {
                yield* nativeVerification.runVerification({
                  command: "unused",
                  cwd: process.cwd(),
                });
              }),
          }),
          Effect.provideService(Verification, {
            execute: () =>
              withFailure
                ? Effect.fail(
                    new InvalidProcessCommandError({ args: [] }),
                  ).pipe(Effect.ensuring(Effect.die(defect)))
                : Effect.die(defect),
          }),
          Effect.provideService(ExitNotifications, {
            send: () =>
              Effect.sync(() => {
                notified = true;
              }),
            deliver: () => Effect.void,
          }),
          Effect.provideService(
            Presentation,
            new Presenter({ stream, errorStream: stream }),
          ),
          Effect.provide(applicationLayer),
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.hasDies(exit.cause)).toBe(true);
        expect(Cause.hasFails(exit.cause)).toBe(withFailure);
        expect(Cause.pretty(exit.cause)).toContain(defect.message);
        if (withFailure)
          expect(Cause.pretty(exit.cause)).toContain("A command is required.");
        else expect(Cause.squash(exit.cause)).toBe(defect);
      }
      expect(output).not.toContain("run failed");
      expect(output).not.toContain(defect.message);
      expect(notified).toBe(false);
    },
  );
  test("invalid issue input reports failure and sends one failure notification", async () => {
    const notices: ExitNotificationRequest[] = [];
    let output = "";
    const stream = {
      isTTY: false,
      write(chunk: string) {
        output += chunk;
      },
    };
    const argv = ["do", "not-an-issue", "--repo", "owner/repo"];
    const code = await Effect.runPromise(
      runCli(argv).pipe(
        Effect.provideService(CommandExecution, { execute: main }),
        Effect.provideService(ExitNotifications, {
          send: (request) =>
            Effect.sync(() => {
              notices.push(request);
            }),
          deliver: () => Effect.void,
        }),
        Effect.provideService(
          Presentation,
          new Presenter({ stream, errorStream: stream }),
        ),
        Effect.provide(applicationLayer),
      ),
    );
    expect(code).toBe(1);
    expect(output).toContain("Could not parse issue 'not-an-issue'.");
    expect(notices).toEqual([{ argv, succeeded: false }]);
  });
  test("presents published and stopped outcomes distinctly", async () => {
    let output = "";
    await runWithPresenter(
      new Presenter({
        stream: {
          isTTY: false,
          write(chunk) {
            output += chunk;
          },
        },
      }),
      Effect.gen(function* () {
        yield* presentAutorunOutcome({
          issueNumber: 1,
          outcome: "published" as const,
          outcomeDetail: null,
        });
        yield* presentAutorunOutcome({
          issueNumber: 2,
          outcome: "triage-stopped" as const,
          outcomeDetail: "not actionable",
        });
        expect(workflowOutcomeStatus("review-blocked")).toBe("BLOCKED");
        yield* Effect.void;
      }),
    );
    expect(output).toContain("SUCCESS #1 · published");
    expect(output).toContain("STOPPED #2 · not actionable");
  });
  test("preserves a discovered target and notifies once after an execution failure", async () => {
    let output = "";
    const presentation = new Presenter({
      stream: {
        isTTY: false,
        write(chunk) {
          output += chunk;
        },
      },
      errorStream: {
        isTTY: false,
        write(chunk) {
          output += chunk;
        },
      },
    });
    const notices: ExitNotificationRequest[] = [];
    const code = await Effect.runPromise(
      runCli(["auto"]).pipe(
        Effect.provideService(CommandExecution, {
          execute: () =>
            Effect.sync(() => {
              presentation.run({ command: "auto", repository: "owner/repo" });
              presentation.updateTarget("#140");
            }).pipe(Effect.andThen(Effect.fail(new Error("failed")))),
        }),
        Effect.provideService(ExitNotifications, {
          send: (request) =>
            Effect.sync(() => {
              notices.push(request);
            }),
          deliver: () => Effect.void,
        }),
        Effect.provideService(Presentation, presentation),
        Effect.provide(applicationLayer),
      ),
    );
    expect(code).toBe(1);
    expect(output).toContain("FAILED #140 · run failed");
    expect(notices).toEqual([{ argv: ["auto"], succeeded: false }]);
  });
  test("notification failures preserve the command exit status and warn once", async () => {
    for (const succeeds of [true, false]) {
      let errors = "";
      const notices: ExitNotificationRequest[] = [];
      const presentation = new Presenter({
        stream: {
          isTTY: false,
          write(chunk) {
            errors += chunk;
          },
        },
        errorStream: {
          isTTY: false,
          write(chunk) {
            errors += chunk;
          },
        },
      });
      const code = await Effect.runPromise(
        runCli(["status", "--all"]).pipe(
          Effect.provideService(CommandExecution, {
            execute: () =>
              succeeds ? Effect.void : Effect.fail(new Error("failed")),
          }),
          Effect.provideService(ExitNotifications, {
            send: (request) =>
              Effect.sync(() => {
                notices.push(request);
              }).pipe(
                Effect.andThen(Effect.fail(new Error("notifier failed"))),
              ),
            deliver: () => Effect.void,
          }),
          Effect.provideService(Presentation, presentation),
          Effect.provide(applicationLayer),
        ),
      );
      expect(code).toBe(succeeds ? 0 : 1);
      expect(notices).toEqual([
        { argv: ["status", "--all"], succeeded: succeeds },
      ]);
      expect(errors.match(/could not deliver/g)).toHaveLength(1);
    }
  });
  test("preserves multiline errors and reports non-Error failures", async () => {
    for (const failure of [
      new Error("Invalid input\n\nUsage:\n  roark do <issue>"),
      { code: "E_OBJECT" },
    ]) {
      let errors = "";
      const code = await Effect.runPromise(
        runCli(["do", "95"]).pipe(
          Effect.provideService(CommandExecution, {
            execute: () => Effect.fail(failure),
          }),
          Effect.provideService(ExitNotifications, {
            send: () => Effect.void,
            deliver: () => Effect.void,
          }),
          Effect.provideService(
            Presentation,
            new Presenter({
              stream: {
                isTTY: false,
                write(chunk) {
                  errors += chunk;
                },
              },
              errorStream: {
                isTTY: false,
                write(chunk) {
                  errors += chunk;
                },
              },
            }),
          ),
          Effect.provide(applicationLayer),
        ),
      );
      expect(code).toBe(1);
      expect(errors).toContain(
        failure instanceof Error ? failure.message : "[object Object]",
      );
    }
  });
});
describe("roark executable", () => {
  test("prints the package version", async () => {
    const packageJson = Schema.decodeUnknownSync(
      Schema.Struct({ version: Schema.String }),
    )(await Bun.file(path.join(projectRoot, "package.json")).json());
    const result = await runApplicationPromise(
      runProcess([entrypoint, "--version"], {
        cwd: projectRoot,
      }),
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim()).toBe(packageJson.version);
  });
  test("prints help successfully", async () => {
    const result = await runApplicationPromise(
      runProcess([entrypoint, "--help"], {
        cwd: projectRoot,
      }),
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("roark <command> [issue] [options]");
  });
  test("reports invalid commands on stderr with a nonzero exit", async () => {
    const result = await runApplicationPromise(
      runProcess([entrypoint, "not-a-command"], {
        cwd: projectRoot,
      }),
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "Unknown command 'not-a-command'.\n\nroark <command> [issue] [options]\n\nCommands:",
    );
  });
  test("dispatches a hydrated status command", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "roark-entrypoint-"));
    tempDirs.push(repo);
    await runApplicationPromise(runProcessOrThrow(["git", "init", repo], {}));
    const result = await runApplicationPromise(
      runProcess(
        [entrypoint, "status", "--all", "--cwd", repo, "--repo", "owner/repo"],
        { cwd: projectRoot },
      ),
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim()).toBe("No observability summaries found.");
  });
});
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  test(`runtime ${signal} interrupts verification through the CLI lifecycle and reaps its descendants`, async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "roark-runtime-signal-"));
    tempDirs.push(cwd);
    const fixture = path.join(
      projectRoot,
      "lib/testing/fixtures/runtime-signal.ts",
    );
    const child = Bun.spawn([process.execPath, fixture], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = new Response(child.stderr).text();
    const stdout = new Response(child.stdout).text();
    let descendant: number | undefined;
    try {
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline) {
        const value = await readFile(path.join(cwd, "child.pid"), "utf8").catch(
          () => "",
        );
        if (/^\d+\n$/.test(value)) {
          descendant = Number(value);
          break;
        }
        if (child.exitCode !== null) throw new Error(await stderr);
        await Bun.sleep(10);
      }
      expect(descendant).toBeDefined();
      child.kill(signal);
      expect(await child.exited).toBe(130);
      expect(await stderr).toBe("");
      expect(await stdout).toContain("VERIFY RUNNING");
      if (descendant !== undefined) {
        // Allow init to reap an orphan after the scoped group kill.
        const deadline = Date.now() + 1000;
        let alive = true;
        while (alive && Date.now() < deadline) {
          try {
            process.kill(descendant, 0);
          } catch {
            alive = false;
          }
          if (alive) await Bun.sleep(10);
        }
        expect(alive).toBe(false);
      }
    } finally {
      child.kill("SIGKILL");
      if (descendant !== undefined) {
        try {
          process.kill(descendant, "SIGKILL");
        } catch {
          /* Already reaped. */
        }
      }
      await child.exited;
      await Promise.all([stdout, stderr]);
    }
  });
}
