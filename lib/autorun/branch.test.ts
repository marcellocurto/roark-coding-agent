import { describe, expect, test } from "bun:test";
import {
  assertSafeWorkBranch,
  createBranchPlan,
  defaultAutorunBaseBranch,
} from "./branch.ts";

describe("autorun branch planning", () => {
  test("plans per-issue branches", () => {
    const plan = createBranchPlan({
      issueNumber: 123,
      branchName: "roark/issue-123",
    });

    expect(plan).toEqual({
      issueNumber: 123,
      branchName: "roark/issue-123",
      baseBranch: defaultAutorunBaseBranch,
    });
  });

  test("supports custom base branches", () => {
    const plan = createBranchPlan({
      issueNumber: 123,
      branchName: "roark/issue-123",
      baseBranch: "develop",
    });

    expect(plan.baseBranch).toBe("develop");
  });

  test("refuses to use the base branch as the work branch", () => {
    expect(() => assertSafeWorkBranch({ branchName: "main", baseBranch: "main" })).toThrow(
      "Autorun work branch cannot be the base branch 'main'",
    );
  });

  test("refuses main as a work branch even with a non-main base branch", () => {
    expect(() => assertSafeWorkBranch({ branchName: "main", baseBranch: "develop" })).toThrow(
      "Autorun work branch cannot be 'main'",
    );
  });
});
