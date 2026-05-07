import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultAutorunFailureLabel } from "../autorun/failure.ts";
import { defaultAutorunBaseBranch } from "../autorun/branch.ts";
import { defaultAutorunSuccessLabel } from "../autorun/publish.ts";
import { defaultAutorunInProgressLabel, defaultAutorunReadyLabel, defaultAutorunSkipLabels } from "../autorun/selection.ts";
import { defaultMaxFixPasses, parseArgs } from "./args.ts";
import { hydrateCliOptions } from "./hydrate.ts";
import { roarkGitignoreContent, runInit } from "./init.ts";
import { runProcessOrThrow } from "./process.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("runInit", () => {
  test("resolves subdirectory cwd to git root and writes managed files", async () => {
    const repo = await tempGitRepo();
    await runProcessOrThrow(["git", "remote", "add", "origin", "https://github.com/owner/repo.git"], { cwd: repo });
    await writeFile(path.join(repo, "package.json"), JSON.stringify({ scripts: { typecheck: "tsc --noEmit", test: "bun test" } }), "utf8");
    const subdir = path.join(repo, "src", "components");
    await mkdir(subdir, { recursive: true });

    const raw = parseArgs(["init", "--cwd", subdir]);
    if ("help" in raw) throw new Error("expected options");
    const hydrated = await hydrateCliOptions(raw);
    expect(hydrated.command).toBe("init");
    if (hydrated.command !== "init") throw new Error("expected init options");

    const result = await runInit(hydrated);

    expect(result.root).toBe(repo);
    expect(existsSync(path.join(repo, ".roark", "config.json"))).toBe(true);
    expect(existsSync(path.join(repo, ".roark", "WORKFLOW.md"))).toBe(true);
    expect(existsSync(path.join(repo, ".roark", ".gitignore"))).toBe(true);
    expect(existsSync(path.join(subdir, ".roark"))).toBe(false);
    expect(existsSync(path.join(repo, ".roark", "skills"))).toBe(false);
  });

  test("generates config with inferred HTTPS origin and Bun-first verify", async () => {
    const repo = await tempGitRepo();
    await runProcessOrThrow(["git", "remote", "add", "origin", "https://github.com/owner/inferred.git"], { cwd: repo });
    await writeFile(path.join(repo, "package.json"), JSON.stringify({ scripts: { typecheck: "tsc", test: "bun test" } }), "utf8");

    await initFromArgv(["init", "--cwd", repo]);

    await expectConfig(repo, {
      repo: "owner/inferred",
      baseBranch: defaultAutorunBaseBranch,
      verify: "bun run typecheck",
      readyLabel: defaultAutorunReadyLabel,
      inProgressLabel: defaultAutorunInProgressLabel,
      successLabel: defaultAutorunSuccessLabel,
      failureLabel: defaultAutorunFailureLabel,
      skipLabels: [...defaultAutorunSkipLabels],
      maxFixPasses: defaultMaxFixPasses,
    });
  });

  test("generates config with inferred SSH origin and test fallback", async () => {
    const repo = await tempGitRepo();
    await runProcessOrThrow(["git", "remote", "add", "origin", "git@github.com:owner/ssh-repo.git"], { cwd: repo });
    await writeFile(path.join(repo, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }), "utf8");

    await initFromArgv(["init", "--cwd", repo]);

    const config = await readConfig(repo);
    expect(config.repo).toBe("owner/ssh-repo");
    expect(config.verify).toBe("bun run test");
  });

  test("--repo overrides origin and Makefile test target is inferred", async () => {
    const repo = await tempGitRepo();
    await runProcessOrThrow(["git", "remote", "add", "origin", "https://github.com/origin/repo.git"], { cwd: repo });
    await writeFile(path.join(repo, "Makefile"), "test:\n\techo ok\n", "utf8");

    await initFromArgv(["init", "--cwd", repo, "--repo", "override/repo"]);

    const config = await readConfig(repo);
    expect(config.repo).toBe("override/repo");
    expect(config.verify).toBe("make test");
  });

  test("omits verify and returns guidance when no verify command is obvious", async () => {
    const repo = await tempGitRepo();
    await runProcessOrThrow(["git", "remote", "add", "origin", "https://github.com/owner/repo.git"], { cwd: repo });

    const result = await initFromArgv(["init", "--cwd", repo]);

    const config = await readConfig(repo);
    expect(config.verify).toBeUndefined();
    expect(result.guidance.join("\n")).toContain("No obvious verification command");
  });

  test("generates exact .roark/.gitignore", async () => {
    const repo = await tempGitRepo();

    await initFromArgv(["init", "--cwd", repo, "--repo", "owner/repo"]);

    expect(await readFile(path.join(repo, ".roark", ".gitignore"), "utf8")).toBe(roarkGitignoreContent);
  });

  test("fails clearly outside git repositories", async () => {
    const dir = await tempDir();
    const raw = parseArgs(["init", "--cwd", dir, "--repo", "owner/repo"]);
    if ("help" in raw) throw new Error("expected options");

    await expect(hydrateCliOptions(raw)).rejects.toThrow("must be run inside a git repository");
  });

  test("refuses to overwrite existing managed files without partial writes", async () => {
    const repo = await tempGitRepo();
    await mkdir(path.join(repo, ".roark"), { recursive: true });
    await writeFile(path.join(repo, ".roark", "config.json"), "old", "utf8");

    await expect(initFromArgv(["init", "--cwd", repo, "--repo", "owner/repo"])).rejects.toThrow("Refusing to overwrite");

    expect(await readFile(path.join(repo, ".roark", "config.json"), "utf8")).toBe("old");
    expect(existsSync(path.join(repo, ".roark", "WORKFLOW.md"))).toBe(false);
    expect(existsSync(path.join(repo, ".roark", ".gitignore"))).toBe(false);
  });

  test("--force overwrites only managed files and leaves unrelated .roark contents", async () => {
    const repo = await tempGitRepo();
    await mkdir(path.join(repo, ".roark", "custom"), { recursive: true });
    await writeFile(path.join(repo, ".roark", "config.json"), "old", "utf8");
    await writeFile(path.join(repo, ".roark", "custom", "note.txt"), "keep", "utf8");

    await initFromArgv(["init", "--cwd", repo, "--repo", "owner/repo", "--force"]);

    const config = await readConfig(repo);
    expect(config.repo).toBe("owner/repo");
    expect(await readFile(path.join(repo, ".roark", "custom", "note.txt"), "utf8")).toBe("keep");
    expect(existsSync(path.join(repo, ".roark", "skills"))).toBe(false);
  });

  test("fails when repo cannot be inferred and --repo is omitted", async () => {
    const repo = await tempGitRepo();

    await expect(initFromArgv(["init", "--cwd", repo])).rejects.toThrow("Pass --repo owner/repo");
  });
});

async function initFromArgv(argv: string[]) {
  const raw = parseArgs(argv);
  if ("help" in raw) throw new Error("expected options");
  const hydrated = await hydrateCliOptions(raw);
  if (hydrated.command !== "init") throw new Error("expected init options");
  return runInit(hydrated);
}

async function expectConfig(repo: string, expected: Record<string, unknown>): Promise<void> {
  expect(await readConfig(repo)).toEqual(expected);
}

async function readConfig(repo: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path.join(repo, ".roark", "config.json"), "utf8"));
}

async function tempDir(): Promise<string> {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "roark-init-")));
  tempDirs.push(dir);
  return dir;
}

async function tempGitRepo(): Promise<string> {
  const dir = await tempDir();
  await runProcessOrThrow(["git", "init"], { cwd: dir });
  return dir;
}
