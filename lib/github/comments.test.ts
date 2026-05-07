import { describe, expect, test } from "bun:test";
import {
  buildCurrentRepoArgv,
  buildListIssueCommentsArgv,
  buildPostIssueCommentArgv,
  buildRoarkMarker,
  buildUpdateIssueCommentArgv,
  ensureCommentStartsWithMarker,
  findIssueCommentByMarker,
  parseGitHubCommentRef,
  parseIssueComments,
} from "./comments.ts";

describe("GitHub comment helpers", () => {
  test("buildRoarkMarker formats deterministic hidden markers", () => {
    expect(buildRoarkMarker({ issueNumber: 24, attempt: 2, phase: "review-a" })).toBe(
      "<!-- roark:issue=24 attempt=2 phase=review-a -->",
    );
  });

  test("ensureCommentStartsWithMarker prefixes bodies idempotently", () => {
    const marker = buildRoarkMarker({ issueNumber: 24, attempt: 2, phase: "readiness" });
    expect(ensureCommentStartsWithMarker("Body", marker)).toBe(`${marker}\nBody`);
    expect(ensureCommentStartsWithMarker(`${marker}\nBody`, marker)).toBe(`${marker}\nBody`);
  });

  test("builds gh api argv for issue comment operations", () => {
    expect(buildListIssueCommentsArgv({ repo: "owner/repo", issueNumber: 24 })).toEqual([
      "gh",
      "api",
      "repos/owner/repo/issues/24/comments",
      "--paginate",
      "--slurp",
    ]);
    expect(buildPostIssueCommentArgv({ repo: "owner/repo", issueNumber: 24, body: "hello" })).toEqual([
      "gh",
      "api",
      "repos/owner/repo/issues/24/comments",
      "--method",
      "POST",
      "--field",
      "body=hello",
    ]);
    expect(buildUpdateIssueCommentArgv({ repo: "owner/repo", commentId: 99, body: "updated" })).toEqual([
      "gh",
      "api",
      "repos/owner/repo/issues/comments/99",
      "--method",
      "PATCH",
      "--field",
      "body=updated",
    ]);
    expect(buildCurrentRepoArgv()).toEqual(["gh", "repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]);
  });

  test("parses comment refs and paginated comment lists", () => {
    expect(parseGitHubCommentRef(JSON.stringify({ id: 99, html_url: "https://example.test/comment" }), "marker")).toEqual({
      id: 99,
      url: "https://example.test/comment",
      marker: "marker",
    });

    const comments = parseIssueComments(JSON.stringify([
      [{ id: 1, body: "one" }],
      [{ id: 2, body: "<!-- roark:issue=24 attempt=2 phase=review-a -->\ntwo", html_url: "url" }],
    ]));
    expect(comments.map((comment) => comment.id)).toEqual([1, 2]);
    expect(findIssueCommentByMarker(comments, "phase=review-a")?.id).toBe(2);
  });
});
