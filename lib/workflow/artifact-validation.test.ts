import { describe, expect, test } from "bun:test";
import { validateAgentArtifact } from "./artifact-validation.ts";
import { reviewResult } from "../testing/reviews.ts";
import { reviewARef, reviewBRef } from "./artifacts.ts";

const validPlan = `# Implementation Plan

## Ready For Implementation
yes
`;

describe("validateAgentArtifact", () => {
  test("rejects an empty review artifact", () => {
    const result = validateAgentArtifact(reviewBRef(0), "");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("empty");
  });

  test("accepts only structured review artifacts", () => {
    expect(validateAgentArtifact(reviewARef(0), JSON.stringify(reviewResult()))).toEqual({ ok: true });
    expect(validateAgentArtifact(reviewBRef(2), "Looks fine.").ok).toBe(false);
  });

  test("requires explicit plan readiness", () => {
    expect(validateAgentArtifact("implementationPlan", validPlan)).toEqual({ ok: true });
    const result = validateAgentArtifact("implementationPlan", "# Implementation Plan\n\n## Goal\nDo it.\n");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("Ready For Implementation");
  });

});
