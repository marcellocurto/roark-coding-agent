import { describe, expect, test } from "bun:test";
import { chmod, lstat, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  assertWorkspacePathSafe,
  defaultLifecycleHooks,
  defaultWorkspaceConfig,
  prepareCloneWorkspace,
  refreshCopyToWorktree,
  resolveCloneRemote,
  runLifecycleHook,
  sanitizeWorkspaceSegment,
  workspacePathForIssue,
  workspaceStateFile,
  type ProcessRunner,
} from "./workspace.ts";
import { runProcessOrThrow } from "../cli/process.ts";

const ok = (stdout = ""): Awaited<ReturnType<ProcessRunner>> => ({ stdout, stderr: "", exitCode: 0 });
const fail = (stderr = "failed"): Awaited<ReturnType<ProcessRunner>> => ({ stdout: "", stderr, exitCode: 1 });

describe("managed clone workspaces", () => {
  test("computes sanitized issue workspace paths inside the configured root", () => {
    const workspacePath = workspacePathForIssue({ root: "/tmp/roark-root", repo: "Owner/Repo.Name", issueNumber: 207 });
    expect(workspacePath).toBe(path.resolve("/tmp/roark-root/owner-repo.name/issue-207"));
    expect(sanitizeWorkspaceSegment("../Bad Value!")).toBe("bad-value");
  });

  test("rejects workspace path escapes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "roark-workspace-root-"));
    await expect(assertWorkspacePathSafe({ root, workspacePath: path.join(root, "../escape") })).rejects.toThrow("must stay inside");
  });

  test("resolves remote names and preflights the resulting URL", async () => {
    const calls: string[][] = [];
    const runner: ProcessRunner = async (args) => {
      calls.push(args);
      if (args.join(" ") === "git remote get-url upstream") return ok("git@github.com:owner/repo.git\n");
      if (args[0] === "git" && args[1] === "ls-remote") return ok("abc\tHEAD\n");
      return fail();
    };

    await expect(resolveCloneRemote({ cwd: "/repo", cloneRemote: "upstream", runner })).resolves.toEqual({
      remote: "upstream",
      url: "git@github.com:owner/repo.git",
    });
    expect(calls).toEqual([
      ["git", "remote", "get-url", "upstream"],
      ["git", "ls-remote", "git@github.com:owner/repo.git", "HEAD"],
    ]);
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

    await expect(prepareCloneWorkspace({
      controlCwd: root,
      repo: "owner/repo",
      issueNumber: 74,
      plan: { issueNumber: 74, branchName: "roark/issue-74", baseBranch: "main" },
      workspace: { ...defaultWorkspaceConfig, root: workspaceRoot },
      hooks: { ...defaultLifecycleHooks, afterCreate: "false" },
      mode: "auto",
      runner,
    })).rejects.toThrow("afterCreate hook failed");

    const state = JSON.parse(await readFile(path.join(workspacePath, workspaceStateFile), "utf8"));
    expect(state.hook).toBe("afterCreate");
    expect(state.stderrTail).toContain("install failed");
    await rm(root, { recursive: true, force: true });
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

    await expect(refreshCopyToWorktree({ controlCwd: control, worktreePath: worktree, copyToWorktree: [".secrets/env"] })).rejects.toThrow("destination parent");

    expect(await readFile(path.join(outside, "env", "stale.txt"), "utf8")).toBe("outside stale\n");
    await expect(Bun.file(path.join(outside, "env", "local.env")).exists()).resolves.toBe(false);
    await rm(root, { recursive: true, force: true });
  });

  test("copyToWorktree fails before writing when a source is missing or destination is not ignored", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "roark-copy-preflight-"));
    const control = path.join(root, "control");
    const worktree = path.join(root, "worktree");
    await mkdir(control, { recursive: true });
    await writeFile(path.join(control, "ignored"), "copy me\n", "utf8");
    await initGitRepo(worktree, "ignored\nmissing\n");

    await expect(refreshCopyToWorktree({ controlCwd: control, worktreePath: worktree, copyToWorktree: ["ignored", "missing"] })).rejects.toThrow("source 'missing' is missing");
    await expect(Bun.file(path.join(worktree, "ignored")).exists()).resolves.toBe(false);

    await writeFile(path.join(worktree, "ignored"), "stale\n", "utf8");
    await initGitRepo(worktree, "");
    await expect(refreshCopyToWorktree({ controlCwd: control, worktreePath: worktree, copyToWorktree: ["ignored"] })).rejects.toThrow("destination must be ignored");
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
      if (args[1] === "check-ignore") return ok();
      if (args[1] === "status") return ok("?? visible\n");
      return ok();
    };

    await expect(refreshCopyToWorktree({ controlCwd: control, worktreePath: worktree, copyToWorktree: ["visible"], runner })).rejects.toThrow("visible to Git");
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
    }).then((prepared) => prepared.releaseLock());
    expect(calls.some((args) => args[0] === "sh")).toBe(true);
    await rm(root, { recursive: true, force: true });
  });

  test("non-fatal afterRun hook warns without throwing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "roark-workspace-hook-"));
    await writeFile(path.join(root, "file"), "ok");
    await expect(runLifecycleHook("afterRun", { timeoutMs: 1000, afterRun: "false" }, root, async () => fail("after failed"))).resolves.toBeUndefined();
    await rm(root, { recursive: true, force: true });
  });
});

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
