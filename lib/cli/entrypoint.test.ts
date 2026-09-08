import { Effect } from "effect";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { presentAutorunOutcome, runCliPromise, workflowOutcomeStatus } from "../../roark.ts";
import { configurePresenter, Presenter, presenter } from "../presentation/presenter.ts";
import { runProcessPromise, runProcessOrThrowPromise } from "./process.ts";

const projectRoot = path.resolve(import.meta.dir, "../..");
const entrypoint = path.join(projectRoot, "roark.ts");
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("runCliPromise lifecycle", () => {
  test("presents published, stopped, blocked, readiness-failed, and verification-failed outcomes distinctly", () => {
    let output = "";
    configurePresenter({ stream: { isTTY: false, columns: 80, write(chunk) { output += chunk; } } });
    try {
      presentAutorunOutcome({ issueNumber: 1, outcome: "published", outcomeDetail: null });
      presentAutorunOutcome({ issueNumber: 2, outcome: "triage-stopped", outcomeDetail: "not actionable" });
      presentAutorunOutcome({ issueNumber: 3, outcome: "failed-readiness", outcomeDetail: "not ready" });
      presentAutorunOutcome({ issueNumber: 4, outcome: "failed-verification", outcomeDetail: "tests failed" });

      expect(output).toContain("SUCCESS #1 · published");
      expect(output).toContain("STOPPED #2 · not actionable");
      expect(output).toContain("FAILED #3 · not ready");
      expect(output).toContain("FAILED #4 · tests failed");
      expect(output).not.toContain("continue:");
      expect(workflowOutcomeStatus("review-blocked")).toBe("BLOCKED");
    } finally {
      configurePresenter({ titleEnabled: false });
    }
  });

  test("preserves a discovered autorun target in the final failure", async () => {
    let output = "";
    const presentation = new Presenter({ stream: { isTTY: false, columns: 80, write(chunk) { output += chunk; } } });
    const exitCode = await runCliPromise(["auto"], {
      presentation,
      execute: () => {
        presenter().run({ command: "auto", repository: "owner/repo" });
        presenter().updateTarget("#140");
        return Promise.reject(new Error("failed"));
      },
      notify: () => Effect.void,
      reportError: () => {
        // The expected failure is asserted through the operational output.
      },
    });

    expect(exitCode).toBe(1);
    expect(output).toContain("FAILED #140 · run failed");
    expect(output).not.toContain("FAILED auto");
  });

  test("dispatches exactly once after a successful quick command", async () => {
    const notifications: { argv: string[]; succeeded: boolean }[] = [];
    const exitCode = await runCliPromise(["status", "--all"], {
      execute: () => Promise.resolve(),
      notify: (request) => Effect.sync(() => { notifications.push(request); }),
    });

    expect(exitCode).toBe(0);
    expect(notifications).toEqual([{ argv: ["status", "--all"], succeeded: true }]);
  });

  test("dispatches once after a caught failure and preserves the failed result when notification delivery fails", async () => {
    const notifications: { argv: string[]; succeeded: boolean }[] = [];
    const reported: unknown[] = [];
    const consoleError = spyOn(console, "error").mockImplementation(() => {
      // Suppress the expected notification warning in test output.
    });
    try {
      const exitCode = await runCliPromise(["do", "95"], {
        execute: () => Promise.reject(new Error("raw SECRET failure")),
        notify: (request) => Effect.sync(() => { notifications.push(request); }).pipe(
          Effect.andThen(Effect.fail(new Error("notifier failed"))),
        ),
        reportError: (error) => reported.push(error),
      });

      expect(exitCode).toBe(1);
      expect(notifications).toEqual([{ argv: ["do", "95"], succeeded: false }]);
      expect(reported).toHaveLength(1);
      expect(consoleError).toHaveBeenCalledTimes(1);
    } finally {
      consoleError.mockRestore();
    }
  });

  test("preserves multiline CLI errors and reports non-Error throws", async () => {
    const reported: string[] = [];
    const consoleError = spyOn(console, "error").mockImplementation((value) => {
      reported.push(String(value));
    });
    try {
      expect(await runCliPromise(["do", "95"], {
        execute: () => Promise.reject(new Error("Invalid input\n\nUsage:\n  roark do <issue>")),
        notify: () => Effect.void,
      })).toBe(1);
      expect(await runCliPromise(["do", "95"], {
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the CLI boundary must report arbitrary JavaScript throw values
        execute: () => Promise.reject({ code: "E_OBJECT" }),
        notify: () => Effect.void,
      })).toBe(1);

      expect(reported[0]).toBe("Invalid input\n\nUsage:\n  roark do <issue>");
      expect(reported[1]).toBe("[object Object]");
    } finally {
      consoleError.mockRestore();
    }
  });

  test("preserves success when notification delivery fails", async () => {
    const consoleError = spyOn(console, "error").mockImplementation(() => {
      // Suppress the expected warning in test output.
    });
    try {
      const exitCode = await runCliPromise(["status", "--all"], {
        execute: () => Promise.resolve(),
        notify: () => Effect.fail(new Error("notifier failed")),
      });
      expect(exitCode).toBe(0);
      expect(consoleError).toHaveBeenCalledTimes(1);
    } finally {
      consoleError.mockRestore();
    }
  });
});

