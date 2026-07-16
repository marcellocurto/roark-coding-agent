import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { formatPrRevisionSummaryComment, postPrRevisionSummaryComment } from "./comments.ts";
import type { PrRevisionContext } from "./artifacts.ts";
import { getWorkflowThinkingConfig } from "../workflow/thinking.ts";
import { githubIssueCommentMaxChars } from "../github/comments.ts";

const tempDirs: string[] = [];
const originalPath = process.env["PATH"];

afterEach(async () => {
  process.env["PATH"] = originalPath;
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
  test("formats a concise reviewer-facing revision summary without internal artifacts", () => {
    const body = formatPrRevisionSummaryComment({
      context: context(),
      outcome: "published",
      reviewVerdict: "approve",
      verification: { ok: true, command: "/Users/alice/repo/check.sh", exitCode: 0, stdout: "", stderr: "" },
      dispositions: [{
        feedbackId: "comment:123",
        sourceIds: ["comment:123"],
        summary: "Improve error message at /Users/alice/repo/lib/example.ts.",
        classification: "must-fix-current",
        status: "addressed",
        details: "Returned the actionable error.",
      }],
      changedFiles: ["lib/example.ts"],
      commitSha: "abc1234",
    });

    expect(body).toStartWith("<!-- roark:pr=12 revision=1 phase=revision-summary -->");
    expect(body).toContain("`comment:123` **addressed**");
    expect(body).toContain("Improve error message at [local path redacted]");
    expect(body).toContain("### Feedback disposition");
    expect(body).not.toContain("### Addressed feedback");
    expect(body).not.toContain("### Skipped feedback");
    expect(body).toContain("- lib/example.ts");
    expect(body).toContain("- Commit: abc1234");
    expect(body).toContain("[local path redacted]");
    expect(body).not.toContain("<details>");
    expect(body).not.toContain("Feedback considered");
    expect(body).not.toContain("Revision artifact");
    expect(body).not.toContain(".roark/runs/");
    expect(Array.from(body).length).toBeLessThanOrEqual(githubIssueCommentMaxChars);
  });

  test("creates one new marked comment without listing or updating prior comments", async () => {
    const cwd = await installPostOnlyFakeGh();

    await postPrRevisionSummaryComment({
      context: context({ controlCwd: cwd }),
      outcome: "published",
      dispositions: [],
    });

    expect((await readFile(path.join(cwd, "operations.log"), "utf8")).trim()).toBe("post");
  });
});

async function installPostOnlyFakeGh(): Promise<string> {
  const cwd = await mkdtemp(path.join(tmpdir(), "roark-revision-comment-"));
  tempDirs.push(cwd);
  await writeFile(path.join(cwd, "operations.log"), "", "utf8");
  const binDir = path.join(cwd, "bin");
  await mkdir(binDir, { recursive: true });
  await writeFile(path.join(binDir, "gh"), `#!/usr/bin/env bash
set -euo pipefail
if [ "$1" = "api" ] && [ "$2" = "repos/owner/repo/issues/12/comments" ] && [[ " $* " = *" --method POST "* ]]; then
  printf 'post\\n' >> "${cwd}/operations.log"
  printf '{"id":43,"html_url":"https://example.test/comments/43"}\\n'
  exit 0
fi
printf 'unexpected: %s\\n' "$*" >> "${cwd}/operations.log"
exit 1
`, "utf8");
  await chmod(path.join(binDir, "gh"), 0o755);
  process.env["PATH"] = `${binDir}${path.delimiter}${originalPath ?? ""}`;
  return cwd;
}
