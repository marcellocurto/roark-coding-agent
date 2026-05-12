import { describe, expect, test } from "bun:test";
import {
  buildFailureCommentArgv,
  buildFailureLabelArgv,
  buildRemoveLabelArgv,
  defaultAutorunFailureLabel,
  formatFailureComment,
} from "./failure.ts";

describe("autorun failure", () => {
  test("default failure label is roark-failed", () => {
    expect(defaultAutorunFailureLabel).toBe("roark-failed");
  });

  test("formatFailureComment includes phase, reason, issue number, and artifact path", () => {
    const comment = formatFailureComment({
      issueNumber: 8,
      phase: "verification",
      reason: "verify command exited 2",
      artifactPath: ".roark/runs/issue/8/verification.md",
    });
    expect(comment).toBe(
      "Roark stopped on issue #8 at phase **verification**: verify command exited 2.\n\nIssue: #8\nArtifact: `.roark/runs/issue/8/verification.md`\n",
    );
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
      artifactContent: "# PR Readiness\n\n## Status\nnot-ready\nlog: [/Users/alice/repo]\n",
      attemptMetadataPath: ".roark/runs/issue/10/attempts/2/attempt.json",
      recoveryCommand: "roark continue 10 --cwd /repo --repo owner/repo --attempt 2",
    });
    expect(comment).toContain(
      'Roark stopped on issue https://github.com/owner/repo/issues/10 at phase **readiness**: readiness status is "not-ready" at path:[local path redacted].',
    );
    expect(comment).toContain("Issue: #10");
    expect(comment).toContain("Branch: `roark/issue-10`");
    expect(comment).not.toContain("Worktree:");
    expect(comment).not.toContain("Workspace:");
    expect(comment).toContain("Artifact: `.roark/runs/issue/10/attempts/2/readiness.md`");
    expect(comment).toContain("Attempt: `.roark/runs/issue/10/attempts/2/attempt.json`");
    expect(comment).toContain("## Artifact contents");
    expect(comment).toContain("## Status\nnot-ready");
    expect(comment).toContain("log: [[local path redacted]]");
    expect(comment).toContain("## Recovery");
    expect(comment).not.toContain("--cwd");
    expect(comment).toContain("roark continue 10 --repo owner/repo --attempt 2");
  });

  test("formatFailureComment renders only the issue and attempt path when artifact path is omitted", () => {
    const comment = formatFailureComment({
      issueNumber: 10,
      phase: "readiness",
      reason: 'readiness status is "not-ready"',
      attemptMetadataPath: ".roark/runs/issue/10/attempts/1/attempt.json",
    });
    expect(comment).toContain("Issue: #10");
    expect(comment).toContain("Attempt: `.roark/runs/issue/10/attempts/1/attempt.json`");
    expect(comment).not.toContain("Artifact:");
  });

  test("formatFailureComment omits artifact and attempt lines when no paths are provided", () => {
    const comment = formatFailureComment({
      issueNumber: 8,
      phase: "readiness",
      reason: 'readiness status is "not-ready"',
    });
    expect(comment).toBe('Roark stopped on issue #8 at phase **readiness**: readiness status is "not-ready".\n\nIssue: #8\n');
    expect(comment).not.toContain("Artifact:");
    expect(comment).not.toContain("Attempt:");
  });

  test("buildFailureLabelArgv composes a gh issue edit command", () => {
    expect(
      buildFailureLabelArgv({ issueNumber: 8, label: "roark-failed", repo: "owner/repo" }),
    ).toEqual(["gh", "issue", "edit", "8", "--add-label", "roark-failed", "--repo", "owner/repo"]);
  });

  test("buildFailureLabelArgv omits --repo when not provided", () => {
    expect(buildFailureLabelArgv({ issueNumber: 8, label: "roark-failed" })).toEqual([
      "gh",
      "issue",
      "edit",
      "8",
      "--add-label",
      "roark-failed",
    ]);
  });

  test("buildRemoveLabelArgv composes a gh issue edit remove-label command", () => {
    expect(buildRemoveLabelArgv({ issueNumber: 8, label: "roark-in-progress", repo: "owner/repo" })).toEqual([
      "gh",
      "issue",
      "edit",
      "8",
      "--remove-label",
      "roark-in-progress",
      "--repo",
      "owner/repo",
    ]);
  });

  test("buildFailureCommentArgv composes a gh issue comment command", () => {
    expect(
      buildFailureCommentArgv({ issueNumber: 8, comment: "hi", repo: "owner/repo" }),
    ).toEqual(["gh", "issue", "comment", "8", "--body", "hi", "--repo", "owner/repo"]);
  });
});
