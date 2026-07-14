import { describe, expect, test } from "bun:test";
import {
  buildTriageStopAddLabelArgv,
  buildTriageStopRemoveLabelArgv,
  formatTriageStoppedComment,
  mapTriageVerdictToLabel,
} from "./triage-stop.ts";
import { githubIssueCommentMaxChars } from "../github/comments.ts";

describe("triage stop handling", () => {
  test("maps verdicts to terminal labels", () => {
    expect(mapTriageVerdictToLabel("blocked")).toBe("blocked");
    expect(mapTriageVerdictToLabel("needs-human-decision")).toBe("needs-human");
    expect(mapTriageVerdictToLabel("reject")).toBe("needs-human");
    expect(mapTriageVerdictToLabel("unexpected-terminal-verdict")).toBe("needs-human");
  });

  test("builds gh argv for labels", () => {
    expect(buildTriageStopAddLabelArgv({ repo: "owner/repo", issueNumber: 12, label: "blocked" })).toEqual([
      "gh",
      "issue",
      "edit",
      "12",
      "--add-label",
      "blocked",
      "--repo",
      "owner/repo",
    ]);
    expect(buildTriageStopRemoveLabelArgv({ repo: "owner/repo", issueNumber: 12, label: "roark-in-progress" })).toEqual([
      "gh",
      "issue",
      "edit",
      "12",
      "--remove-label",
      "roark-in-progress",
      "--repo",
      "owner/repo",
    ]);
  });

  test("publishes sanitized triage artifact content", () => {
    const comment = formatTriageStoppedComment({
      issueNumber: 12,
      triageVerdict: "reject",
      triageArtifactContent: `# Triage\n\nUnique terminal evidence at /Users/alice/private with TOKEN=secret.\n${"x".repeat(70_000)}`,
    });

    expect(comment).toContain("Unique terminal evidence at [local path redacted] with TOKEN=[redacted]");
    expect(comment).not.toContain("/Users/alice/private");
    expect(comment).not.toContain("TOKEN=secret");
    expect(comment.indexOf("Roark stopped issue")).toBeLessThan(comment.indexOf("# Triage"));
    expect(comment).toContain("details truncated");
    expect(Array.from(comment).length).toBeLessThanOrEqual(githubIssueCommentMaxChars);
  });
});
