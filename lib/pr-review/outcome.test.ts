import { describe, expect, test } from "bun:test";
import { reviewFinding, reviewResult } from "../testing/reviews.ts";
import { decidePrReview } from "./outcome.ts";

describe("decidePrReview", () => {
  test("publishes every typed finding under its derived classification", () => {
    const reviewA = reviewResult([
      reviewFinding("must-fix-current", "Malformed IDs"),
      reviewFinding("must-fix-current", "Unseeded auth test"),
    ]);
    const reviewB = reviewResult([
      reviewFinding("must-fix-current", "Self-contained tests"),
      reviewFinding("suggestion", "Avoid wall-clock assertions"),
    ]);

    const decision = decidePrReview({ reviewA, reviewB });

    expect(decision.outcome).toBe("changes-requested");
    expect(decision.requiredFixes.map((finding) => finding.title)).toEqual([
      "Malformed IDs",
      "Unseeded auth test",
      "Self-contained tests",
    ]);
    expect(decision.suggestions.map((finding) => finding.title)).toEqual(["Avoid wall-clock assertions"]);
  });

  test("treats external blockers and unavailable verification as blocked", () => {
    const clean = reviewResult();
    const blocked = reviewResult([reviewFinding("external-blocker")]);
    expect(decidePrReview({ reviewA: clean, reviewB: blocked }).outcome).toBe("blocked");
    expect(decidePrReview({ reviewA: clean, reviewB: clean, verificationUnavailable: "command not found" }).outcome).toBe("blocked");
  });

  test("treats approval-blocking review limitations as external blockers", () => {
    const limited = reviewResult([], {
      completeness: "limited",
      limitations: [{ id: "generated-output-unavailable", description: "Generated output could not be inspected.", blocksApproval: true }],
    });
    const decision = decidePrReview({ reviewA: limited, reviewB: reviewResult() });
    expect(decision.outcome).toBe("blocked");
    expect(decision.externalBlockers.map((blocker) => blocker.workflowId))
      .toEqual(["review-a:limitation:generated-output-unavailable"]);
  });

  test("treats failed verification as changes requested", () => {
    const clean = reviewResult();
    expect(decidePrReview({
      reviewA: clean,
      reviewB: clean,
      verification: { ok: false, command: "bun test", exitCode: 1, stdout: "failure", stderr: "" },
    }).outcome).toBe("changes-requested");
  });
});
