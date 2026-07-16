import { describe, expect, test } from "bun:test";
import {
  buildTriageStopAddLabelArgv,
  buildTriageStopRemoveLabelArgv,
  formatTriageStoppedComment,
  mapTriageVerdictToLabel,
  parseTriageStoppedVerdict,
} from "./triage-stop.ts";

describe("triage stop handling", () => {
  test("maps verdicts to terminal labels", () => {
    expect(mapTriageVerdictToLabel("blocked")).toBe("blocked");
    expect(mapTriageVerdictToLabel("needs-human-decision")).toBe("needs-human");
    expect(mapTriageVerdictToLabel("reject")).toBe("triage-rejected");
    expect(mapTriageVerdictToLabel("unexpected-terminal-verdict")).toBe("needs-human");
  });

  test("parses triage verdict markdown", () => {
    expect(parseTriageStoppedVerdict("# Triage\n\n## Verdict\nneeds-human-decision\n")).toBe("needs-human-decision");
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

  test("uses the complete sanitized triage artifact as the comment body", () => {
    const evidence = "x".repeat(10_001);
    const comment = formatTriageStoppedComment({
      issueNumber: 12,
      triageVerdict: "reject",
      triageArtifactContent: `# Triage\n\nTOKEN=secret\n/Users/alice/private\n${evidence}`,
    });

    expect(comment).toBe(`# Triage\n\nTOKEN=[redacted]\n[local path redacted]\n${evidence}\n`);
  });
});
