import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeArtifact, type WorkflowContext } from "../workflow/artifacts.ts";
import { getWorkflowThinkingConfig } from "../workflow/thinking.ts";
import { recordAttemptIssueComment, formatAttemptMetadata } from "./attempts.ts";

import {
  formatAttemptStartComment,
  formatPrCreatedComment,
  formatReviewLedgerComment,
  publishReviewLedgerComments,
} from "./ledger-comments.ts";
import { tick } from "../test-utils/async.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("autorun ledger comment publishing", () => {
  test("publishes existing Review A/B artifacts through the injected ledger publisher", async () => {
        await tick();
    const cwd = await mkdtemp(path.join(tmpdir(), "roark-ledger-comments-"));
    tempDirs.push(cwd);
    const workflowContext: WorkflowContext = {
      controlCwd: cwd,
      agentCwd: cwd,
      outDir: path.join(cwd, ".roark/runs"),
      runDir: path.join(cwd, ".roark/runs/issue/24/attempts/2"),
      runDirRelative: ".roark/runs/issue/24/attempts/2",
      issueInput: "24",
      issueNumber: "24",
      attempt: 2,
      force: false,
      yes: false,
      maxFixPasses: 1,
      thinkingConfig: getWorkflowThinkingConfig(),
    };
    await writeArtifact(workflowContext, "reviewA", "# Review A\n\n## Verdict\nfixes-required\n");
    await writeArtifact(workflowContext, "reviewB", "# Review B\n\n## Verdict\napprove\n");
    const attemptMetadata = formatAttemptMetadata({
      attempt: 2,
      issueNumber: 24,
      branch: "roark/issue-24",
      baseBranch: "main",
      worktreePath: cwd,
      runArtifactPath: workflowContext.runDirRelative,
      startedAt: "2026-05-07T00:00:00.000Z",
    });
    const calls: { phase: string; body: string }[] = [];

    await publishReviewLedgerComments({
      cwd,
      repo: "owner/repo",
      issue: { number: 24, title: "Ledger comments" },
      workflowContext,
      attemptMetadata,
    }, {
      publishIssueLedgerComment: async (input) => {
        await tick();
        calls.push({ phase: input.phase, body: input.body });
        recordAttemptIssueComment(input.attemptMetadata, input.phase, {
          id: input.phase === "review-a" ? 101 : 102,
          marker: `marker:${input.phase}`,
        }, "2026-05-07T00:01:00.000Z");
      },
    });

    expect(calls.map((call) => call.phase)).toEqual(["review-a", "review-b"]);
    expect(calls[0]?.body).toContain("Verdict: fixes-required");
    expect(calls[1]?.body).toContain("Verdict: approve");
    expect(attemptMetadata.githubComments?.issue?.["review-a"]?.id).toBe(101);
    expect(attemptMetadata.githubComments?.issue?.["review-b"]?.id).toBe(102);
  });
});

describe("autorun ledger comment formatters", () => {
  test("formats marker-prefixed attempt start comments", () => {
    const body = formatAttemptStartComment({
      issueNumber: 24,
      attempt: 2,
      branchName: "roark/issue-24",
      assignee: "octocat",
      attemptMetadataPath: ".roark/runs/issue/24/attempts/2/attempt.json",
    });

    expect(body).toStartWith("<!-- roark:issue=24 attempt=2 phase=attempt-start -->");
    expect(body).toContain("## Roark attempt 2 started");
    expect(body).toContain("@octocat is attempting this issue in branch `roark/issue-24`.");
    expect(body).toContain("Attempt: `.roark/runs/issue/24/attempts/2/attempt.json`");
  });

  test("formats review comments with verdict and artifact contents", () => {
    const body = formatReviewLedgerComment({
      issueNumber: 24,
      attempt: 2,
      phase: "review-a",
      title: "Review A",
      artifactPath: ".roark/runs/issue/24/attempts/2/review-a.md",
      artifactContent: "# Review\n\n## Verdict\nfixes-required\npath:/Users/alice/repo\n",
    });

    expect(body).toStartWith("<!-- roark:issue=24 attempt=2 phase=review-a -->");
    expect(body).toContain("## Roark Review A — attempt 2");
    expect(body).toContain("Verdict: fixes-required");
    expect(body).toContain("Artifact: `.roark/runs/issue/24/attempts/2/review-a.md`");
    expect(body).toContain("## Verdict\nfixes-required");
    expect(body).toContain("path:[local path redacted]");
    expect(body).not.toContain("/Users/alice/repo");
  });

  test("formats PR created comments", () => {
    const body = formatPrCreatedComment({
      issueNumber: 24,
      attempt: 2,
      prUrl: "https://github.com/owner/repo/pull/30",
      attemptMetadataPath: ".roark/runs/issue/24/attempts/2/attempt.json",
    });

    expect(body).toStartWith("<!-- roark:issue=24 attempt=2 phase=pr-created -->");
    expect(body).toContain("PR: https://github.com/owner/repo/pull/30");
    expect(body).toContain("Attempt: `.roark/runs/issue/24/attempts/2/attempt.json`");
  });
});
