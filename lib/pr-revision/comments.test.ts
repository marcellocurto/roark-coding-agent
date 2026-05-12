import { describe, expect, test } from "bun:test";
import { formatPrRevisionSummaryComment } from "./comments.ts";
import type { PrRevisionContext } from "./artifacts.ts";
import { getWorkflowThinkingConfig } from "../workflow/thinking.ts";

function context(): PrRevisionContext {
  return {
    cwd: "/repo",
    prNumber: 12,
    revision: 1,
    repo: "owner/repo",
    controlCwd: "/repo",
    agentCwd: "/repo",
    outDir: "/repo/.roark/runs",
    prDir: "/repo/.roark/runs/pr/12",
    revisionDir: "/repo/.roark/runs/pr/12/revision-1",
    revisionDirRelative: ".roark/runs/pr/12/revision-1",
    agentRevisionDir: "/repo/.roark/runs/pr/12/revision-1",
    agentRevisionDirRelative: ".roark/runs/pr/12/revision-1",
    verifyCommand: "bun test",
    remote: "origin",
    model: undefined,
    thinkingConfig: getWorkflowThinkingConfig(),
    maxFixPasses: 1,
    force: false,
    yes: false,
    comment: true,
  };
}

describe("PR revision summary comments", () => {
  test("formats reviewer-focused revision details with marker and sanitized excerpts", () => {
    const body = formatPrRevisionSummaryComment({
      context: context(),
      outcome: "published",
      planStatus: "revise",
      reviewVerdict: "approve",
      verification: { ok: true, command: "/Users/alice/repo/check.sh", exitCode: 0, stdout: "", stderr: "" },
      feedbackConsidered: ["Reviewer asked for clearer errors."],
      addressed: ["Improved error message."],
      skipped: ["None."],
      changedFiles: ["lib/example.ts"],
      commitSha: "abc1234",
      artifactPaths: [".roark/runs/pr/12/revision-1/revision-plan.md"],
      artifactExcerpts: [{ title: "revision-plan.md", content: "# Revision Plan\n\nTOKEN=secret\n" }],
    });

    expect(body).toStartWith("<!-- roark:pr=12 revision=1 phase=revision-summary -->");
    expect(body).toContain("### Feedback considered");
    expect(body).toContain("- Improved error message.");
    expect(body).toContain("- lib/example.ts");
    expect(body).toContain("- Commit: abc1234");
    expect(body).toContain("[local path redacted]");
    expect(body).toContain("TOKEN=[redacted]");
    expect(body).not.toContain("TOKEN=secret");
  });
});
