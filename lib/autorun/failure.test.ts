import { describe, expect, test } from "bun:test";
import {
  buildFailureCommentArgv,
  buildFailureLabelArgv,
  defaultAutorunFailureLabel,
  formatFailureComment,
} from "./failure.ts";

describe("autorun failure", () => {
  test("default failure label is roark-failed", () => {
    expect(defaultAutorunFailureLabel).toBe("roark-failed");
  });

  test("formatFailureComment includes phase, reason, and artifact path", () => {
    const comment = formatFailureComment({
      issueNumber: 8,
      phase: "verification",
      reason: "verify command exited 2",
      artifactPath: ".roark/runs/issue/8/verification.md",
    });
    expect(comment).toBe(
      "Roark stopped on issue #8 at phase **verification**: verify command exited 2.\n\nArtifact: `.roark/runs/issue/8/verification.md`\n",
    );
  });

  test("formatFailureComment omits artifact line when no path is provided", () => {
    const comment = formatFailureComment({
      issueNumber: 8,
      phase: "readiness",
      reason: 'readiness status is "not-ready"',
    });
    expect(comment).toBe('Roark stopped on issue #8 at phase **readiness**: readiness status is "not-ready".\n');
    expect(comment).not.toContain("Artifact:");
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

  test("buildFailureCommentArgv composes a gh issue comment command", () => {
    expect(
      buildFailureCommentArgv({ issueNumber: 8, comment: "hi", repo: "owner/repo" }),
    ).toEqual(["gh", "issue", "comment", "8", "--body", "hi", "--repo", "owner/repo"]);
  });
});
