import { describe, expect, test } from "bun:test";
import path from "node:path";
import {
  assertSafeWorkBranch,
  createWorktreePlan,
  defaultAutorunBaseBranch,
  defaultAutorunWorktreeRoot,
} from "./worktree.ts";

describe("autorun worktree planning", () => {
  test("plans per-issue worktrees from issue branches", () => {
    const plan = createWorktreePlan({
      cwd: "/repo",
      issueNumber: 123,
      branchName: "roark/issue-123",
    });

    expect(plan).toEqual({
      issueNumber: 123,
      branchName: "roark/issue-123",
      baseBranch: defaultAutorunBaseBranch,
      worktreePath: path.resolve("/repo", defaultAutorunWorktreeRoot, "issue-123"),
      worktreePathRelative: path.join(defaultAutorunWorktreeRoot, "issue-123"),
    });
  });

  test("supports custom base branches and worktree roots", () => {
    const plan = createWorktreePlan({
      cwd: "/repo",
      issueNumber: 123,
      branchName: "roark/issue-123",
      baseBranch: "develop",
      worktreeRoot: ".tmp/roark-worktrees",
    });

    expect(plan.baseBranch).toBe("develop");
    expect(plan.worktreePathRelative).toBe(path.join(".tmp/roark-worktrees", "issue-123"));
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
