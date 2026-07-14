import { describe, expect, test } from "bun:test";
import { validateAgentArtifact } from "./artifact-validation.ts";
import { reviewResult } from "../testing/reviews.ts";
import { fixLogRef, refinementLogRef, reviewARef, reviewBRef } from "./artifacts.ts";
import { implementationPlanResult } from "../testing/workflow-results.ts";
import { changeReport } from "../testing/change-reports.ts";

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

  test("accepts only structured implementation plans", () => {
    expect(validateAgentArtifact("implementationPlan", JSON.stringify(implementationPlanResult()))).toEqual({ ok: true });
    const result = validateAgentArtifact("implementationPlan", "# Implementation Plan\n\n## Ready For Implementation\nyes\n");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("not valid JSON");
  });

  test("accepts only structured implementation, refinement, and fix reports", () => {
    const content = JSON.stringify(changeReport());
    expect(validateAgentArtifact("implementationLog", content)).toEqual({ ok: true });
    expect(validateAgentArtifact(refinementLogRef(0), content)).toEqual({ ok: true });
    expect(validateAgentArtifact(fixLogRef(1), content)).toEqual({ ok: true });
    expect(validateAgentArtifact("implementationLog", "# Implementation Log\n").ok).toBe(false);
  });

});
