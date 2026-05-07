import { describe, expect, test } from "bun:test";
import {
  buildBodyBlockerViewArgv,
  buildIssueBlockedByDependenciesArgv,
  buildIssueBlockingDependenciesArgv,
  buildIssueDependenciesSummaryArgv,
  normalizeGitHubIssueDependency,
  parseBodyDeclaredBlockerRefs,
} from "./issue.ts";

describe("GitHub issue dependency argv builders", () => {
  test("builds gh api dependency paths", () => {
    expect(buildIssueDependenciesSummaryArgv("owner/repo", 12)).toEqual(["gh", "api", "repos/owner/repo/issues/12"]);
    expect(buildIssueBlockedByDependenciesArgv("owner/repo", 12)).toEqual([
      "gh",
      "api",
      "repos/owner/repo/issues/12/dependencies/blocked_by",
    ]);
    expect(buildIssueBlockingDependenciesArgv("owner/repo", 12)).toEqual([
      "gh",
      "api",
      "repos/owner/repo/issues/12/dependencies/blocking",
    ]);
  });

  test("builds body blocker verification command", () => {
    expect(buildBodyBlockerViewArgv({ repo: "owner/repo", number: 7 })).toEqual([
      "gh",
      "issue",
      "view",
      "7",
      "--repo",
      "owner/repo",
      "--json",
      "number,title,state,stateReason,closed,closedAt,url",
    ]);
  });
});

describe("parseBodyDeclaredBlockerRefs", () => {
  test("parses conservative blocked-by headings and inline declarations", () => {
    const refs = parseBodyDeclaredBlockerRefs(
      [
        "Mention #1 elsewhere should be ignored.",
        "## Blocked by",
        "- #7",
        "- owner/other#8",
        "- https://github.com/up/down/issues/9",
        "## Notes",
        "Blocked by: #10 and owner/repo#11",
      ].join("\n"),
      "owner/repo",
    );

    expect(refs).toEqual([
      { raw: "#7", repo: "owner/repo", number: 7 },
      { raw: "owner/other#8", repo: "owner/other", number: 8 },
      { raw: "https://github.com/up/down/issues/9", repo: "up/down", number: 9 },
      { raw: "#10", repo: "owner/repo", number: 10 },
      { raw: "owner/repo#11", repo: "owner/repo", number: 11 },
    ]);
  });

  test("parses explicit depends-on declarations", () => {
    const refs = parseBodyDeclaredBlockerRefs(
      [
        "Depends on #12",
        "Depends on owner/other#13",
        "- Depends on: https://github.com/up/down/issues/14",
        "Depends on whether #99 should be closed.",
        "This merely mentions depends on #100 in prose and should be ignored.",
      ].join("\n"),
      "owner/repo",
    );

    expect(refs).toEqual([
      { raw: "#12", repo: "owner/repo", number: 12 },
      { raw: "owner/other#13", repo: "owner/other", number: 13 },
      { raw: "https://github.com/up/down/issues/14", repo: "up/down", number: 14 },
    ]);
  });

  test("skips fenced code blocks and de-dupes refs", () => {
    const refs = parseBodyDeclaredBlockerRefs(
      [
        "```",
        "Blocked by: #99",
        "```",
        "### Blocked by",
        "#7",
        "owner/repo#7",
      ].join("\n"),
      "owner/repo",
    );

    expect(refs).toEqual([{ raw: "#7", repo: "owner/repo", number: 7 }]);
  });
});

describe("normalizeGitHubIssueDependency", () => {
  test("normalizes snake_case and closed dependency fields", () => {
    expect(normalizeGitHubIssueDependency({
      number: 7,
      title: "Old blocker",
      html_url: "https://github.com/owner/repo/issues/7",
      state: "closed",
      state_reason: "completed",
      closed_at: "2026-01-01T00:00:00Z",
    })).toEqual({
      number: 7,
      title: "Old blocker",
      url: "https://github.com/owner/repo/issues/7",
      state: "CLOSED",
      stateReason: "completed",
      closedAt: "2026-01-01T00:00:00Z",
    });
  });
});
