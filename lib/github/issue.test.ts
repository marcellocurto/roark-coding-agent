import { chmod, copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runApplicationPromise } from "../runtime/application.ts";
import { GitHubResponseError } from "./errors.ts";
import { Effect } from "effect";
import { describe, expect, test } from "bun:test";
import {
  buildBodyBlockerViewArgv,
  buildIssueBlockedByDependenciesArgv,
  buildIssueBlockingDependenciesArgv,
  buildIssueDependenciesSummaryArgv,
  parseGitHubIssueDependencies,
  fetchGitHubIssue,
  parseBodyDeclaredBlockerRefs,
} from "./issue.ts";
describe("GitHub issue dependency argv builders", () => {
  test("builds gh api dependency paths", () => {
    expect(buildIssueDependenciesSummaryArgv("owner/repo", 12)).toEqual([
      "gh",
      "api",
      "repos/owner/repo/issues/12",
    ]);
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
    expect(buildBodyBlockerViewArgv({ repo: "owner/repo", number: 7 })).toEqual(
      [
        "gh",
        "issue",
        "view",
        "7",
        "--repo",
        "owner/repo",
        "--json",
        "number,title,state,stateReason,closed,closedAt,url",
      ],
    );
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
      {
        raw: "https://github.com/up/down/issues/9",
        repo: "up/down",
        number: 9,
      },
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
      {
        raw: "https://github.com/up/down/issues/14",
        repo: "up/down",
        number: 14,
      },
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
describe("parseGitHubIssueDependencies", () => {
  test("normalizes snake_case and closed dependency fields", () => {
    expect(
      Effect.runSync(
        parseGitHubIssueDependencies(
          JSON.stringify([
            {
              number: 7,
              title: "Old blocker",
              html_url: "https://github.com/owner/repo/issues/7",
              state: "closed",
              state_reason: "completed",
              closed_at: "2026-01-01T00:00:00Z",
            },
          ]),
        ),
      )[0],
    ).toEqual({
      number: 7,
      title: "Old blocker",
      url: "https://github.com/owner/repo/issues/7",
      state: "CLOSED",
      stateReason: "completed",
      closedAt: "2026-01-01T00:00:00Z",
    });
  });
});

test("accepts dependency response envelopes and preserves closed-state aliases", () => {
  const dependency = {
    number: 7,
    state: "closed",
    stateReason: null,
    state_reason: "completed",
  };
  for (const payload of [
    [dependency],
    { blocked_by: [dependency] },
    { blockedBy: [dependency] },
    { blocking: [dependency] },
    { nodes: [null, dependency] },
    { items: [dependency] },
  ]) {
    const results = Effect.runSync(
      parseGitHubIssueDependencies(JSON.stringify(payload)),
    );
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      number: 7,
      state: "CLOSED",
      stateReason: "completed",
    });
  }
});

test.each([
  "not json",
  "{}",
  '[{"title":"missing identity"}]',
  '[{"number":7,"state":42}]',
])("rejects malformed dependencies: %s", (raw) => {
  expect(() => Effect.runSync(parseGitHubIssueDependencies(raw))).toThrow(
    GitHubResponseError,
  );
});

test("issue snapshots retain deleted-author comments and mark malformed relationship responses unavailable", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "roark-issue-responses-"));
  const previousPath = process.env["PATH"];
  try {
    await copyFile(
      new URL("../testing/fixtures/github-issue-responses.sh", import.meta.url),
      path.join(cwd, "gh"),
    );
    await chmod(path.join(cwd, "gh"), 0o755);
    await Promise.all([
      writeFile(
        path.join(cwd, "issue.json"),
        JSON.stringify({
          number: 12,
          title: "Issue",
          body: "Blocked by: #7",
          comments: [{ body: "retained comment", author: null }],
        }),
      ),
      writeFile(path.join(cwd, "summary.json"), "{}"),
      writeFile(
        path.join(cwd, "blocked-by.json"),
        '[{"title":"missing number"}]',
      ),
      writeFile(path.join(cwd, "blocking.json"), "[]"),
      writeFile(path.join(cwd, "blocker.json"), '{"closed":true}'),
    ]);
    process.env["PATH"] = `${cwd}${path.delimiter}${previousPath ?? ""}`;
    const snapshot = await runApplicationPromise(
      fetchGitHubIssue("12", { cwd, repo: "owner/repo" }),
    );
    expect(snapshot.issue.comments?.[0]).toMatchObject({
      body: "retained comment",
      author: undefined,
    });
    expect(snapshot.relationships.nativeDependenciesAvailable).toBe(false);
    expect(snapshot.relationships.unavailableReason).toContain("number");
    expect(snapshot.relationships.bodyDeclaredBlockers).toHaveLength(1);
    expect(snapshot.relationships.bodyDeclaredBlockers[0]).toMatchObject({
      number: 7,
      verified: false,
    });
    expect(
      snapshot.relationships.bodyDeclaredBlockers[0]?.unavailableReason,
    ).toContain("number");

    await Promise.all([
      writeFile(
        path.join(cwd, "blocked-by.json"),
        JSON.stringify([
          { number: 7, state: "closed" },
          { number: 8, state: "open" },
        ]),
      ),
      writeFile(
        path.join(cwd, "blocker.json"),
        JSON.stringify({ number: 7, state: "CLOSED", closed: true }),
      ),
    ]);
    const recovered = await runApplicationPromise(
      fetchGitHubIssue("12", { cwd, repo: "owner/repo" }),
    );
    expect(recovered.relationships.nativeDependenciesAvailable).toBe(true);
    expect(recovered.relationships.issueDependenciesSummary).toEqual({
      blockedBy: 1,
      blocking: 0,
      totalBlockedBy: 2,
      totalBlocking: 0,
    });
    expect(recovered.relationships.bodyDeclaredBlockers[0]).toMatchObject({
      number: 7,
      verified: true,
      closed: true,
    });
  } finally {
    if (previousPath === undefined) delete process.env["PATH"];
    else process.env["PATH"] = previousPath;
    await rm(cwd, { recursive: true, force: true });
  }
});
