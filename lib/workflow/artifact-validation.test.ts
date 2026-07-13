import { describe, expect, test } from "bun:test";
import { validateAgentArtifact } from "./artifact-validation.ts";

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

  test("accepts any non-empty review artifact", () => {
    expect(validateAgentArtifact("reviewA", "Looks fine.")).toEqual({ ok: true });
    expect(validateAgentArtifact({ name: "reviewB", pass: 2 }, "Unconventional but usable review output.")).toEqual({ ok: true });
  });

  test("requires explicit plan readiness", () => {
    expect(validateAgentArtifact("implementationPlan", validPlan)).toEqual({ ok: true });
    const result = validateAgentArtifact("implementationPlan", "# Implementation Plan\n\n## Goal\nDo it.\n");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("Ready For Implementation");
  });

});
