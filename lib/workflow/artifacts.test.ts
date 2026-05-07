import { describe, expect, test } from "bun:test";
import path from "node:path";
import type { IssueCliOptions } from "../cli/args.ts";
import { artifactRelativePath, createWorkflowContext } from "./artifacts.ts";

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
    expect(context.runDir).toBe(path.resolve("/repo", ".roark/runs/issue/10"));
    expect(context.runDirRelative).toBe(path.join(".roark/runs", "issue", "10"));
    expect(context.attempt).toBeUndefined();
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
});
