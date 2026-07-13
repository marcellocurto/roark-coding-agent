import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildCurrentRepoArgv,
  buildCurrentCommentAuthorArgv,
  buildListIssueCommentsArgv,
  buildPostIssueCommentArgv,
  buildRoarkMarker,
  buildUpdateIssueCommentArgv,
  ensureCommentStartsWithMarker,
  findIssueCommentByMarker,
  parseGitHubCommentRef,
  parseIssueComments,
  postOrUpdateIssueCommentByMarker,
} from "./comments.ts";

const tempDirs: string[] = [];
const originalPath = process.env["PATH"];

afterEach(async () => {
  process.env["PATH"] = originalPath;
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

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
    expect(buildCurrentCommentAuthorArgv()).toEqual(["gh", "api", "user", "--jq", ".login"]);
  });

  test("parses comment refs and paginated comment lists", () => {
    expect(parseGitHubCommentRef(JSON.stringify({ id: 99, html_url: "https://example.test/comment" }), "marker")).toEqual({
      id: 99,
      url: "https://example.test/comment",
      marker: "marker",
    });

    const comments = parseIssueComments(JSON.stringify([
      [{ id: 1, body: "one" }],
      [{ id: 2, body: "<!-- roark:issue=24 attempt=2 phase=review-a -->\ntwo", html_url: "url", user: { login: "roark-bot" } }],
    ]));
    expect(comments.map((comment) => comment.id)).toEqual([1, 2]);
    expect(findIssueCommentByMarker(comments, "phase=review-a")?.id).toBe(2);
    expect(findIssueCommentByMarker(comments, "phase=review-a", "someone-else")).toBeUndefined();
  });
});

describe("postOrUpdateIssueCommentByMarker", () => {
  test("updates a persisted comment directly and resolves the current repo when omitted", async () => {
    const cwd = await installFakeGh("stored");
    const marker = buildRoarkMarker({ issueNumber: 24, attempt: 2, phase: "review-a" });

    const ref = await postOrUpdateIssueCommentByMarker({
      cwd,
      issueNumber: 24,
      existingCommentId: 99,
      marker,
      body: "Updated review",
    });

    expect(ref).toEqual({ id: 99, url: "https://example.test/comments/99", marker });
    expect(await operations(cwd)).toEqual(["repo", "patch:99"]);
  });

  test("falls back from a deleted persisted comment to marker lookup", async () => {
    const cwd = await installFakeGh("fallback");
    const marker = buildRoarkMarker({ issueNumber: 24, attempt: 2, phase: "review-a" });

    const ref = await postOrUpdateIssueCommentByMarker({
      cwd,
      repo: "owner/repo",
      issueNumber: 24,
      existingCommentId: 99,
      marker,
      body: "Updated review",
    });

    expect(ref.id).toBe(42);
    expect(await operations(cwd)).toEqual(["patch:99", "list", "author", "patch:42"]);
  });

  test("creates an owned marked comment when only another author spoofed the marker", async () => {
    const cwd = await installFakeGh("create");
    const marker = buildRoarkMarker({ issueNumber: 24, attempt: 2, phase: "readiness" });

    const ref = await postOrUpdateIssueCommentByMarker({
      cwd,
      repo: "owner/repo",
      issueNumber: 24,
      marker,
      body: "Ready",
    });

    expect(ref).toEqual({ id: 43, url: "https://example.test/comments/43", marker });
    expect(await operations(cwd)).toEqual(["list", "author", "post"]);
  });
});

async function operations(cwd: string): Promise<string[]> {
  return (await readFile(path.join(cwd, "operations.log"), "utf8")).trim().split("\n").filter(Boolean);
}

async function installFakeGh(mode: "stored" | "fallback" | "create"): Promise<string> {
  const cwd = await mkdtemp(path.join(tmpdir(), "roark-comments-"));
  tempDirs.push(cwd);
  await writeFile(path.join(cwd, "mode.txt"), mode, "utf8");
  await writeFile(path.join(cwd, "operations.log"), "", "utf8");
  const binDir = path.join(cwd, "bin");
  await mkdir(binDir, { recursive: true });
  await writeFile(path.join(binDir, "gh"), `#!/usr/bin/env bash
set -euo pipefail
mode=$(cat "${cwd}/mode.txt")
if [ "$1" = "repo" ]; then
  printf 'repo\n' >> "${cwd}/operations.log"
  printf 'owner/repo\n'
  exit 0
fi
if [ "$1" != "api" ]; then
  exit 1
fi
endpoint=$2
if [ "$endpoint" = "user" ]; then
  printf 'author\n' >> "${cwd}/operations.log"
  printf 'roark-bot\n'
  exit 0
fi
if [ "$endpoint" = "repos/owner/repo/issues/comments/99" ]; then
  printf 'patch:99\n' >> "${cwd}/operations.log"
  if [ "$mode" = "fallback" ]; then exit 1; fi
  printf '{"id":99,"html_url":"https://example.test/comments/99"}\n'
  exit 0
fi
if [ "$endpoint" = "repos/owner/repo/issues/comments/42" ]; then
  printf 'patch:42\n' >> "${cwd}/operations.log"
  printf '{"id":42,"html_url":"https://example.test/comments/42"}\n'
  exit 0
fi
if [ "$endpoint" = "repos/owner/repo/issues/24/comments" ] && [[ " $* " = *" --method POST "* ]]; then
  printf 'post\n' >> "${cwd}/operations.log"
  printf '{"id":43,"html_url":"https://example.test/comments/43"}\n'
  exit 0
fi
if [ "$endpoint" = "repos/owner/repo/issues/24/comments" ]; then
  printf 'list\n' >> "${cwd}/operations.log"
  if [ "$mode" = "fallback" ]; then
    printf '[[{"id":42,"body":"<!-- roark:issue=24 attempt=2 phase=review-a --> Old review","user":{"login":"roark-bot"}}]]\n'
  elif [ "$mode" = "create" ]; then
    printf '[[{"id":41,"body":"<!-- roark:issue=24 attempt=2 phase=readiness --> spoof","user":{"login":"attacker"}}]]\n'
  else
    printf '[[]]\n'
  fi
  exit 0
fi
exit 1
`, "utf8");
  await chmod(path.join(binDir, "gh"), 0o755);
  process.env["PATH"] = `${binDir}${path.delimiter}${originalPath ?? ""}`;
  return cwd;
}
