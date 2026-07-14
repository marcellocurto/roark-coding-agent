import { describe, expect, test } from "bun:test";
import { reviewFinding, reviewResult } from "../testing/reviews.ts";
import { decideReadiness, hasBlockedReview, needsFix, needsRestart } from "./verdicts.ts";
import { implementationPlanResult, triageResult } from "../testing/workflow-results.ts";

const triage = triageResult();
const plan = implementationPlanResult();

describe("classification-aware verdict decisions", () => {
  test("follow-ups and suggestions do not block readiness", () => {
    const reviewA = reviewResult([reviewFinding("follow-up")]);
    const reviewB = reviewResult([reviewFinding("suggestion")]);
    const decision = decideReadiness({ triage, plan, reviewA, reviewB });

    expect(needsFix(reviewA, reviewB)).toBe(false);
    expect(decision.status).toBe("ready-for-pr");
    expect(decision.followUpFindings).toHaveLength(1);
    expect(decision.suggestions).toHaveLength(1);
  });

  test("must-fix findings trigger fixes and block readiness", () => {
    const reviewA = reviewResult([reviewFinding("must-fix-current")]);
    const reviewB = reviewResult();
    expect(needsFix(reviewA, reviewB)).toBe(true);
    expect(decideReadiness({ triage, plan, reviewA, reviewB }).status).toBe("not-ready");
  });

  test("external blockers stop the workflow without invoking fixes", () => {
    const reviewA = reviewResult([reviewFinding("external-blocker")]);
    const reviewB = reviewResult();
    expect(hasBlockedReview(reviewA, reviewB)).toBe(true);
    expect(needsFix(reviewA, reviewB)).toBe(false);
  });

  test("restart rationale drives restart independently of Markdown", () => {
    const reviewA = reviewResult([reviewFinding("must-fix-current")], { restartRationale: "The implementation direction is unsafe." });
    expect(needsRestart(reviewA)).toBe(true);
  });
});
