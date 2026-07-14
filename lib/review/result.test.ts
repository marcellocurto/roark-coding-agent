import { describe, expect, test } from "bun:test";
import { reviewFinding, reviewResult } from "../testing/reviews.ts";
import {
  formatReviewResultMarkdown,
  normalizeReviewBlockers,
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
      "broken-behavior",
      "later-work",
      "optional-polish",
    ]);
  });

  test("rejects malformed JSON and schema-invalid review data", () => {
    expect(() => parseReviewResultJson("not json", { allowRestart: true })).toThrow("not valid JSON");
    expect(() => validateReviewResult({ summary: "Incomplete" }, { allowRestart: true })).toThrow("structured contract");
  });

  test("requires substantive reviewed evidence and trims accepted strings", () => {
    expect(() => validateReviewResult(reviewResult([], { evidenceReviewed: [] }), { allowRestart: true }))
      .toThrow("structured contract");
    expect(() => validateReviewResult(reviewResult([], { evidenceReviewed: ["   "] }), { allowRestart: true }))
      .toThrow("structured contract");

    const finding = reviewFinding("follow-up", "  Stable title  ", { id: "stable-title" });
    const result = validateReviewResult(reviewResult([finding], {
      summary: "  Reviewed the pinned diff.  ",
      evidenceReviewed: ["  git diff base..head  "],
    }), { allowRestart: true });
    expect(result.summary).toBe("Reviewed the pinned diff.");
    expect(result.evidenceReviewed).toEqual(["git diff base..head"]);
    expect(result.findings[0]?.title).toBe("Stable title");
  });

  test("bounds review volume and rejects contradictory routing metadata", () => {
    const tooMany = Array.from({ length: 51 }, (_, index) => reviewFinding("follow-up", `Finding ${index}`, { id: `finding-${index}` }));
    expect(() => validateReviewResult(reviewResult(tooMany), { allowRestart: true })).toThrow("structured contract");
    expect(() => validateReviewResult(reviewResult([], { summary: "x".repeat(100_000) }), { allowRestart: true }))
      .toThrow("100000-character limit");
    expect(() => validateReviewResult(reviewResult([
      reviewFinding("must-fix-current", "Uncertain blocker", { confidence: "low" }),
    ]), { allowRestart: true })).toThrow("requires medium or high confidence");
    expect(() => validateReviewResult(reviewResult([
      reviewFinding("suggestion", "Optional catastrophe", { severity: "critical" }),
    ]), { allowRestart: true })).toThrow("cannot be routed as an optional suggestion");
  });

  test("represents incomplete review coverage without inventing a finding", () => {
    const result = validateReviewResult(reviewResult([], {
      completeness: "limited",
      limitations: [{ id: "migration-output-unavailable", description: "Generated migration output was unavailable.", blocksApproval: true }],
    }), { allowRestart: true });

    expect(reviewDisposition(result)).toBe("blocked");
    expect(normalizeReviewBlockers(result, "review-a").map((blocker) => blocker.workflowId))
      .toEqual(["review-a:limitation:migration-output-unavailable"]);
  });

  test("renders review-provided text as plain Markdown content", () => {
    const result = reviewResult([
      reviewFinding("follow-up", "Heading\n## Injected @maintainers <script>", { id: "markdown-injection" }),
    ], {
      summary: "Summary\n# Fake outcome @maintainers <b>unsafe</b>",
      evidenceReviewed: ["diff\n</details>"],
      additionalSections: [{
        heading: "Architectural synthesis\n## Fake finding",
        items: ["The diff confirms a reusable pattern without creating actionable work. @maintainers <script>"],
      }],
    });

    const markdown = formatReviewResultMarkdown(result, { title: "Review", source: "review-a" });
    expect(markdown).not.toContain("\n# Fake outcome");
    expect(markdown).not.toContain("\n## Injected");
    expect(markdown).toContain("\\@maintainers");
    expect(markdown).toContain("&lt;script&gt;");
    expect(markdown).toContain("&lt;/details&gt;");
    expect(markdown).toContain("## Architectural synthesis ## Fake finding");
    expect(reviewDisposition(result)).toBe("approve");
  });

  test("rejects restart recommendations where unsupported or unjustified", () => {
    const restart = reviewResult([], { restartRecommendation: { findingIds: ["missing-finding"], rationale: "Start over." } });
    expect(() => validateReviewResult(restart, { allowRestart: true })).toThrow("unknown finding");
    const finding = reviewFinding("must-fix-current");
    const justified = reviewResult([finding], { restartRecommendation: { findingIds: [finding.id], rationale: "The implementation direction is unsafe." } });
    expect(() => validateReviewResult(justified, { allowRestart: false })).toThrow("does not allow restart");
  });
});