describe("roark executable", () => {
  test("prints the package version", async () => {
    const packageJson = await Bun.file(path.join(projectRoot, "package.json")).json() as { version: string };
    const result = await runProcessPromise([entrypoint, "--version"], { cwd: projectRoot });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim()).toBe(packageJson.version);
  });

  test("prints help successfully", async () => {
    const result = await runProcessPromise([entrypoint, "--help"], { cwd: projectRoot });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("roark <command> [issue] [options]");
  });

  test("reports invalid commands on stderr with a nonzero exit", async () => {
    const result = await runProcessPromise([entrypoint, "not-a-command"], { cwd: projectRoot });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Unknown command 'not-a-command'.\n\nroark <command> [issue] [options]\n\nCommands:");
  });

  test("dispatches a hydrated status command", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "roark-entrypoint-"));
    tempDirs.push(repo);
    await runProcessOrThrowPromise(["git", "init", repo]);

    const result = await runProcessPromise([
      entrypoint,
      "status",
      "--all",
      "--cwd",
      repo,
      "--repo",
      "owner/repo",
    ], { cwd: projectRoot });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim()).toBe("No observability summaries found.");
  });
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  test(`runtime ${signal} interrupts verification through the Promise boundary and reaps its descendants`, async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "roark-runtime-signal-"));
    tempDirs.push(cwd);
    const fixture = path.join(projectRoot, "lib/testing/fixtures/runtime-signal.ts");
    const child = Bun.spawn([process.execPath, fixture], { cwd, stdout: "pipe", stderr: "pipe" });
    const stderr = new Response(child.stderr).text();
    const stdout = new Response(child.stdout).text();
    let descendant: number | undefined;
    try {
      const deadline = Date.now() + 4_000;
      while (Date.now() < deadline) {
        const value = await readFile(path.join(cwd, "child.pid"), "utf8").catch(() => "");
        if (/^\d+\n$/.test(value)) { descendant = Number(value); break; }
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
        const deadline = Date.now() + 1_000;
        let alive = true;
        while (alive && Date.now() < deadline) {
          try { process.kill(descendant, 0); } catch { alive = false; }
          if (alive) await Bun.sleep(10);
        }
        expect(alive).toBe(false);
      }
    } finally {
      child.kill("SIGKILL");
      if (descendant !== undefined) {
        try { process.kill(descendant, "SIGKILL"); } catch { /* Already reaped. */ }
      }
      await child.exited;
      await Promise.all([stdout, stderr]);
    }
  });
}
