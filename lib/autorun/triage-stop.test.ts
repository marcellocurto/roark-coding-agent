import { describe, expect, test } from "bun:test";
import {
  buildTriageStopAddLabelArgv,
  buildTriageStopCommentArgv,
  buildTriageStopRemoveLabelArgv,
  formatTriageStoppedComment,
  mapTriageVerdictToLabel,
  parseTriageStoppedVerdict,
} from "./triage-stop.ts";

describe("triage stop handling", () => {
  test("maps verdicts to terminal labels", () => {
    expect(mapTriageVerdictToLabel("blocked")).toBe("blocked");
    expect(mapTriageVerdictToLabel("needs-human-decision")).toBe("needs-human");
    expect(mapTriageVerdictToLabel("reject")).toBe("needs-human");
    expect(mapTriageVerdictToLabel("unexpected-terminal-verdict")).toBe("needs-human");
  });

  test("parses triage verdict markdown", () => {
    expect(parseTriageStoppedVerdict("# Triage\n\n## Verdict\nneeds-human-decision\n")).toBe("needs-human-decision");
  });

  test("formats concise non-failure comment", () => {
    const comment = formatTriageStoppedComment({
      issueNumber: 12,
      triageVerdict: "blocked",
      triageArtifactPath: ".roark/runs/issue/12/triage.md",
      attemptMetadataPath: ".roark/runs/issue/12/attempts/1/attempt.json",
    });

    expect(comment).toContain("verdict **blocked**");
    expect(comment).toContain("clean terminal triage outcome");
    expect(comment).toContain("did not run verification, push the branch, or create a PR");
    expect(comment.toLowerCase()).not.toContain("failed");
    expect(comment.toLowerCase()).not.toContain("error");
  });

  test("includes a sanitized collapsed triage excerpt when content is provided", () => {
    const comment = formatTriageStoppedComment({
      issueNumber: 12,
      triageVerdict: "blocked",
      triageArtifactContent: "# Triage\n\n## Verdict\nblocked\nAPI_KEY=secret\n",
    });

    expect(comment).toContain("<details><summary>Triage artifact excerpt</summary>");
    expect(comment).toContain("API_KEY=[redacted]");
    expect(comment).not.toContain("API_KEY=secret");
  });

  test("builds gh argv for labels and comments", () => {
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
    expect(buildTriageStopCommentArgv({ repo: "owner/repo", issueNumber: 12, comment: "body" })).toEqual([
      "gh",
      "issue",
      "comment",
      "12",
      "--body",
      "body",
      "--repo",
      "owner/repo",
    ]);
  });
});
