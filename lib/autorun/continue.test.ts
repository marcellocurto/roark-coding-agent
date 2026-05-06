import { describe, expect, test } from "bun:test";
import type { ContinueCliOptions } from "../cli/args.ts";
import { createContinueWorkflowOptions } from "./continue.ts";

const continueOptions = {
  command: "continue",
  issue: "123",
  cwd: "/repo",
  outDir: ".roark/runs",
  repo: "owner/repo",
  model: "provider/model",
  thinkingLevel: "high",
  force: false,
  yes: true,
  maxFixPasses: 3,
  attempt: 2,
  verifyCommand: "bun test",
  failureLabel: "failed",
  successLabel: "opened",
  inProgressLabel: "busy",
  remote: "origin",
} satisfies ContinueCliOptions;

describe("createContinueWorkflowOptions", () => {
  test("targets the existing attempt with issue workflow options", () => {
    const workflowOptions = createContinueWorkflowOptions(continueOptions, 2);
    expect(workflowOptions).toEqual({
      command: "do",
      issue: "123",
      cwd: "/repo",
      outDir: ".roark/runs",
      repo: "owner/repo",
      model: "provider/model",
      thinkingLevel: "high",
      force: false,
      yes: true,
      maxFixPasses: 3,
      attempt: 2,
    });
  });
});
