import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { configurePresenter } from "../presentation/presenter.ts";
import type { TerminalStream } from "../presentation/terminal.ts";
import { artifactExists, createWorkflowContext, readArtifact, verificationBeforeFixFullRef } from "../workflow/artifacts.ts";
import {
  classifyVerificationFailure,
  formatCompleteVerificationArtifact,
  formatVerificationArtifact,
  parseVerificationArtifact,
  runVerification,
  writeVerificationArtifact,
  writeVerificationBeforeFixArtifact,
  verificationFailureReason,
  type VerificationResult,
  type VerificationRunner,
} from "./verification.ts";

describe("autorun verification", () => {
  test("announces verification before waiting for the runner", async () => {
    let output = "";
    const stream: TerminalStream = { isTTY: true, columns: 80, write(chunk) { output += chunk; } };
    configurePresenter({ stream, env: { TERM: "xterm" } });
    let resolveRunner: ((result: VerificationResult) => void) | undefined;
    const runnerResult = new Promise<VerificationResult>((resolve) => { resolveRunner = resolve; });

    try {
      const running = runVerification({
        command: "bun test",
        cwd: "/tmp/wt",
        runner: () => runnerResult,
        display: { target: "PR #12", repository: "owner/repo", revision: 2, pass: 1 },
      });
      expect(output).toContain("Verification");
      expect(output).toContain("PR #12 · Verification · r2 · p1 · repo");
      expect(output).not.toContain("PASSED");
      resolveRunner?.({ ok: true, command: "bun test", exitCode: 0, stdout: "", stderr: "" });
      await running;
      expect(output).toContain("VERIFY PASSED");
      expect(output).toContain("PR #12 · Verification passed · r2 · p1 · repo");
    } finally {
      configurePresenter({});
    }
  });

  test("runVerification reports ok when the runner exits 0", async () => {
    const runner: VerificationRunner = ({ command, cwd })=> Promise.resolve(({
      ok: true,
      command,
      exitCode: 0,
      stdout: `ran in ${cwd}`,
      stderr: "",
    }));

    const result = await runVerification({ command: "noop", cwd: "/tmp/wt", runner });
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.command).toBe("noop");
    expect(result.stdout).toBe("ran in /tmp/wt");
    expect(result).toEqual({
      ok: true,
      command: "noop",
      exitCode: 0,
      stdout: "ran in /tmp/wt",
      stderr: "",
    });
  });

  test("runner exceptions are presented and preserve rejection semantics", async () => {
    let output = "";
    const stream: TerminalStream = { isTTY: false, columns: 80, write(chunk) { output += chunk; } };
    configurePresenter({ stream });
    const times = [100, 350];
    const failure = new Error("spawn failed\u001b]0;owned");

    try {
      const running = runVerification({
        command: "bun test",
        cwd: "/tmp/wt",
        runner: () => Promise.reject(failure),
        now: () => times.shift() ?? 350,
      });

      let thrown: unknown;
      try {
        await running;
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBe(failure);
      expect(output).toContain("VERIFY FAILED");
      expect(output).toContain("250ms");
      expect(output).toContain("verification could not be executed");
      expect(output).not.toContain("\u001b]0;owned");
    } finally {
      configurePresenter({});
    }
  });

  test("runVerification reports failure when the runner exits non-zero", async () => {
    const runner: VerificationRunner = ({ command })=> Promise.resolve(({
      ok: false,
      command,
      exitCode: 2,
      stdout: "",
      stderr: "boom",
    }));

    const result = await runVerification({ command: "fail", cwd: "/tmp/wt", runner });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toBe("boom");
  });

  test("default verification terminates the process tree when a command exceeds its timeout", async () => {
    const startedAt = Date.now();
    const result = await runVerification({ command: "sh -c 'sleep 2 & wait'", cwd: "/tmp", timeoutMs: 10 });
    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(classifyVerificationFailure(result).reason).toBe("verification timed out");
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
    const long = `diagnostic-at-start\n${"a".repeat(10_000)}\ndiagnostic-at-end`;
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
    const cwd = await mkdtemp(path.join(tmpdir(), "roark-verification-artifacts-"));
    const context = createWorkflowContext({
      command: "do",
      issue: "1",
      cwd,
      outDir: ".roark/runs",
      force: false,
      yes: false,
      maxFixPasses: 1,
    });
    const result: VerificationResult = { ok: false, command: "bun test", exitCode: 1, stdout: "complete stdout", stderr: "complete stderr" };
    try {
      await writeVerificationArtifact(context, result);
      await writeVerificationBeforeFixArtifact(context, 2, result);
      expect(artifactExists(context, "verificationFull")).toBe(true);
      expect(artifactExists(context, verificationBeforeFixFullRef(2))).toBe(true);
      expect(await readArtifact(context, "verificationFull")).toContain("complete stdout");
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
    expect(verificationFailureReason({
      ok: false,
      command: "bun run typecheck",
      exitCode: 127,
      stdout: "",
      stderr: "/bin/bash: tsc: command not found",
    })).toContain("bun install --frozen-lockfile");
  });

  test("classifies deterministic verification exits as repairable", () => {
    expect(classifyVerificationFailure({
      ok: false,
      command: "bun run check",
      exitCode: 1,
      stdout: "",
      stderr: "lint failed",
    }).repairable).toBe(true);
  });

  test("does not treat generic test not-found output as command unavailable", () => {
    expect(classifyVerificationFailure({
      ok: false,
      command: "bun test",
      exitCode: 1,
      stdout: "",
      stderr: "AssertionError: expected element to be not found",
    }).repairable).toBe(true);

    expect(classifyVerificationFailure({
      ok: false,
      command: "bun test",
      exitCode: 1,
      stdout: "",
      stderr: "Error: not found",
    }).repairable).toBe(true);
  });

  test("parses verification artifacts for continuation planning", () => {
    const parsed = parseVerificationArtifact(formatVerificationArtifact({
      ok: false,
      command: "bun run typecheck",
      exitCode: 127,
      stdout: "",
      stderr: "/bin/bash: tsc: command not found",
    }));

    expect(parsed).toEqual({
      ok: false,
      command: "bun run typecheck",
      exitCode: 127,
      stdout: "",
      stderr: "/bin/bash: tsc: command not found",
    });
  });
});
