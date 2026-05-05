import { describe, expect, test } from "bun:test";
import { decidePublish, parseReadinessStatus } from "./publish-gate.ts";
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

describe("parseReadinessStatus", () => {
  test("reads ready-for-pr from the readiness markdown", () => {
    const md = `# PR Readiness\n\n## Status\nready-for-pr\n\n## Issue\n#1\n`;
    expect(parseReadinessStatus(md)).toBe("ready-for-pr");
  });

  test("reads not-ready from the readiness markdown", () => {
    const md = `# PR Readiness\n\n## Status\nnot-ready\n`;
    expect(parseReadinessStatus(md)).toBe("not-ready");
  });

  test("tolerates whitespace and casing", () => {
    const md = `## Status\n  Ready-For-PR  \n`;
    expect(parseReadinessStatus(md)).toBe("ready-for-pr");
  });

  test("returns undefined when the section is missing", () => {
    expect(parseReadinessStatus("# PR Readiness\n\nnope\n")).toBeUndefined();
  });

  test("returns undefined for unknown status tokens", () => {
    expect(parseReadinessStatus("## Status\nunclear\n")).toBeUndefined();
  });
});

describe("decidePublish", () => {
  test("blocks publish when readiness is not-ready", () => {
    const decision = decidePublish({ readinessStatus: "not-ready" });
    expect(decision).toEqual({
      publish: false,
      phase: "readiness",
      reason: 'readiness status is "not-ready"',
      artifactPath: "readiness.md",
    });
  });

  test("blocks publish when readiness status is missing", () => {
    const decision = decidePublish({ readinessStatus: undefined });
    expect(decision.publish).toBe(false);
    if (decision.publish) return;
    expect(decision.phase).toBe("readiness");
    expect(decision.reason).toContain('"missing"');
    expect(decision.artifactPath).toBe("readiness.md");
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

  test("treats missing verification when ready as publishable (caller responsibility to run it)", () => {
    // Documents the contract: callers must supply verification when readiness is ready.
    // The gate itself does not require verification to be present in that branch.
    const decision = decidePublish({ readinessStatus: "ready-for-pr" });
    expect(decision).toEqual({ publish: true });
  });
});
