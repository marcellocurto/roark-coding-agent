import { describe, expect, test } from "bun:test";
import { decidePublish } from "./publish-gate.ts";
import type { VerificationResult } from "./verification.ts";

const okVerification: VerificationResult = {
  ok: true,
  command: "bun run typecheck",
  exitCode: 0,
  stdout: "",
  stderr: "",
};

const failedVerification: VerificationResult = {
  ok: false,
  command: "bun run typecheck",
  exitCode: 2,
  stdout: "",
  stderr: "errors",
};

describe("decidePublish", () => {
  test("blocks publish when readiness is not-ready", () => {
    const decision = decidePublish({ readinessStatus: "not-ready" });
    expect(decision).toEqual({
      publish: false,
      phase: "readiness",
      reason: 'readiness status is "not-ready"',
      artifactPath: "readiness.json",
    });
  });

  test("blocks publish when readiness status is missing", () => {
    const decision = decidePublish({ readinessStatus: undefined });
    expect(decision.publish).toBe(false);
    if (decision.publish) return;
    expect(decision.phase).toBe("readiness");
    expect(decision.reason).toContain('"missing"');
    expect(decision.artifactPath).toBe("readiness.json");
  });

  test("publishes when readiness is ready and verification passed", () => {
    const decision = decidePublish({ readinessStatus: "ready-for-pr", verification: okVerification });
    expect(decision).toEqual({ publish: true });
  });

  test("blocks publish when verification failed", () => {
    const decision = decidePublish({ readinessStatus: "ready-for-pr", verification: failedVerification });
    expect(decision).toEqual({
      publish: false,
      phase: "verification",
      reason: "verify command exited 2",
      artifactPath: "verification.md",
    });
  });

  test("blocks publish when readiness is ready but verification is missing", () => {
    const decision = decidePublish({ readinessStatus: "ready-for-pr" });
    expect(decision).toEqual({
      publish: false,
      phase: "verification",
      reason: "verification result is missing",
      artifactPath: "verification.md",
    });
  });
});
