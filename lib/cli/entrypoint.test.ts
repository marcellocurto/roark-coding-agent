import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { presentAutorunOutcome, runCli, workflowOutcomeStatus } from "../../roark.ts";
import { configurePresenter, Presenter, presenter } from "../presentation/presenter.ts";
import { runProcess, runProcessOrThrow } from "./process.ts";

const projectRoot = path.resolve(import.meta.dir, "../..");
const entrypoint = path.join(projectRoot, "roark.ts");
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("runCli lifecycle", () => {
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
    const exitCode = await runCli(["auto"], {
      presentation,
      execute: () => {
        presenter().run({ command: "auto", repository: "owner/repo" });
        presenter().updateTarget("#140");
        return Promise.reject(new Error("failed"));
      },
      notify: () => Promise.resolve(),
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
    const exitCode = await runCli(["status", "--all"], {
      execute: () => Promise.resolve(),
      notify: (request) => {
        notifications.push(request);
        return Promise.resolve();
      },
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
      const exitCode = await runCli(["do", "95"], {
        execute: () => Promise.reject(new Error("raw SECRET failure")),
        notify: (request) => {
          notifications.push(request);
          return Promise.reject(new Error("notifier failed"));
        },
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
      expect(await runCli(["do", "95"], {
        execute: () => Promise.reject(new Error("Invalid input\n\nUsage:\n  roark do <issue>")),
        notify: () => Promise.resolve(),
      })).toBe(1);
      expect(await runCli(["do", "95"], {
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the CLI boundary must report arbitrary JavaScript throw values
        execute: () => Promise.reject({ code: "E_OBJECT" }),
        notify: () => Promise.resolve(),
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
      const exitCode = await runCli(["status", "--all"], {
        execute: () => Promise.resolve(),
        notify: () => Promise.reject(new Error("notifier failed")),
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
    const result = await runProcess([entrypoint, "--version"], { cwd: projectRoot });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim()).toBe(packageJson.version);
  });

  test("prints help successfully", async () => {
    const result = await runProcess([entrypoint, "--help"], { cwd: projectRoot });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("roark <command> [issue] [options]");
  });

  test("reports invalid commands on stderr with a nonzero exit", async () => {
    const result = await runProcess([entrypoint, "not-a-command"], { cwd: projectRoot });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Unknown command 'not-a-command'.\n\nroark <command> [issue] [options]\n\nCommands:");
  });

  test("dispatches a hydrated status command", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "roark-entrypoint-"));
    tempDirs.push(repo);
    await runProcessOrThrow(["git", "init", repo]);

    const result = await runProcess([
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
