import { describe, expect, test } from "bun:test";
import { buildClaimComment, plannedIssueBranchName } from "./claim.ts";

describe("autorun claim planning", () => {
  test("plans branch names from issue numbers", () => {
    expect(plannedIssueBranchName(123)).toBe("roark/issue-123");
  });

  test("builds claim comments with an assignee and branch", () => {
    expect(buildClaimComment({ issueNumber: 123, branchName: "roark/issue-123", assignee: "roark-codes" })).toBe(
      "@roark-codes is attempting this issue in branch `roark/issue-123`.",
    );
  });

  test("builds claim comments without an assignee", () => {
    expect(buildClaimComment({ issueNumber: 123, branchName: "roark/issue-123" })).toBe(
      "Roark is attempting this issue in branch `roark/issue-123`.",
    );
  });
});
