import { describe, expect, test } from "bun:test";
import {
  buildFailureLabelArgv,
  buildRemoveLabelArgv,
  formatFailureComment,
} from "./failure.ts";
import { githubIssueCommentMaxChars } from "../github/comments.ts";

describe("autorun failure", () => {
  test("formatFailureComment omits verification artifact contents", () => {
    const comment = formatFailureComment({
      issueNumber: 8,
      phase: "verification",
      reason: "verification command exited 1",
      artifactPath: ".roark/runs/issue/8/attempts/1/verification.md",
      artifactContent: "# Verification\n\n## Stdout (tail)\n```\nSECRET_OUTPUT\n```\n\n## Stderr (tail)\n```\nTOKEN=leaked\n```\n",
    });

    expect(comment).toContain("Artifact: `.roark/runs/issue/8/attempts/1/verification.md`");
    expect(comment).not.toContain("SECRET_OUTPUT");
    expect(comment).not.toContain("TOKEN=leaked");
  });

  test("formatFailureComment includes branch, attempt path, redacted artifact contents, and safe recovery command", () => {
    const comment = formatFailureComment({
      issueNumber: 10,
      issueUrl: "https://github.com/owner/repo/issues/10",
      phase: "readiness",
      reason: 'readiness status is "not-ready" at path:/Users/alice/repo',
      branchName: "roark/issue-10",
      worktreePath: "/repo/.roark/worktrees/issue-10",
      artifactPath: ".roark/runs/issue/10/attempts/2/readiness.md",
      artifactContent: `# PR Readiness\n\n## Status\nnot-ready\nlog: [/Users/alice/repo]\n${"x".repeat(70_000)}`,
      attemptMetadataPath: ".roark/runs/issue/10/attempts/2/attempt.json",
      recoveryCommand: "roark continue 10 --cwd /repo --repo owner/repo --attempt 2",
    });
    expect(comment).toContain(
      'Roark stopped on issue https://github.com/owner/repo/issues/10 at phase **readiness**: readiness status is "not-ready" at path:[local path redacted].',
    );
    expect(comment).toContain("Branch: `roark/issue-10`");
    expect(comment).not.toContain("Worktree:");
    expect(comment).not.toContain("Workspace:");
    expect(comment).toContain("Artifact: `.roark/runs/issue/10/attempts/2/readiness.md`");
    expect(comment).toContain("Attempt: `.roark/runs/issue/10/attempts/2/attempt.json`");
    expect(comment).toContain("## Status\nnot-ready");
    expect(comment).toContain("log: [[local path redacted]]");
    expect(comment).toContain("## Recovery");
    expect(comment.indexOf("## Recovery")).toBeLessThan(comment.indexOf("# PR Readiness"));
    expect(comment).not.toContain("--cwd");
    expect(comment).toContain("roark continue 10 --repo owner/repo --attempt 2");
    expect(comment).toContain("details truncated");
    expect(Array.from(comment).length).toBeLessThanOrEqual(githubIssueCommentMaxChars);
  });

  test("formatFailureComment removes shell-quoted cwd values from recovery commands", () => {
    const comment = formatFailureComment({
      issueNumber: 10,
      phase: "readiness",
      reason: 'readiness status is "not-ready"',
      recoveryCommand: "roark continue 10 --cwd '/Users/alice/it'\\''s/repo' --repo owner/repo --attempt 2",
    });

    expect(comment).not.toContain("--cwd");
    expect(comment).not.toContain("alice");
    expect(comment).not.toContain("repo' --repo");
    expect(comment).toContain("roark continue 10 --repo owner/repo --attempt 2");
  });

  test("buildFailureLabelArgv composes a gh issue edit command", () => {
    expect(
      buildFailureLabelArgv({ issueNumber: 8, label: "agent-failed", repo: "owner/repo" }),
    ).toEqual(["gh", "issue", "edit", "8", "--add-label", "agent-failed", "--repo", "owner/repo"]);
  });

  test("buildFailureLabelArgv omits --repo when not provided", () => {
    expect(buildFailureLabelArgv({ issueNumber: 8, label: "agent-failed" })).toEqual([
      "gh",
      "issue",
      "edit",
      "8",
      "--add-label",
      "agent-failed",
    ]);
  });

  test("buildRemoveLabelArgv composes a gh issue edit remove-label command", () => {
    expect(buildRemoveLabelArgv({ issueNumber: 8, label: "agent-in-progress", repo: "owner/repo" })).toEqual([
      "gh",
      "issue",
      "edit",
      "8",
      "--remove-label",
      "agent-in-progress",
      "--repo",
      "owner/repo",
    ]);
  });
});
