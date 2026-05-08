import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultAutorunFailureLabel } from "../autorun/failure.ts";
import { defaultAutorunBaseBranch } from "../autorun/branch.ts";
import { defaultAutorunInProgressLabel, defaultAutorunReadyLabel } from "../autorun/selection.ts";
import { parseArgs } from "./args.ts";
import { hydrateCliOptions, inferVerifyCommand, parseGithubRepoFromOrigin } from "./hydrate.ts";
import { runProcessOrThrow } from "./process.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("hydrateCliOptions", () => {
  test("resolves --cwd subdirectories to the git root and lets CLI values override config", async () => {
    const repo = await tempGitRepo();
    const subdir = path.join(repo, "src", "components");
    await mkdir(subdir, { recursive: true });
    await writeConfig(repo, {
      repo: "config/repo",
      verify: "bun run config-check",
      readyLabel: "config-ready",
      inProgressLabel: "config-progress",
      failureLabel: "config-failed",
      successLabel: "config-success",
      skipLabels: ["config-skip"],
      baseBranch: "config-main",
      maxFixPasses: 2,
    });

    const raw = parseArgs([
      "auto",
      "4",
      "--cwd",
      subdir,
      "--repo",
      "cli/repo",
      "--verify",
      "bun run cli-check",
      "--label",
      "cli-ready",
      "--skip-label",
      "cli-skip",
      "--base-branch",
      "cli-main",
      "--max-fix-passes",
      "5",
      "--dry-run",
    ]);
    if ("help" in raw) throw new Error("expected options");

    const hydrated = await hydrateCliOptions(raw);
    expect(hydrated.command).toBe("auto");
    if (hydrated.command !== "auto") throw new Error("expected auto options");
    expect(hydrated.cwd).toBe(repo);
    expect(hydrated.repo).toBe("cli/repo");
    expect(hydrated.verifyCommand).toBe("bun run cli-check");
    expect(hydrated.readyLabel).toBe("cli-ready");
    expect(hydrated.skipLabels).toEqual(["cli-skip", "config-progress", "config-failed", "config-success", "blocked", "needs-human"]);
    expect(hydrated.baseBranch).toBe("cli-main");
    expect(hydrated.maxFixPasses).toBe(5);
    expect(hydrated.inProgressLabel).toBe("config-progress");
    expect(hydrated.failureLabel).toBe("config-failed");
    expect(hydrated.successLabel).toBe("config-success");
    expect(hydrated.dryRun).toBe(true);
  });

  test("hydrates workspace and lifecycle hook config for auto and workspace commands", async () => {
    const repo = await tempGitRepo();
    await writeConfig(repo, {
      repo: "config/repo",
      verify: "bun run typecheck",
      workspace: {
        root: "~/custom-roark-workspaces",
        strategy: "clone",
        cloneRemote: "upstream",
        clone: { filter: null, depth: 2 },
      },
      hooks: {
        afterCreate: "npm ci",
        beforeRun: "npm ci",
        beforeVerify: "npm test -- --list",
        afterRun: "echo done",
        beforeRemove: "echo removing",
        timeoutMs: 1234,
      },
      sandbox: { provider: "host" },
    });

    const autoRaw = parseArgs(["auto", "4", "--cwd", repo]);
    if ("help" in autoRaw) throw new Error("expected options");
    const autoHydrated = await hydrateCliOptions(autoRaw);
    expect(autoHydrated.command).toBe("auto");
    if (autoHydrated.command !== "auto") throw new Error("expected auto options");
    expect(autoHydrated.workspace).toEqual({
      root: "~/custom-roark-workspaces",
      strategy: "clone",
      cloneRemote: "upstream",
      clone: { filter: null, depth: 2 },
    });
    expect(autoHydrated.hooks).toEqual({
      afterCreate: "npm ci",
      beforeRun: "npm ci",
      beforeVerify: "npm test -- --list",
      afterRun: "echo done",
      beforeRemove: "echo removing",
      timeoutMs: 1234,
    });

    const workspaceRaw = parseArgs(["workspace", "remove", "--issue", "4", "--force", "--cwd", repo]);
    if ("help" in workspaceRaw) throw new Error("expected options");
    const workspaceHydrated = await hydrateCliOptions(workspaceRaw);
    expect(workspaceHydrated.command).toBe("workspace");
    if (workspaceHydrated.command !== "workspace" || workspaceHydrated.action !== "remove") throw new Error("expected workspace remove options");
    expect(workspaceHydrated.issue).toBe(4);
    expect(workspaceHydrated.force).toBe(true);
    expect(workspaceHydrated.workspace.cloneRemote).toBe("upstream");
    expect(workspaceHydrated.hooks.beforeRemove).toBe("echo removing");
  });

  test("rejects invalid workspace, hook, and sandbox config", async () => {
    const withUnknownNested = await tempGitRepo();
    await writeConfig(withUnknownNested, { workspace: { unknown: true }, verify: "bun test", repo: "owner/repo" });
    const unknownRaw = parseArgs(["auto", "--cwd", withUnknownNested]);
    if ("help" in unknownRaw) throw new Error("expected options");
    await expect(hydrateCliOptions(unknownRaw)).rejects.toThrow("Unknown Roark config key 'workspace.unknown'");

    const withWorktreeStrategy = await tempGitRepo();
    await writeConfig(withWorktreeStrategy, { workspace: { strategy: "worktree" }, verify: "bun test", repo: "owner/repo" });
    const strategyRaw = parseArgs(["auto", "--cwd", withWorktreeStrategy]);
    if ("help" in strategyRaw) throw new Error("expected options");
    await expect(hydrateCliOptions(strategyRaw)).rejects.toThrow("workspace.strategy' must be 'clone'");

    const withInvalidHook = await tempGitRepo();
    await writeConfig(withInvalidHook, { hooks: { beforeRun: "" }, verify: "bun test", repo: "owner/repo" });
    const hookRaw = parseArgs(["auto", "--cwd", withInvalidHook]);
    if ("help" in hookRaw) throw new Error("expected options");
    await expect(hydrateCliOptions(hookRaw)).rejects.toThrow("hooks.beforeRun' must be a non-empty string");

    const withSandbox = await tempGitRepo();
    await writeConfig(withSandbox, { sandbox: { provider: "docker" }, verify: "bun test", repo: "owner/repo" });
    const sandboxRaw = parseArgs(["auto", "--cwd", withSandbox]);
    if ("help" in sandboxRaw) throw new Error("expected options");
    await expect(hydrateCliOptions(sandboxRaw)).rejects.toThrow("sandbox.provider' must be 'host'");
  });

  test("applies config values before built-in defaults", async () => {
    const repo = await tempGitRepo();
    await writeConfig(repo, {
      repo: "config/repo",
      verify: "bun run config-test",
      inProgressLabel: "busy",
      failureLabel: "failed",
      successLabel: "opened",
      maxFixPasses: 4,
    });

    const raw = parseArgs(["continue", "12", "--cwd", repo]);
    if ("help" in raw) throw new Error("expected options");

    const hydrated = await hydrateCliOptions(raw);
    expect(hydrated.command).toBe("continue");
    if (hydrated.command !== "continue") throw new Error("expected continue options");
    expect(hydrated.repo).toBe("config/repo");
    expect(hydrated.verifyCommand).toBe("bun run config-test");
    expect(hydrated.inProgressLabel).toBe("busy");
    expect(hydrated.failureLabel).toBe("failed");
    expect(hydrated.successLabel).toBe("opened");
    expect(hydrated.maxFixPasses).toBe(4);
  });

  test("preserves fully-qualified issue refs over config repo unless --repo is explicit", async () => {
    const repo = await tempGitRepo();
    await writeConfig(repo, { repo: "config/repo" });

    const urlRaw = parseArgs(["fetch", "https://github.com/url/repo/issues/123", "--cwd", repo]);
    if ("help" in urlRaw) throw new Error("expected options");
    const urlHydrated = await hydrateCliOptions(urlRaw);
    expect(urlHydrated.command).toBe("fetch");
    if (urlHydrated.command !== "fetch") throw new Error("expected fetch options");
    expect(urlHydrated.repo).toBe("url/repo");

    const shorthandRaw = parseArgs(["fetch", "owner/shorthand#123", "--cwd", repo]);
    if ("help" in shorthandRaw) throw new Error("expected options");
    const shorthandHydrated = await hydrateCliOptions(shorthandRaw);
    expect(shorthandHydrated.command).toBe("fetch");
    if (shorthandHydrated.command !== "fetch") throw new Error("expected fetch options");
    expect(shorthandHydrated.repo).toBe("owner/shorthand");

    const originRepo = await tempGitRepo();
    await runProcessOrThrow(["git", "remote", "add", "origin", "https://github.com/origin/repo.git"], { cwd: originRepo });
    const originRaw = parseArgs(["fetch", "https://github.com/url/repo/issues/123", "--cwd", originRepo]);
    if ("help" in originRaw) throw new Error("expected options");
    const originHydrated = await hydrateCliOptions(originRaw);
    expect(originHydrated.command).toBe("fetch");
    if (originHydrated.command !== "fetch") throw new Error("expected fetch options");
    expect(originHydrated.repo).toBe("url/repo");

    const repoOverrideRaw = parseArgs(["fetch", "owner/shorthand#123", "--cwd", repo, "--repo", "cli/repo"]);
    if ("help" in repoOverrideRaw) throw new Error("expected options");
    const repoOverrideHydrated = await hydrateCliOptions(repoOverrideRaw);
    expect(repoOverrideHydrated.command).toBe("fetch");
    if (repoOverrideHydrated.command !== "fetch") throw new Error("expected fetch options");
    expect(repoOverrideHydrated.repo).toBe("cli/repo");
  });

  test("infers repo from GitHub origin and verify from package.json when config is missing", async () => {
    const repo = await tempGitRepo();
    await runProcessOrThrow(["git", "remote", "add", "origin", "git@github.com:owner/inferred.git"], { cwd: repo });
    await writeFile(path.join(repo, "package.json"), JSON.stringify({ scripts: { typecheck: "tsc --noEmit", test: "bun test" } }), "utf8");

    const raw = parseArgs(["auto", "--cwd", repo, "--dry-run"]);
    if ("help" in raw) throw new Error("expected options");

    const hydrated = await hydrateCliOptions(raw);
    expect(hydrated.command).toBe("auto");
    if (hydrated.command !== "auto") throw new Error("expected auto options");
    expect(hydrated.repo).toBe("owner/inferred");
    expect(hydrated.verifyCommand).toBe("bun run typecheck");
    expect(hydrated.readyLabel).toBe(defaultAutorunReadyLabel);
    expect(hydrated.inProgressLabel).toBe(defaultAutorunInProgressLabel);
    expect(hydrated.failureLabel).toBe(defaultAutorunFailureLabel);
    expect(hydrated.baseBranch).toBe(defaultAutorunBaseBranch);
  });

  test("ignores root-level roark.config.json and loads only .roark/config.json", async () => {
    const repo = await tempGitRepo();
    await runProcessOrThrow(["git", "remote", "add", "origin", "https://github.com/owner/origin.git"], { cwd: repo });
    await writeFile(path.join(repo, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }), "utf8");
    await writeFile(path.join(repo, "roark.config.json"), JSON.stringify({ repo: "wrong/repo", model: "bad" }), "utf8");

    const raw = parseArgs(["auto", "--cwd", repo, "--dry-run"]);
    if ("help" in raw) throw new Error("expected options");

    const hydrated = await hydrateCliOptions(raw);
    expect(hydrated.command).toBe("auto");
    if (hydrated.command !== "auto") throw new Error("expected auto options");
    expect(hydrated.repo).toBe("owner/origin");
    expect(hydrated.verifyCommand).toBe("bun run test");
  });

  test("fails on unsupported and unknown config keys", async () => {
    const withUnsupported = await tempGitRepo();
    await writeConfig(withUnsupported, { model: "provider/model" });
    const unsupportedRaw = parseArgs(["auto", "--cwd", withUnsupported]);
    if ("help" in unsupportedRaw) throw new Error("expected options");
    await expect(hydrateCliOptions(unsupportedRaw)).rejects.toThrow("Unsupported Roark config key 'model'");

    const withUnknown = await tempGitRepo();
    await writeConfig(withUnknown, { notAKey: true });
    const unknownRaw = parseArgs(["auto", "--cwd", withUnknown]);
    if ("help" in unknownRaw) throw new Error("expected options");
    await expect(hydrateCliOptions(unknownRaw)).rejects.toThrow("Unknown Roark config key 'notAKey'");
  });

  test("fails clearly outside git repositories", async () => {
    const dir = await tempDir();
    const raw = parseArgs(["auto", "--cwd", dir]);
    if ("help" in raw) throw new Error("expected options");
    await expect(hydrateCliOptions(raw)).rejects.toThrow("must be run inside a git repository");
  });

  test("auto and continue fail before running when verify cannot be configured or inferred", async () => {
    const repo = await tempGitRepo();
    await runProcessOrThrow(["git", "remote", "add", "origin", "https://github.com/owner/repo.git"], { cwd: repo });

    for (const argv of [["auto", "--cwd", repo], ["continue", "1", "--cwd", repo]]) {
      const raw = parseArgs(argv);
      if ("help" in raw) throw new Error("expected options");
      await expect(hydrateCliOptions(raw)).rejects.toThrow("Could not determine verification command");
    }
  });
});

