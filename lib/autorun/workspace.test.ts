import { describe, expect, test } from "bun:test";
import { chmod, lstat, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  assertWorkspacePathSafe,
  defaultLifecycleHooks,
  defaultWorkspaceConfig,
  listWorkspaces,
  prepareCloneWorkspace,
  preparePrReviewWorkspace,
  preparePrRevisionWorkspace,
  refreshCopyToWorktree,
  removeWorkspace,
  resolveCloneRemote,
  runLifecycleHook,
  runWorkspaceCommand,
  sanitizeWorkspaceSegment,
  workspacePathForIssue,
  workspacePathForPrRevision,
  workspaceStateFile,
  type ProcessRunner,
} from "./workspace.ts";
import { runProcess, runProcessOrThrow } from "../cli/process.ts";
import { noopAsync } from "../utils/async.ts";

const ok = (stdout = ""): Awaited<ReturnType<ProcessRunner>> => ({ stdout, stderr: "", exitCode: 0 });
const fail = (stderr = "failed"): Awaited<ReturnType<ProcessRunner>> => ({ stdout: "", stderr, exitCode: 1 });

describe("managed clone workspaces", () => {
  test("computes sanitized issue and PR revision workspace paths inside the configured root", () => {
    const workspacePath = workspacePathForIssue({ root: "/tmp/roark-root", repo: "Owner/Repo.Name", issueNumber: 207 });
    expect(workspacePath).toBe(path.resolve("/tmp/roark-root/owner-repo.name/issue-207"));
    expect(workspacePathForPrRevision({ root: "/tmp/roark-root", repo: "Owner/Repo.Name", prNumber: 12 })).toBe(path.resolve("/tmp/roark-root/owner-repo.name/pr-12"));
    expect(sanitizeWorkspaceSegment("../Bad Value!")).toBe("bad-value");
  });

  test("rejects workspace path escapes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "roark-workspace-root-"));
    expect(assertWorkspacePathSafe({ root, workspacePath: path.join(root, "../escape") })).rejects.toThrow("must stay inside");
  });

  test("resolves remote names and preflights the resulting URL", async () => {
    await noopAsync();
    const calls: string[][] = [];
    const runner: ProcessRunner = async (args) => {
      await noopAsync();
      calls.push(args);
      if (args.join(" ") === "git remote get-url upstream") return ok("git@github.com:owner/repo.git\n");
      if (args[0] === "git" && args[1] === "ls-remote") return ok("abc\tHEAD\n");
      return fail();
    };

    expect(resolveCloneRemote({ cwd: "/repo", cloneRemote: "upstream", runner })).resolves.toEqual({
      remote: "upstream",
      url: "git@github.com:owner/repo.git",
    });
    expect(calls).toEqual([
      ["git", "remote", "get-url", "upstream"],
      ["git", "ls-remote", "git@github.com:owner/repo.git", "HEAD"],
    ]);
  });

  test("existing legacy lock directory does not block workspace preparation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "roark-workspace-stale-lock-"));
    const workspaceRoot = path.join(root, "managed");
    const workspacePath = workspacePathForIssue({ root: workspaceRoot, repo: "owner/repo", issueNumber: 75 });
    await mkdir(`${workspacePath}.lock`, { recursive: true });
    const runner: ProcessRunner = async (args) => {
      if (args[0] === "git" && args[1] === "remote") return ok(`${root}/remote.git\n`);
      if (args[0] === "git" && args[1] === "ls-remote") return ok("abc\tHEAD\n");
      if (args[0] === "git" && args[1] === "clone") {
        await mkdir(path.join(workspacePath, ".git"), { recursive: true });
        return ok();
      }
      return ok();
    };

    const prepared = await prepareCloneWorkspace({
      controlCwd: root,
      repo: "owner/repo",
      issueNumber: 75,
      plan: { issueNumber: 75, branchName: "roark/issue-75", baseBranch: "main" },
      workspace: { ...defaultWorkspaceConfig, root: workspaceRoot },
      hooks: defaultLifecycleHooks,
      mode: "auto",
      runner,
    });

    expect(prepared.path).toBe(workspacePath);
    expect((await lstat(`${workspacePath}.lock`)).isDirectory()).toBe(true);
    await rm(root, { recursive: true, force: true });
  });

  test("reused issue clone workspace does not merge or stash a moved origin base", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "roark-workspace-no-base-sync-"));
    const workspaceRoot = path.join(root, "managed");
    const workspacePath = workspacePathForIssue({ root: workspaceRoot, repo: "owner/repo", issueNumber: 77 });
    await mkdir(path.join(workspacePath, ".git"), { recursive: true });
    const calls: string[][] = [];
    const runner: ProcessRunner = async (args) => {
      await noopAsync();
      calls.push(args);
      if (args[0] === "git" && args[1] === "remote") return ok(`${root}/remote.git\n`);
      if (args[0] === "git" && args[1] === "ls-remote") return ok("abc\tHEAD\n");
      if (args[0] === "git" && args[1] === "rev-parse") return ok("true\n");
      if (args[0] === "git" && args[1] === "branch") return ok("roark/issue-77\n");
      if (args[0] === "git" && ["fetch", "merge", "stash"].includes(args[1] ?? "")) return fail(`${args[1] ?? "git command"} should not run`);
      return ok();
    };

    const prepared = await prepareCloneWorkspace({
      controlCwd: root,
      repo: "owner/repo",
      issueNumber: 77,
      plan: { issueNumber: 77, branchName: "roark/issue-77", baseBranch: "main" },
      workspace: { ...defaultWorkspaceConfig, root: workspaceRoot },
      hooks: defaultLifecycleHooks,
      mode: "continue",
      runner,
    });

    expect(prepared.path).toBe(workspacePath);
    expect(calls.some((args) => args[0] === "git" && ["fetch", "merge", "stash"].includes(args[1] ?? ""))).toBe(false);
    await rm(root, { recursive: true, force: true });
  });

  test("legacy lock sidecars are not listed and are removed with workspaces", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "roark-workspace-legacy-lock-"));
    const workspaceRoot = path.join(root, "managed");
    const workspacePath = workspacePathForIssue({ root: workspaceRoot, repo: "owner/repo", issueNumber: 76 });
    const prWorkspacePath = workspacePathForPrRevision({ root: workspaceRoot, repo: "owner/repo", prNumber: 98 });
    await mkdir(workspacePath, { recursive: true });
    await mkdir(prWorkspacePath, { recursive: true });
    await mkdir(`${workspacePath}.lock`, { recursive: true });
    await mkdir(`${prWorkspacePath}.lock`, { recursive: true });

    expect(await listWorkspaces({ workspace: { ...defaultWorkspaceConfig, root: workspaceRoot }, repo: "owner/repo" })).toEqual([workspacePath, prWorkspacePath].toSorted());

    await removeWorkspace({ workspacePath, force: true, hooks: defaultLifecycleHooks });

    expect(Bun.file(workspacePath).exists()).resolves.toBe(false);
    expect(Bun.file(`${workspacePath}.lock`).exists()).resolves.toBe(false);
    await rm(root, { recursive: true, force: true });
  });

  test("workspace remove resolves PR revision workspaces", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "roark-pr-workspace-remove-"));
    const workspaceRoot = path.join(root, "managed");
    const workspacePath = workspacePathForPrRevision({ root: workspaceRoot, repo: "owner/repo", prNumber: 98 });
    await mkdir(workspacePath, { recursive: true });

    await runWorkspaceCommand({
      command: "workspace",
      action: "remove",
      target: { kind: "pr", number: 98 },
      cwd: root,
      repo: "owner/repo",
      force: true,
      workspace: { ...defaultWorkspaceConfig, root: workspaceRoot },
      hooks: defaultLifecycleHooks,
    });

    expect(Bun.file(workspacePath).exists()).resolves.toBe(false);
    await rm(root, { recursive: true, force: true });
  });

  test("fatal afterCreate hook poisons a fresh workspace", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "roark-workspace-poison-"));
    const workspaceRoot = path.join(root, "managed");
    const workspacePath = workspacePathForIssue({ root: workspaceRoot, repo: "owner/repo", issueNumber: 74 });
    const calls: string[][] = [];
    const runner: ProcessRunner = async (args, options) => {
      calls.push(args);
      if (args[0] === "git" && args[1] === "remote") return ok(`${root}/remote.git\n`);
      if (args[0] === "git" && args[1] === "ls-remote") return ok("abc\tHEAD\n");
      if (args[0] === "git" && args[1] === "clone") {
        await mkdir(path.join(workspacePath, ".git"), { recursive: true });
        return ok();
      }
      if (args[0] === "git" && ["fetch", "checkout"].includes(args[1] ?? "")) return ok();
      if (args[0] === "sh") return fail("install failed");
      return ok(options?.cwd ?? "");
    };

    expect(prepareCloneWorkspace({
      controlCwd: root,
      repo: "owner/repo",
      issueNumber: 74,
      plan: { issueNumber: 74, branchName: "roark/issue-74", baseBranch: "main" },
      workspace: { ...defaultWorkspaceConfig, root: workspaceRoot },
      hooks: { ...defaultLifecycleHooks, afterCreate: "false" },
      mode: "auto",
      runner,
    })).rejects.toThrow("afterCreate hook failed");

    const state = JSON.parse(await readFile(path.join(workspacePath, workspaceStateFile), "utf8")) as { hook: string; stderrTail: string };
    expect(state.hook).toBe("afterCreate");
    expect(state.stderrTail).toContain("install failed");
    await rm(root, { recursive: true, force: true });
  });

  test("reused PR revision workspace refuses to reset unpushed local commits", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "roark-pr-workspace-unpushed-"));
    const workspaceRoot = path.join(root, "managed");
    const workspacePath = workspacePathForPrRevision({ root: workspaceRoot, repo: "owner/repo", prNumber: 12 });
    await mkdir(path.join(workspacePath, ".git"), { recursive: true });
    const calls: string[][] = [];
    const runner: ProcessRunner = async (args) => {
      await noopAsync();
      calls.push(args);
      if (args[0] === "git" && args[1] === "remote") return ok(`${root}/remote.git\n`);
      if (args[0] === "git" && args[1] === "ls-remote") return ok("abc\tHEAD\n");
      if (args[0] === "git" && args[1] === "rev-parse") return ok("true\n");
      if (args[0] === "git" && args[1] === "status") return ok("");
      if (args[0] === "git" && args[1] === "fetch") return ok();
      if (args[0] === "git" && args[1] === "show-ref") return ok();
      if (args[0] === "git" && args[1] === "rev-list") return ok("1\n");
      if (args[0] === "git" && args[1] === "checkout") return fail("checkout should not run");
      return ok();
    };

    let error: unknown;
    try {
      await preparePrRevisionWorkspace({
        controlCwd: root,
        repo: "owner/repo",
        prNumber: 12,
        headRefName: "feature/pr-12",
        workspace: { ...defaultWorkspaceConfig, root: workspaceRoot },
        hooks: defaultLifecycleHooks,
        runner,
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect(error instanceof Error ? error.message : String(error)).toContain("unpushed local commit");
    expect(calls.some((args) => args[0] === "git" && args[1] === "checkout")).toBe(false);
    await rm(root, { recursive: true, force: true });
  });

  test("PR revision workspace preparation creates and releases a lock", async () => {
    const fixture = await createPrRevisionWorkspaceFixture("roark-pr-workspace-lock-");
    let prepared: Awaited<ReturnType<typeof preparePrRevisionWorkspace>> | undefined;
    try {
      prepared = await preparePrRevisionWorkspace(fixture.prepareInput);
      const owner = await readWorkspaceLockOwner(fixture.lockDir);

      expect((await lstat(fixture.lockDir)).isDirectory()).toBe(true);
      expect(owner.pid).toBe(process.pid);
      expect(typeof owner.token).toBe("string");
      expect(owner.token).not.toBe("");
      expect(Number.isNaN(Date.parse(String(owner.createdAt)))).toBe(false);

      await prepared.releaseLock();
      prepared = undefined;
      expect(await Bun.file(fixture.lockDir).exists()).toBe(false);
    } finally {
      await prepared?.releaseLock();
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("PR revision workspace preparation refuses an active lock", async () => {
    const fixture = await createPrRevisionWorkspaceFixture("roark-pr-workspace-active-lock-");
    let prepared: Awaited<ReturnType<typeof preparePrRevisionWorkspace>> | undefined;
    try {
      prepared = await preparePrRevisionWorkspace(fixture.prepareInput);

      let error: unknown;
      try {
        await preparePrRevisionWorkspace(fixture.prepareInput);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(Error);
      expect(error instanceof Error ? error.message : String(error)).toContain("already locked");
      expect((await lstat(fixture.lockDir)).isDirectory()).toBe(true);
    } finally {
      await prepared?.releaseLock();
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("PR revision workspace preparation replaces stale locks", async () => {
    const fixture = await createPrRevisionWorkspaceFixture("roark-pr-workspace-stale-lock-");
    await mkdir(fixture.lockDir, { recursive: true });
    const staleOwner = { token: "stale-token", pid: findDeadPid(), createdAt: "2000-01-01T00:00:00.000Z" };
    await writeFile(path.join(fixture.lockDir, "owner.json"), JSON.stringify(staleOwner), "utf8");
    let prepared: Awaited<ReturnType<typeof preparePrRevisionWorkspace>> | undefined;
    try {
      prepared = await preparePrRevisionWorkspace(fixture.prepareInput);
      const owner = await readWorkspaceLockOwner(fixture.lockDir);

      expect(owner.token).not.toBe("stale-token");
      expect(owner.pid).toBe(process.pid);

      await prepared.releaseLock();
      prepared = undefined;
      expect(await Bun.file(fixture.lockDir).exists()).toBe(false);
    } finally {
      await prepared?.releaseLock();
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("PR revision workspace preparation releases its lock on failure", async () => {
    const fixture = await createPrRevisionWorkspaceFixture("roark-pr-workspace-failed-lock-");
    const runner: ProcessRunner = async (args) => {
      await noopAsync();
      if (args[0] === "git" && args[1] === "remote") return ok(`${fixture.root}/remote.git\n`);
      if (args[0] === "git" && args[1] === "ls-remote") return fail("remote unavailable");
      return fail("unexpected command");
    };

    try {
      let error: unknown;
      try {
        await preparePrRevisionWorkspace({ ...fixture.prepareInput, runner });
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(Error);
      expect(error instanceof Error ? error.message : String(error)).toContain("Unable to access clone remote");
      expect(await Bun.file(fixture.lockDir).exists()).toBe(false);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("copies ignored host paths recursively, dereferences symlinks, preserves modes, and removes stale destinations", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "roark-copy-worktree-"));
    const control = path.join(root, "control");
    const worktree = path.join(root, "worktree");
    await mkdir(path.join(control, ".secrets", "env"), { recursive: true });
    await mkdir(path.join(control, ".secrets", "real-dir"), { recursive: true });
    await writeFile(path.join(control, ".secrets", "env", "local.env"), "secret=1\n", "utf8");
    await chmod(path.join(control, ".secrets", "env", "local.env"), 0o600);
    await writeFile(path.join(control, ".secrets", "env", "target.txt"), "linked file\n", "utf8");
    await writeFile(path.join(control, ".secrets", "real-dir", "nested.txt"), "linked dir\n", "utf8");
    await symlink("target.txt", path.join(control, ".secrets", "env", "link.txt"));
    await symlink("../real-dir", path.join(control, ".secrets", "env", "linkdir"));

    await initGitRepo(worktree, ".secrets/env\n");
    await mkdir(path.join(worktree, ".secrets", "env"), { recursive: true });
    await writeFile(path.join(worktree, ".secrets", "env", "stale.txt"), "stale\n", "utf8");

    await refreshCopyToWorktree({ controlCwd: control, worktreePath: worktree, copyToWorktree: [".secrets/env"] });

    expect(await readFile(path.join(worktree, ".secrets", "env", "local.env"), "utf8")).toBe("secret=1\n");
    expect((await stat(path.join(worktree, ".secrets", "env", "local.env"))).mode & 0o777).toBe(0o600);
    expect(await readFile(path.join(worktree, ".secrets", "env", "link.txt"), "utf8")).toBe("linked file\n");
    expect((await lstat(path.join(worktree, ".secrets", "env", "link.txt"))).isSymbolicLink()).toBe(false);
    expect(await readFile(path.join(worktree, ".secrets", "env", "linkdir", "nested.txt"), "utf8")).toBe("linked dir\n");
    expect(Bun.file(path.join(worktree, ".secrets", "env", "stale.txt")).exists()).resolves.toBe(false);
    await rm(root, { recursive: true, force: true });
  });

  test("copyToWorktree rejects symlink destination parents before removing or copying", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "roark-copy-symlink-parent-"));
    const control = path.join(root, "control");
    const worktree = path.join(root, "worktree");
    const outside = path.join(root, "outside");
    await mkdir(path.join(control, ".secrets", "env"), { recursive: true });
    await writeFile(path.join(control, ".secrets", "env", "local.env"), "secret=1\n", "utf8");
    await initGitRepo(worktree, ".secrets/env\n");
    await mkdir(path.join(outside, "env"), { recursive: true });
    await writeFile(path.join(outside, "env", "stale.txt"), "outside stale\n", "utf8");
    await symlink(outside, path.join(worktree, ".secrets"));

    expect(refreshCopyToWorktree({ controlCwd: control, worktreePath: worktree, copyToWorktree: [".secrets/env"] })).rejects.toThrow("destination parent");

    expect(await readFile(path.join(outside, "env", "stale.txt"), "utf8")).toBe("outside stale\n");
    expect(Bun.file(path.join(outside, "env", "local.env")).exists()).resolves.toBe(false);
    await rm(root, { recursive: true, force: true });
  });

  test("copyToWorktree fails before writing when a source is missing or destination is not ignored", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "roark-copy-preflight-"));
    const control = path.join(root, "control");
    const worktree = path.join(root, "worktree");
    await mkdir(control, { recursive: true });
    await writeFile(path.join(control, "ignored"), "copy me\n", "utf8");
    await initGitRepo(worktree, "ignored\nmissing\n");

    expect(refreshCopyToWorktree({ controlCwd: control, worktreePath: worktree, copyToWorktree: ["ignored", "missing"] })).rejects.toThrow("source 'missing' is missing");
    expect(Bun.file(path.join(worktree, "ignored")).exists()).resolves.toBe(false);

    await writeFile(path.join(worktree, "ignored"), "stale\n", "utf8");
    await initGitRepo(worktree, "");
    expect(refreshCopyToWorktree({ controlCwd: control, worktreePath: worktree, copyToWorktree: ["ignored"] })).rejects.toThrow("destination must be ignored");
    expect(await readFile(path.join(worktree, "ignored"), "utf8")).toBe("stale\n");
    await rm(root, { recursive: true, force: true });
  });

  test("copyToWorktree fails when copied content is visible to Git after copy", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "roark-copy-status-"));
    const control = path.join(root, "control");
    const worktree = path.join(root, "worktree");
    await mkdir(control, { recursive: true });
    await mkdir(worktree, { recursive: true });
    await writeFile(path.join(control, "visible"), "copy me\n", "utf8");
    const runner: ProcessRunner = async (args) => {
      await noopAsync();
      if (args[1] === "check-ignore") return ok();
      if (args[1] === "status") return ok("?? visible\n");
      return ok();
    };

    expect(refreshCopyToWorktree({ controlCwd: control, worktreePath: worktree, copyToWorktree: ["visible"], runner })).rejects.toThrow("visible to Git");
    await rm(root, { recursive: true, force: true });
  });

  test("copies configured paths before afterCreate hooks run", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "roark-copy-after-create-"));
    const control = path.join(root, "control");
    const workspaceRoot = path.join(root, "managed");
    const workspacePath = workspacePathForIssue({ root: workspaceRoot, repo: "owner/repo", issueNumber: 88 });
    await mkdir(control, { recursive: true });
    await writeFile(path.join(control, "local.env"), "ready\n", "utf8");
    const calls: string[][] = [];
    const runner: ProcessRunner = async (args) => {
      calls.push(args);
      if (args[0] === "git" && args[1] === "remote") return ok(`${root}/remote.git\n`);
      if (args[0] === "git" && args[1] === "ls-remote") return ok("abc\tHEAD\n");
      if (args[0] === "git" && args[1] === "clone") {
        await mkdir(path.join(workspacePath, ".git"), { recursive: true });
        return ok();
      }
      if (args[0] === "git" && ["fetch", "checkout"].includes(args[1] ?? "")) return ok();
      if (args[0] === "git" && args[1] === "check-ignore") return ok();
      if (args[0] === "git" && args[1] === "status") return ok();
      if (args[0] === "sh") return (await Bun.file(path.join(workspacePath, "local.env")).exists()) ? ok() : fail("missing local.env");
      return ok();
    };

    await prepareCloneWorkspace({
      controlCwd: control,
      repo: "owner/repo",
      issueNumber: 88,
      plan: { issueNumber: 88, branchName: "roark/issue-88", baseBranch: "main" },
      workspace: { ...defaultWorkspaceConfig, root: workspaceRoot, copyToWorktree: ["local.env"] },
      hooks: { ...defaultLifecycleHooks, afterCreate: "test -f local.env" },
      mode: "auto",
      runner,
    });
    expect(calls.some((args) => args[0] === "sh")).toBe(true);
    await rm(root, { recursive: true, force: true });
  });

  test("non-fatal afterRun hook warns without throwing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "roark-workspace-hook-"));
    await writeFile(path.join(root, "file"), "ok");
    expect(runLifecycleHook("afterRun", { timeoutMs: 1000, afterRun: "false" }, root, ()=> Promise.resolve(fail("after failed")))).resolves.toBeUndefined();
    await rm(root, { recursive: true, force: true });
  });

  test("pins a PR pull ref and compares merge-base to head without mutation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "roark-pr-review-pinned-"));
    const source = path.join(root, "source");
    const remote = path.join(root, "remote.git");
    await initGitRepo(source, ".roark\n");
    const initial = (await runProcessOrThrow(["git", "rev-parse", "HEAD"], { cwd: source })).trim();
    await runProcessOrThrow(["git", "checkout", "-b", "contributor/change"], { cwd: source });
    await writeFile(path.join(source, "feature.txt"), "feature\n", "utf8");
    await runProcessOrThrow(["git", "add", "feature.txt"], { cwd: source });
    await runProcessOrThrow(["git", "commit", "-m", "feature"], { cwd: source });
    const headOid = (await runProcessOrThrow(["git", "rev-parse", "HEAD"], { cwd: source })).trim();
    await runProcessOrThrow(["git", "checkout", "main"], { cwd: source });
    await writeFile(path.join(source, "base-only.txt"), "base advance\n", "utf8");
    await runProcessOrThrow(["git", "add", "base-only.txt"], { cwd: source });
    await runProcessOrThrow(["git", "commit", "-m", "advance base"], { cwd: source });
    const baseOid = (await runProcessOrThrow(["git", "rev-parse", "HEAD"], { cwd: source })).trim();
    await runProcessOrThrow(["git", "clone", "--bare", source, remote], { cwd: root });
    await runProcessOrThrow(["git", "update-ref", "refs/pull/12/head", headOid], { cwd: remote });
    await runProcessOrThrow(["git", "remote", "add", "origin", remote], { cwd: source });

    const calls: string[][] = [];
    const prepared = await preparePrReviewWorkspace({
      controlCwd: source,
      repo: "owner/repo",
      prNumber: 12,
      baseRefName: "main",
      baseRefOid: baseOid,
      headRefOid: headOid,
      workspace: { ...defaultWorkspaceConfig, root: path.join(root, "managed") },
      hooks: defaultLifecycleHooks,
      runner: async (args, options) => {
        calls.push(args);
        return runProcess(args, options);
      },
    });

    expect(prepared.comparison.mergeBaseOid).toBe(initial);
    expect(prepared.comparison.changedFiles).toEqual(["feature.txt"]);
    expect(prepared.comparison.inspectionCommand).toBe(`git diff ${initial}..${headOid} --`);
    expect((await runProcessOrThrow(["git", "rev-parse", "HEAD"], { cwd: prepared.path })).trim()).toBe(headOid);
    expect(calls.some((args) => args[0] === "git" && ["commit", "push"].includes(args[1] ?? ""))).toBe(false);
    await prepared.releaseLock();
    await rm(root, { recursive: true, force: true });
  });
});

