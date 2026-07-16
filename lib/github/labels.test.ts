import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildCreateGitHubLabelArgv,
  buildListGitHubLabelsArgv,
  ensureGitHubLabels,
  parseGitHubLabelNames,
  type RequiredGitHubLabel,
} from "./labels.ts";

const tempDirs: string[] = [];
const originalPath = process.env["PATH"];

afterEach(async () => {
  process.env["PATH"] = originalPath;
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("GitHub labels", () => {
  test("builds label list and create argv", () => {
    const label = requiredLabel("agent-in-progress");
    expect(buildListGitHubLabelsArgv({ repo: "owner/repo" })).toEqual([
      "gh",
      "api",
      "repos/owner/repo/labels",
      "--paginate",
      "--jq",
      ".[].name",
    ]);
    expect(buildCreateGitHubLabelArgv({ repo: "owner/repo", label })).toEqual([
      "gh",
      "label",
      "create",
      "agent-in-progress",
      "--repo",
      "owner/repo",
      "--color",
      "5319E7",
      "--description",
      "test label",
    ]);
  });

  test("parses newline label output", () => {
    expect(parseGitHubLabelNames("bug\nready-for-agent\n")).toEqual(["bug", "ready-for-agent"]);
    expect(parseGitHubLabelNames("\n")).toEqual([]);
  });

  test("creates missing required labels and treats existing names case-insensitively", async () => {
    const cwd = await installFakeGh("READY-FOR-AGENT\n");

    const result = await ensureGitHubLabels({
      cwd,
      repo: "owner/repo",
      labels: [requiredLabel("ready-for-agent"), requiredLabel("agent-in-progress")],
    });

    expect(result.missing.map((label) => label.name)).toEqual(["agent-in-progress"]);
    expect(result.created.map((label) => label.name)).toEqual(["agent-in-progress"]);
    expect(await readFile(path.join(cwd, "created.log"), "utf8")).toContain("agent-in-progress");
  });

  test("dry-run reports missing labels without creating them", async () => {
    const cwd = await installFakeGh("");

    const result = await ensureGitHubLabels({
      cwd,
      repo: "owner/repo",
      dryRun: true,
      labels: [requiredLabel("agent-in-progress")],
    });

    expect(result.missing.map((label) => label.name)).toEqual(["agent-in-progress"]);
    expect(result.created).toEqual([]);
    expect(await readFile(path.join(cwd, "created.log"), "utf8")).toBe("");
  });
});

function requiredLabel(name: string): RequiredGitHubLabel {
  return {
    name,
    role: "test",
    color: "#5319E7",
    description: "test label",
  };
}

async function installFakeGh(initialLabels: string): Promise<string> {
  const cwd = await mkdtemp(path.join(tmpdir(), "roark-labels-"));
  tempDirs.push(cwd);
  await writeFile(path.join(cwd, "labels.txt"), initialLabels, "utf8");
  await writeFile(path.join(cwd, "created.log"), "", "utf8");
  const binDir = path.join(cwd, "bin");
  await mkdir(binDir, { recursive: true });
  await writeFile(path.join(binDir, "gh"), `#!/usr/bin/env bash
set -euo pipefail
if [ "$1" = "api" ]; then
  cat "${cwd}/labels.txt"
  exit 0
fi
if [ "$1" = "label" ] && [ "$2" = "create" ]; then
  printf '%s\n' "$3" >> "${cwd}/created.log"
  printf '%s\n' "$3" >> "${cwd}/labels.txt"
  exit 0
fi
exit 1
`, "utf8");
  await chmod(path.join(binDir, "gh"), 0o755);
  process.env["PATH"] = `${binDir}${path.delimiter}${originalPath ?? ""}`;
  return cwd;
}
