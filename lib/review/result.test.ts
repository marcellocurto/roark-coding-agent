import { describe, expect, test } from "bun:test";
import { reviewFinding, reviewResult } from "../testing/reviews.ts";
import {
  normalizeReviewPair,
  parseReviewResultJson,
  reviewDisposition,
  validateReviewResult,
} from "./result.ts";

describe("structured review result", () => {
  test("derives outcomes and stable identifiers from typed findings", () => {
    const reviewA = reviewResult([
      reviewFinding("must-fix-current", "Broken behavior"),
      reviewFinding("follow-up", "Later work"),
    ]);
    const reviewB = reviewResult([reviewFinding("suggestion", "Optional polish")]);

    expect(reviewDisposition(reviewA)).toBe("fixes-required");
    expect(normalizeReviewPair({ reviewA, reviewB }).map((finding) => finding.sourceLocalId)).toEqual([
      "A-001",
      "A-002",
      "B-001",
    ]);
  });

  test("rejects malformed JSON and schema-invalid review data", () => {
    expect(() => parseReviewResultJson("not json", { allowRestart: true })).toThrow("not valid JSON");
    expect(() => validateReviewResult({ summary: "Incomplete" }, { allowRestart: true })).toThrow("structured contract");
  });

  test("rejects restart recommendations where unsupported or unjustified", () => {
    const restart = reviewResult([], { restartRationale: "Start over." });
    expect(() => validateReviewResult(restart, { allowRestart: true })).toThrow("requires at least one must-fix-current");
    const justified = reviewResult([reviewFinding("must-fix-current")], { restartRationale: "The implementation direction is unsafe." });
    expect(() => validateReviewResult(justified, { allowRestart: false })).toThrow("does not allow restart");
  });
});
