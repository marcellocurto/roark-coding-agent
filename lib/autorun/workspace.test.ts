import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  assertWorkspacePathSafe,
  defaultLifecycleHooks,
  defaultWorkspaceConfig,
  prepareCloneWorkspace,
  resolveCloneRemote,
  runLifecycleHook,
  sanitizeWorkspaceSegment,
  workspacePathForIssue,
  workspaceStateFile,
  type ProcessRunner,
} from "./workspace.ts";

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

  test("non-fatal afterRun hook warns without throwing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "roark-workspace-hook-"));
    await writeFile(path.join(root, "file"), "ok");
    await expect(runLifecycleHook("afterRun", { timeoutMs: 1000, afterRun: "false" }, root, async () => fail("after failed"))).resolves.toBeUndefined();
    await rm(root, { recursive: true, force: true });
  });
});
