import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { formatPrRevisionSummaryComment, readRevisionExcerpts, selectRevisionExcerptFilenames } from "./comments.ts";
import type { PrRevisionContext } from "./artifacts.ts";
import { getWorkflowThinkingConfig } from "../workflow/thinking.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function context(overrides: Partial<PrRevisionContext> = {}): PrRevisionContext {
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
    ...overrides,
  };
}

describe("PR revision summary comments", () => {
  test("selects final fix-pass artifacts for revision excerpts", () => {
    expect(selectRevisionExcerptFilenames([
      ".roark/runs/pr/12/revision-1/pr-feedback.md",
      ".roark/runs/pr/12/revision-1/revision-plan.md",
      ".roark/runs/pr/12/revision-1/revision-log.md",
      ".roark/runs/pr/12/revision-1/revision-review.md",
      ".roark/runs/pr/12/revision-1/revision-log-fix-pass-1.md",
      ".roark/runs/pr/12/revision-1/revision-review-pass-1.md",
      ".roark/runs/pr/12/revision-1/revision-log-fix-pass-2.md",
      ".roark/runs/pr/12/revision-1/revision-review-pass-2.md",
    ])).toEqual([
      "pr-feedback.md",
      "revision-plan.md",
      "revision-log-fix-pass-2.md",
      "revision-review-pass-2.md",
    ]);
  });

  test("reads latest revision fix-pass excerpts instead of stale initial artifacts", async () => {
    const revisionDir = await mkdtemp(path.join(tmpdir(), "roark-pr-revision-excerpts-"));
    tempDirs.push(revisionDir);
    await mkdir(revisionDir, { recursive: true });
    await writeFile(path.join(revisionDir, "revision-log.md"), "initial log", "utf8");
    await writeFile(path.join(revisionDir, "revision-review.md"), "initial review", "utf8");
    await writeFile(path.join(revisionDir, "revision-log-fix-pass-1.md"), "final log", "utf8");
    await writeFile(path.join(revisionDir, "revision-review-pass-1.md"), "revision review", "utf8");

    const excerpts = await readRevisionExcerpts(context({ revisionDir }), [
      ".roark/runs/pr/12/revision-1/revision-log.md",
      ".roark/runs/pr/12/revision-1/revision-review.md",
      ".roark/runs/pr/12/revision-1/revision-log-fix-pass-1.md",
      ".roark/runs/pr/12/revision-1/revision-review-pass-1.md",
    ]);

    expect(excerpts).toEqual([
      { title: "revision-log-fix-pass-1.md", content: "final log" },
      { title: "revision-review-pass-1.md", content: "revision review" },
    ]);
  });

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
