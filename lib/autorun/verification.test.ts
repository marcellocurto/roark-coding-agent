import { describe, expect, test } from "bun:test";
import {
  defaultAutorunVerifyCommand,
  formatVerificationArtifact,
  runVerification,
  type VerificationResult,
  type VerificationRunner,
} from "./verification.ts";

describe("autorun verification", () => {
  test("default verify command targets typecheck", () => {
    expect(defaultAutorunVerifyCommand).toBe("bun run typecheck");
  });

  test("runVerification reports ok when the runner exits 0", async () => {
    const runner: VerificationRunner = async ({ command, cwd }) => ({
      ok: true,
      command,
      exitCode: 0,
      stdout: `ran in ${cwd}`,
      stderr: "",
    });

    const result = await runVerification({ command: "noop", cwd: "/tmp/wt", runner });
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.command).toBe("noop");
    expect(result.stdout).toBe("ran in /tmp/wt");
  });

  test("runVerification reports failure when the runner exits non-zero", async () => {
    const runner: VerificationRunner = async ({ command }) => ({
      ok: false,
      command,
      exitCode: 2,
      stdout: "",
      stderr: "boom",
    });

    const result = await runVerification({ command: "fail", cwd: "/tmp/wt", runner });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toBe("boom");
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
});
