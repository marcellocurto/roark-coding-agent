import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { publishIssueWithGitHub } from "./github.ts";

const tempDirs: string[] = [];
const originalEnv = {
  path: process.env["PATH"],
  log: process.env["ROARK_GH_LOG"],
  body: process.env["ROARK_GH_BODY"],
  list: process.env["ROARK_GH_LIST"],
};

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  if (originalEnv.path === undefined) delete process.env["PATH"];
  else process.env["PATH"] = originalEnv.path;
  if (originalEnv.log === undefined) delete process.env["ROARK_GH_LOG"];
  else process.env["ROARK_GH_LOG"] = originalEnv.log;
  if (originalEnv.body === undefined) delete process.env["ROARK_GH_BODY"];
  else process.env["ROARK_GH_BODY"] = originalEnv.body;
  if (originalEnv.list === undefined) delete process.env["ROARK_GH_LIST"];
  else process.env["ROARK_GH_LIST"] = originalEnv.list;
});

describe("publishIssueWithGitHub", () => {
  test("checks exact-title duplicates and publishes the rendered body through stdin", async () => {
    const fixture = await githubFixture("[]");
    const result = await publishIssueWithGitHub({
      cwd: fixture.cwd,
      repo: "owner/repo",
      title: "Track structured publishing",
      body: "## Simple summary\n\nRendered by Roark.\n",
      labels: ["needs-triage", "follow-up"],
    });

    expect(result).toMatchObject({ url: "https://github.com/owner/repo/issues/42", number: 42 });
    expect(await readFile(fixture.bodyPath, "utf8")).toBe("## Simple summary\n\nRendered by Roark.\n");
    const calls = await readFile(fixture.logPath, "utf8");
    expect(calls).toContain("issue list --state all --search \"Track structured publishing\" in:title --json number,title,url --limit 20 --repo owner/repo");
    expect(calls).toContain("issue create --title Track structured publishing --body-file - --label needs-triage --label follow-up --repo owner/repo");
  });

  test("does not create when the duplicate search returns the same normalized title", async () => {
    const fixture = await githubFixture(JSON.stringify([{
      number: 7,
      title: "  Track   structured publishing ",
      url: "https://github.com/owner/repo/issues/7",
    }]));

    expect(publishIssueWithGitHub({
      cwd: fixture.cwd,
      title: "Track structured publishing",
      body: "body",
      labels: [],
    })).rejects.toThrow("An issue with the same title already exists: https://github.com/owner/repo/issues/7");
    expect(await readFile(fixture.logPath, "utf8")).not.toContain("issue create");
  });
});

async function githubFixture(listResponse: string): Promise<{ cwd: string; bodyPath: string; logPath: string }> {
  const cwd = await mkdtemp(path.join(tmpdir(), "roark-issue-publisher-"));
  tempDirs.push(cwd);
  const binDir = path.join(cwd, "bin");
  const bodyPath = path.join(cwd, "body.md");
  const logPath = path.join(cwd, "gh.log");
  await mkdir(binDir);
  await writeFile(path.join(binDir, "gh"), `#!/bin/sh
printf '%s\n' "$*" >> "$ROARK_GH_LOG"
if [ "$1" = "issue" ] && [ "$2" = "list" ]; then
  printf '%s\n' "$ROARK_GH_LIST"
elif [ "$1" = "issue" ] && [ "$2" = "create" ]; then
  cat > "$ROARK_GH_BODY"
  echo "https://github.com/owner/repo/issues/42"
fi
`, "utf8");
  await chmod(path.join(binDir, "gh"), 0o755);
  process.env["PATH"] = `${binDir}:${process.env["PATH"] ?? ""}`;
  process.env["ROARK_GH_LOG"] = logPath;
  process.env["ROARK_GH_BODY"] = bodyPath;
  process.env["ROARK_GH_LIST"] = listResponse;
  return { cwd, bodyPath, logPath };
}
