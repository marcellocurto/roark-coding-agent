import { describe, expect, test } from "bun:test";
import { validateAgentArtifact } from "./artifact-validation.ts";

const validReview = `# Review B

## Verdict
approve

## Findings
None.

## Required Fixes
None.

## Suggested Improvements
None.

## Validation Reviewed
Tests.
`;

const validPlan = `# Implementation Plan

## Ready For Implementation
yes
`;

describe("validateAgentArtifact", () => {
  test("rejects an empty review artifact", () => {
    const result = validateAgentArtifact("reviewB", "");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("empty");
  });

  test("accepts a review artifact with an allowed verdict", () => {
    expect(validateAgentArtifact("reviewB", validReview)).toEqual({ ok: true });
  });

  test("rejects a review artifact without a verdict", () => {
    const result = validateAgentArtifact("reviewA", "# Review A\n\n## Findings\nLooks fine.\n");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("missing");
  });

  test("requires explicit plan readiness", () => {
    expect(validateAgentArtifact("implementationPlan", validPlan)).toEqual({ ok: true });
    const result = validateAgentArtifact("implementationPlan", "# Implementation Plan\n\n## Goal\nDo it.\n");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("Ready For Implementation");
  });

  test("allows restart-required for numbered review cycles", () => {
    expect(validateAgentArtifact({ name: "reviewA", pass: 0 }, "# Review A Pass 0\n\n## Verdict\nrestart-required\n")).toEqual({ ok: true });
  });
});
