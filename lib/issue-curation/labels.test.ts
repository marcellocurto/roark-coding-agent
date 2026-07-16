import { describe, expect, test } from "bun:test";
import {
  requiredReviewerIssueLabels,
  reviewerIssueLabelForClassification,
  reviewerIssueTriageLabels,
} from "./labels.ts";

describe("reviewer issue labels", () => {
  test("uses one triage status and namespaced reviewer classifications", () => {
    expect(reviewerIssueTriageLabels).toEqual(["needs-triage"]);
    expect(requiredReviewerIssueLabels.map((label) => label.name)).toEqual([
      "needs-triage",
      "review:external-blocker",
      "review:follow-up",
      "review:suggestion",
    ]);
    expect(reviewerIssueLabelForClassification("follow-up")).toBe("review:follow-up");
  });
});
