import { describe, expect, test } from "bun:test";
import { buildPullRequestFeedbackGraphqlArgv, parsePullRequestFeedback, parseRestPullRequestComments } from "./pr.ts";

describe("pull request feedback parsing", () => {
  test("parses metadata, threads, comments, and excludes Roark revision summaries", () => {
    const feedback = parsePullRequestFeedback(JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            number: 12,
            title: "Draft work",
            body: "Closes #46",
            state: "OPEN",
            baseRefName: "main",
            headRefName: "roark/issue-46",
            baseRefOid: "base123",
            headRefOid: "head123",
            baseRepository: { nameWithOwner: "owner/repo", url: "https://github.com/owner/repo" },
            headRepository: { nameWithOwner: "owner/repo" },
            closingIssuesReferences: { nodes: [
              { number: 46, title: "Primary requirement", body: "Build it", state: "OPEN", repository: { nameWithOwner: "owner/repo" } },
              { number: 7, title: "External issue", body: "Not authoritative here", state: "OPEN", repository: { nameWithOwner: "other/repo" } },
            ] },
            comments: { nodes: [
              { id: "C1", databaseId: 101, body: "please fix", author: { login: "reviewer" } },
              { id: "C2", databaseId: 102, body: "<!-- roark:pr=12 revision=1 phase=revision-summary -->\nsummary" },
              { id: "C3", databaseId: 103, body: "<!-- roark:pr=12 phase=pr-review -->\nrequired fix" },
            ] },
            reviewThreads: { nodes: [
              { id: "T1", isResolved: false, isOutdated: false, path: "lib/a.ts", comments: { nodes: [
                { id: "RC1", body: "bug here", author: { login: "reviewer" }, path: "lib/a.ts", line: 3 },
              ] } },
            ], pageInfo: { hasNextPage: true } },
          },
        },
      },
    }), { repo: "owner/repo", prNumber: 12 });

    expect(feedback.pr.headRefName).toBe("roark/issue-46");
    expect(feedback.pr.baseRefOid).toBe("base123");
    expect(feedback.pr.headRefOid).toBe("head123");
    expect(feedback.pr.baseRepositoryUrl).toBe("https://github.com/owner/repo");
    expect(feedback.reviewThreads[0]?.isResolved).toBe(false);
    expect(feedback.reviewThreadsTruncated).toBe(true);
    expect(feedback.closingIssues?.map((issue) => [issue.repository, issue.number])).toEqual([["owner/repo", 46], ["other/repo", 7]]);
    expect(feedback.comments).toHaveLength(3);
    expect(feedback.plannerComments).toHaveLength(2);
    expect(feedback.plannerComments[0]?.body).toBe("please fix");
    expect(feedback.plannerComments[1]?.body).toContain("phase=pr-review");
    expect(feedback.excludedRoarkSummaryCommentIds).toEqual([102]);
  });

  test("also supports legacy unwrapped repository payloads", () => {
    const feedback = parsePullRequestFeedback(JSON.stringify({
      repository: {
        pullRequest: {
          number: 12,
          title: "Draft work",
          body: "",
          state: "OPEN",
          baseRefName: "main",
          headRefName: "feature",
          comments: { nodes: [] },
          reviewThreads: { nodes: [] },
        },
      },
    }), { repo: "owner/repo", prNumber: 12 });

    expect(feedback.pr.number).toBe(12);
  });

  test("fails loudly when review thread resolution state is unavailable", () => {
    expect(() => parsePullRequestFeedback(JSON.stringify({
      repository: {
        pullRequest: {
          number: 12,
          title: "Draft work",
          body: "",
          state: "OPEN",
          baseRefName: "main",
          headRefName: "feature",
          comments: { nodes: [] },
          reviewThreads: { nodes: [{ id: "T1", comments: { nodes: [] } }] },
        },
      },
    }), { repo: "owner/repo", prNumber: 12 })).toThrow("did not include boolean isResolved");
  });

  test("fails loudly when reviewThreads connection is missing", () => {
    expect(() => parsePullRequestFeedback(JSON.stringify({
      repository: {
        pullRequest: {
          number: 12,
          title: "Draft work",
          body: "",
          state: "OPEN",
          baseRefName: "main",
          headRefName: "feature",
          comments: { nodes: [] },
        },
      },
    }), { repo: "owner/repo", prNumber: 12 })).toThrow("valid pull request reviewThreads.nodes connection");
  });

  test("fails loudly when reviewThreads connection is malformed", () => {
    expect(() => parsePullRequestFeedback(JSON.stringify({
      repository: {
        pullRequest: {
          number: 12,
          title: "Draft work",
          body: "",
          state: "OPEN",
          baseRefName: "main",
          headRefName: "feature",
          comments: { nodes: [] },
          reviewThreads: { totalCount: 1 },
        },
      },
    }), { repo: "owner/repo", prNumber: 12 })).toThrow("valid pull request reviewThreads.nodes connection");
  });

  test("builds gh api graphql argv with repo variables", () => {
    const argv = buildPullRequestFeedbackGraphqlArgv({ repo: "owner/repo", prNumber: 12 });
    expect(argv.slice(0, 3)).toEqual(["gh", "api", "graphql"]);
    expect(argv).toContain("owner=owner");
    expect(argv).toContain("name=repo");
    expect(argv).toContain("number=12");
  });

  test("flattens every REST comment page for planner feedback", () => {
    const comments = parseRestPullRequestComments(JSON.stringify([
      [{ id: 1, node_id: "C1", body: "old", user: { login: "one" } }],
      [{ id: 2, node_id: "C2", body: "<!-- roark:pr=12 phase=pr-review --> current", user: { login: "roark" } }],
    ]));
    expect(comments.map((comment) => comment.databaseId)).toEqual([1, 2]);
    expect(comments[1]?.body).toContain("phase=pr-review");
  });
});
