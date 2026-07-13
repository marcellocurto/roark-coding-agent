import { describe, expect, test } from "bun:test";
import {
  classifyVerificationFailure,
  formatVerificationArtifact,
  parseVerificationArtifact,
  runVerification,
  verificationFailureReason,
  type VerificationResult,
  type VerificationRunner,
} from "./verification.ts";

describe("autorun verification", () => {
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

  test("default verification terminates a command that exceeds its timeout", async () => {
    const result = await runVerification({ command: "sleep 1", cwd: "/tmp", timeoutMs: 10 });
    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
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
    const long = "a".repeat(10_000);
    const artifact = formatVerificationArtifact({
      ok: false,
      command: "noisy",
      exitCode: 1,
      stdout: long,
      stderr: "",
    });
    expect(artifact).toContain("(truncated");
    expect(artifact.length).toBeLessThan(long.length + 600);
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
