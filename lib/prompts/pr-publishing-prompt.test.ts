import { describe, expect, test } from "bun:test";
import { createWorkflowContext } from "../workflow/artifacts.ts";
import { prBodyUpdatePrompt, prCreatePrompt } from "./pr-publishing-prompt.ts";

describe("PR publishing prompts", () => {
  test("create prompt requires agent-authored PR body", () => {
    const context = createWorkflowContext({
      command: "do",
      issue: "12",
      cwd: "/repo",
      outDir: ".roark/runs",
      repo: "owner/repo",
      force: false,
      yes: true,
      maxFixPasses: 1,
      attempt: 2,
    });

    const prompt = prCreatePrompt({
      context,
      repo: "owner/repo",
      sourceIssue: { number: 12, title: "Fix exports", url: "https://github.com/owner/repo/issues/12" },
      branchName: "roark/issue-12",
      baseBranch: "main",
      artifactPaths: [".roark/runs/issue/12/attempts/2/implementation-log.md"],
    });

    expect(prompt).toContain("Write the final PR title and body yourself");
    expect(prompt).toContain("Do not copy a deterministic PR body template or artifact dump");
    expect(prompt).toContain("Closes #12");
    expect(prompt).toContain("<branch>roark/issue-12</branch>");
    expect(prompt).toContain("Return only JSON");
  });

  test("update prompt preserves authored prose while adding follow-up issue links", () => {
    const context = createWorkflowContext({
      command: "do",
      issue: "12",
      cwd: "/repo",
      outDir: ".roark/runs",
      repo: "owner/repo",
      force: false,
      yes: true,
      maxFixPasses: 1,
      attempt: 2,
    });

    const prompt = prBodyUpdatePrompt({
      context,
      repo: "owner/repo",
      sourceIssue: { number: 12, title: "Fix exports" },
      branchName: "roark/issue-12",
      baseBranch: "main",
      prUrl: "https://github.com/owner/repo/pull/55",
      followUpIssues: [{ title: "Add regression test", number: 80, url: "https://github.com/owner/repo/issues/80" }],
      artifactPaths: [],
    });

    expect(prompt).toContain("Fetch the current PR title/body with gh before editing");
    expect(prompt).toContain("Preserve the existing human-authored PR explanation");
    expect(prompt).toContain("#80 https://github.com/owner/repo/issues/80");
    expect(prompt).toContain("Do not replace the PR body with a deterministic template or artifact dump");
  });
});