async function createPrRevisionWorkspaceFixture(prefix: string): Promise<{
  root: string;
  lockDir: string;
  prepareInput: Parameters<typeof preparePrRevisionWorkspace>[0];
}> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  const workspaceRoot = path.join(root, "managed");
  const workspacePath = workspacePathForPrRevision({ root: workspaceRoot, repo: "owner/repo", prNumber: 12 });
  const runner: ProcessRunner = async (args) => {
    await noopAsync();
    if (args[0] === "git" && args[1] === "remote") return ok(`${root}/remote.git\n`);
    if (args[0] === "git" && args[1] === "ls-remote") return ok("abc\tHEAD\n");
    if (args[0] === "git" && args[1] === "clone") {
      await mkdir(path.join(workspacePath, ".git"), { recursive: true });
      return ok();
    }
    if (args[0] === "git" && args[1] === "fetch") return ok();
    if (args[0] === "git" && args[1] === "show-ref") return fail("branch missing");
    if (args[0] === "git" && args[1] === "checkout") return ok();
    return fail(`unexpected command: ${args.join(" ")}`);
  };

  return {
    root,
    lockDir: `${workspacePath}.lock`,
    prepareInput: {
      controlCwd: root,
      repo: "owner/repo",
      prNumber: 12,
      headRefName: "feature/pr-12",
      workspace: { ...defaultWorkspaceConfig, root: workspaceRoot },
      hooks: defaultLifecycleHooks,
      runner,
    },
  };
}

async function readWorkspaceLockOwner(lockDir: string): Promise<{ token?: unknown; pid?: unknown; createdAt?: unknown }> {
  return JSON.parse(await readFile(path.join(lockDir, "owner.json"), "utf8")) as { token?: unknown; pid?: unknown; createdAt?: unknown };
}

function findDeadPid(): number {
  for (const pid of [2147483647, 2147483646, 999999, 424242]) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH") return pid;
    }
  }
  throw new Error("Unable to find a dead PID for stale lock test.");
}

async function initGitRepo(cwd: string, gitignore: string): Promise<void> {
  await mkdir(cwd, { recursive: true });
  await runProcessOrThrow(["git", "init", "-b", "main"], { cwd });
  await runProcessOrThrow(["git", "config", "user.email", "roark@example.com"], { cwd });
  await runProcessOrThrow(["git", "config", "user.name", "Roark Test"], { cwd });
  await writeFile(path.join(cwd, ".gitignore"), gitignore, "utf8");
  await writeFile(path.join(cwd, "README.md"), "test\n", "utf8");
  await runProcessOrThrow(["git", "add", ".gitignore", "README.md"], { cwd });
  await runProcessOrThrow(["git", "commit", "-m", "initial"], { cwd });
}