describe("parseGithubRepoFromOrigin", () => {
  test("parses GitHub HTTPS and SSH origin URLs", () => {
    expect(parseGithubRepoFromOrigin("https://github.com/owner/repo.git")).toBe("owner/repo");
    expect(parseGithubRepoFromOrigin("https://github.com/owner/repo")).toBe("owner/repo");
    expect(parseGithubRepoFromOrigin("git@github.com:owner/repo.git")).toBe("owner/repo");
    expect(parseGithubRepoFromOrigin("ssh://git@github.com/owner/repo.git")).toBe("owner/repo");
    expect(parseGithubRepoFromOrigin("https://example.com/owner/repo.git")).toBeUndefined();
  });
});

describe("inferVerifyCommand", () => {
  test("uses Bun for JS repos and falls back to Makefile test target", async () => {
    const withTypecheck = await tempDir();
    await writeFile(path.join(withTypecheck, "package.json"), JSON.stringify({ scripts: { typecheck: "tsc", test: "bun test" } }), "utf8");
    expect(await inferVerifyCommand(withTypecheck)).toBe("bun run typecheck");

    const withTest = await tempDir();
    await writeFile(path.join(withTest, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }), "utf8");
    expect(await inferVerifyCommand(withTest)).toBe("bun run test");

    const withMakefile = await tempDir();
    await writeFile(path.join(withMakefile, "Makefile"), "test:\n\techo ok\n", "utf8");
    expect(await inferVerifyCommand(withMakefile)).toBe("make test");
  });
});

async function tempDir(): Promise<string> {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "roark-hydrate-")));
  tempDirs.push(dir);
  return dir;
}

async function tempGitRepo(): Promise<string> {
  const dir = await tempDir();
  await runProcessOrThrow(["git", "init"], { cwd: dir });
  return dir;
}

async function writeConfig(repo: string, config: Record<string, unknown>): Promise<void> {
  await mkdir(path.join(repo, ".roark"), { recursive: true });
  await writeFile(path.join(repo, ".roark", "config.json"), JSON.stringify(config), "utf8");
}
