import { describe, expect, test } from "bun:test";
import {
  buildTriageStopAddLabelArgv,
  buildTriageStopCommentArgv,
  buildTriageStopRemoveLabelArgv,
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
