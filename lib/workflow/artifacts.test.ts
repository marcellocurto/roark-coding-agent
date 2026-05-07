import { describe, expect, test } from "bun:test";
import path from "node:path";
import type { IssueCliOptions } from "../cli/args.ts";
import { artifactAgentPath, artifactRelativePath, createWorkflowContext } from "./artifacts.ts";

const baseOptions: IssueCliOptions = {
  command: "do",
  issue: "10",
  cwd: "/repo",
  outDir: ".roark/runs",
  force: false,
  yes: false,
  maxFixPasses: 1,
};

describe("createWorkflowContext", () => {
  test("places runDir at the issue root when no attempt is supplied", () => {
    const context = createWorkflowContext(baseOptions);
    expect(context.controlCwd).toBe(path.resolve("/repo"));
    expect(context.agentCwd).toBe(path.resolve("/repo"));
    expect(context.runDir).toBe(path.resolve("/repo", ".roark/runs/issue/10"));
    expect(context.runDirRelative).toBe(path.join(".roark/runs", "issue", "10"));
    expect(context.attempt).toBeUndefined();
  });

  test("allows autorun to override the agent cwd while keeping artifacts under control cwd", () => {
    const context = createWorkflowContext(baseOptions, { agentCwd: "/repo/.roark/worktrees/issue-10" });
    expect(context.controlCwd).toBe(path.resolve("/repo"));
    expect(context.agentCwd).toBe(path.resolve("/repo/.roark/worktrees/issue-10"));
    expect(context.runDir).toBe(path.resolve("/repo", ".roark/runs/issue/10"));
    expect(context.runDirRelative).toBe(path.join(".roark/runs", "issue", "10"));
  });

  test("nests runDir under attempts/<n> when attempt is supplied", () => {
    const context = createWorkflowContext({ ...baseOptions, attempt: 2 });
    expect(context.runDir).toBe(path.resolve("/repo", ".roark/runs/issue/10/attempts/2"));
    expect(context.runDirRelative).toBe(path.join(".roark/runs", "issue", "10", "attempts", "2"));
    expect(context.attempt).toBe(2);
  });

  test("maps issue creation results artifact", () => {
    const context = createWorkflowContext(baseOptions);
    expect(artifactRelativePath(context, "issueCreationResults")).toBe(path.join(".roark/runs", "issue", "10", "issue-creation-results.json"));
  });

  test("maps agent artifact paths from split autorun worktrees", () => {
    const context = createWorkflowContext(baseOptions, { agentCwd: "/repo/.roark/worktrees/issue-10" });
    expect(artifactAgentPath(context, "issue")).toBe(path.join("..", "..", "runs", "issue", "10", "issue.md"));
  });
});
