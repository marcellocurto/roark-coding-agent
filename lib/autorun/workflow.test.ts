import { describe, expect, test } from "bun:test";
import path from "node:path";
import { createAutorunWorkflowContext, createAutorunWorkflowOptions } from "./workflow.ts";
import { createBranchPlan } from "./branch.ts";
import type { AutoCliOptions } from "../cli/args.ts";

const autoOptions = {
  command: "auto",
  cwd: "/repo",
  repo: "owner/repo",
  readyLabel: "afk",
  skipLabels: [],
  limit: 1,
  inProgressLabel: "roark-in-progress",
  noAssign: false,
  dryRun: false,
  baseBranch: "main",
  verifyCommand: "bun run typecheck",
  failureLabel: "roark-failed",
  successLabel: "roark-pr-opened",
  remote: "origin",
  model: "provider/model",
  thinkingLevel: "high",
  maxFixPasses: 3,
  force: true,
  yes: true,
} satisfies AutoCliOptions;

describe("autorun workflow context", () => {
  test("splits control artifacts from issue worktree agent execution", () => {
    const branchPlan = createBranchPlan({
      issueNumber: 123,
      branchName: "roark/issue-123",
    });
    const context = createAutorunWorkflowContext(
      { number: 123, title: "Do the thing" },
      branchPlan,
      autoOptions,
      2,
    );

    expect(context.controlCwd).toBe(path.resolve("/repo"));
    expect(context.agentCwd).toBe(path.resolve("/repo/.roark/worktrees/issue-123"));
    expect(context.runDir).toBe(path.resolve("/repo/.roark/runs/issue/123/attempts/2"));
    expect(context.runDirRelative).toBe(path.join(".roark/runs", "issue", "123", "attempts", "2"));
  });

  test("runs the existing issue workflow on the issue branch checkout", () => {
    const branchPlan = createBranchPlan({
      issueNumber: 123,
      branchName: "roark/issue-123",
    });
    const workflowOptions = createAutorunWorkflowOptions(
      { number: 123, title: "Do the thing" },
      branchPlan,
      autoOptions,
    );

    expect(workflowOptions.command).toBe("do");
    expect(workflowOptions.issue).toBe("123");
    expect(workflowOptions.cwd).toBe("/repo");
    expect(workflowOptions.outDir).toBe(".roark/runs");
    expect(workflowOptions.repo).toBe("owner/repo");
    expect(workflowOptions.model).toBe("provider/model");
    expect(workflowOptions.thinkingLevel).toBe("high");
    expect(workflowOptions.maxFixPasses).toBe(3);
    expect(workflowOptions.force).toBe(true);
    expect(workflowOptions.yes).toBe(true);
    expect(workflowOptions.attempt).toBeUndefined();
  });

  test("forwards an explicit attempt number into IssueCliOptions", () => {
    const branchPlan = createBranchPlan({
      issueNumber: 123,
      branchName: "roark/issue-123",
    });
    const workflowOptions = createAutorunWorkflowOptions(
      { number: 123, title: "Do the thing" },
      branchPlan,
      autoOptions,
      4,
    );
    expect(workflowOptions.attempt).toBe(4);
  });
});
