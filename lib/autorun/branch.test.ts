import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runProcessOrThrow } from "../cli/process.ts";
import {
  assertSafeWorkBranch,
  autorunWorktreePath,
  createBranchPlan,
  defaultAutorunBaseBranch,
  ensureIssueWorktree,
  checkoutExistingIssueBranch,
  updateIssueBranchFromBase,
} from "./branch.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("autorun branch planning", () => {
  test("plans per-issue branches", () => {
    const plan = createBranchPlan({
      issueNumber: 123,
      branchName: "roark/issue-123",
    });

    expect(plan).toEqual({
      issueNumber: 123,
      branchName: "roark/issue-123",
      baseBranch: defaultAutorunBaseBranch,
    });
  });

  test("supports custom base branches", () => {
    const plan = createBranchPlan({
      issueNumber: 123,
      branchName: "roark/issue-123",
      baseBranch: "develop",
    });

    expect(plan.baseBranch).toBe("develop");
  });

  test("refuses to use the base branch as the work branch", () => {
    expect(() => { assertSafeWorkBranch({ branchName: "main", baseBranch: "main" }); }).toThrow(
      "Autorun work branch cannot be the base branch 'main'",
    );
  });

  test("refuses main as a work branch even with a non-main base branch", () => {
    expect(() => { assertSafeWorkBranch({ branchName: "main", baseBranch: "develop" }); }).toThrow(
      "Autorun work branch cannot be 'main'",
    );
  });

  test("computes the persistent issue worktree path under .roark/worktrees", () => {
    expect(autorunWorktreePath("/repo", 123)).toBe(path.resolve("/repo/.roark/worktrees/issue-123"));
  });
});

describe("autorun issue worktrees", () => {
  test("creates a persistent issue worktree without changing the control checkout branch", async () => {
    const { repo } = await createRepoWithRemote();
    const plan = createBranchPlan({ issueNumber: 123, branchName: "roark/issue-123", baseBranch: "main" });

    const agentCwd = await ensureIssueWorktree({ controlCwd: repo, plan });

    expect(agentCwd).toBe(autorunWorktreePath(repo, 123));
    expect(await gitOutput(repo, ["branch", "--show-current"])).toBe("main");
    expect(await gitOutput(agentCwd, ["branch", "--show-current"])).toBe("roark/issue-123");
    const status = await gitOutput(repo, ["status", "--porcelain", "--untracked-files=all"]);
    expect(status).not.toContain(".roark/worktrees/issue-123");
  });

  test("creates new work branches from origin/<baseBranch>", async () => {
    const { repo } = await createRepoWithRemote();
    await runProcessOrThrow(["git", "switch", "-c", "develop"], { cwd: repo });
    await writeFile(path.join(repo, "develop.txt"), "from develop\n", "utf8");
    await runProcessOrThrow(["git", "add", "develop.txt"], { cwd: repo });
    await runProcessOrThrow(["git", "commit", "-m", "develop"], { cwd: repo });
    await runProcessOrThrow(["git", "push", "-u", "origin", "develop"], { cwd: repo });
    await runProcessOrThrow(["git", "switch", "main"], { cwd: repo });

    const plan = createBranchPlan({ issueNumber: 124, branchName: "roark/issue-124", baseBranch: "develop" });
    const agentCwd = await ensureIssueWorktree({ controlCwd: repo, plan });

    expect(await gitOutput(agentCwd, ["branch", "--show-current"])).toBe("roark/issue-124");
    expect(await gitOutput(agentCwd, ["log", "--format=%s", "-1"])).toBe("develop");
  });

  test("updates from origin base before publish while preserving dirty worktree changes", async () => {
    const { repo } = await createRepoWithRemote();
    const plan = createBranchPlan({ issueNumber: 125, branchName: "roark/issue-125", baseBranch: "main" });
    const agentCwd = await ensureIssueWorktree({ controlCwd: repo, plan });

    await writeFile(path.join(agentCwd, "dirty.txt"), "agent edit\n", "utf8");
    await writeFile(path.join(repo, "base.txt"), "base update\n", "utf8");
    await runProcessOrThrow(["git", "add", "base.txt"], { cwd: repo });
    await runProcessOrThrow(["git", "commit", "-m", "base update"], { cwd: repo });
    await runProcessOrThrow(["git", "push", "origin", "main"], { cwd: repo });

    await updateIssueBranchFromBase({ agentCwd, baseBranch: "main", preserveUncommitted: true });

    expect(await gitOutput(agentCwd, ["log", "--format=%s", "-1"])).toBe("base update");
    expect(await readFile(path.join(agentCwd, "base.txt"), "utf8")).toBe("base update\n");
    expect(await readFile(path.join(agentCwd, "dirty.txt"), "utf8")).toBe("agent edit\n");
    expect(await gitOutput(agentCwd, ["status", "--porcelain"])).toContain("?? dirty.txt");
  });

  test("fresh auto refuses a dirty existing issue worktree", async () => {
    const { repo } = await createRepoWithRemote();
    const plan = createBranchPlan({ issueNumber: 126, branchName: "roark/issue-126", baseBranch: "main" });
    const agentCwd = await ensureIssueWorktree({ controlCwd: repo, plan });
    await writeFile(path.join(agentCwd, "dirty.txt"), "failed work\n", "utf8");

    expect(ensureIssueWorktree({ controlCwd: repo, plan })).rejects.toThrow("has uncommitted changes");
  });

  test("continue reuses an existing issue worktree and allows dirty state", async () => {
    const { repo } = await createRepoWithRemote();
    const plan = createBranchPlan({ issueNumber: 127, branchName: "roark/issue-127", baseBranch: "main" });
    const agentCwd = await ensureIssueWorktree({ controlCwd: repo, plan });
    await writeFile(path.join(agentCwd, "dirty.txt"), "failed work\n", "utf8");

    const recovered = await checkoutExistingIssueBranch({ cwd: repo, plan });

    expect(recovered).toBe(agentCwd);
    expect(await gitOutput(recovered, ["branch", "--show-current"])).toBe("roark/issue-127");
    expect(await gitOutput(recovered, ["status", "--porcelain"])).toContain("?? dirty.txt");
  });

  test("continue recreates a missing worktree from an existing local branch", async () => {
    const { repo } = await createRepoWithRemote();
    const plan = createBranchPlan({ issueNumber: 128, branchName: "roark/issue-128", baseBranch: "main" });
    const agentCwd = await ensureIssueWorktree({ controlCwd: repo, plan });
    await writeFile(path.join(agentCwd, "work.txt"), "committed work\n", "utf8");
    await runProcessOrThrow(["git", "add", "work.txt"], { cwd: agentCwd });
    await runProcessOrThrow(["git", "commit", "-m", "work"], { cwd: agentCwd });
    await rm(agentCwd, { recursive: true, force: true });

    const recovered = await checkoutExistingIssueBranch({ cwd: repo, plan });

    expect(recovered).toBe(agentCwd);
    expect(await gitOutput(recovered, ["branch", "--show-current"])).toBe("roark/issue-128");
    expect(await readFile(path.join(recovered, "work.txt"), "utf8")).toBe("committed work\n");
  });

  test("continue recreates a missing worktree from an existing remote branch", async () => {
    const { repo } = await createRepoWithRemote();
    const plan = createBranchPlan({ issueNumber: 129, branchName: "roark/issue-129", baseBranch: "main" });
    const agentCwd = await ensureIssueWorktree({ controlCwd: repo, plan });
    await writeFile(path.join(agentCwd, "remote-work.txt"), "remote work\n", "utf8");
    await runProcessOrThrow(["git", "add", "remote-work.txt"], { cwd: agentCwd });
    await runProcessOrThrow(["git", "commit", "-m", "remote work"], { cwd: agentCwd });
    await runProcessOrThrow(["git", "push", "-u", "origin", plan.branchName], { cwd: agentCwd });
    await runProcessOrThrow(["git", "worktree", "remove", "--force", agentCwd], { cwd: repo });
    await runProcessOrThrow(["git", "branch", "-D", plan.branchName], { cwd: repo });
    await runProcessOrThrow(["git", "update-ref", "-d", `refs/remotes/origin/${plan.branchName}`], { cwd: repo });

    const recovered = await checkoutExistingIssueBranch({ cwd: repo, plan });

    expect(recovered).toBe(agentCwd);
    expect(await gitOutput(recovered, ["branch", "--show-current"])).toBe("roark/issue-129");
    expect(await readFile(path.join(recovered, "remote-work.txt"), "utf8")).toBe("remote work\n");
  });

  test("continue fails clearly when neither worktree nor branch exists", async () => {
    const { repo } = await createRepoWithRemote();
    const plan = createBranchPlan({ issueNumber: 130, branchName: "roark/issue-130", baseBranch: "main" });

    expect(checkoutExistingIssueBranch({ cwd: repo, plan })).rejects.toThrow("neither local branch 'roark/issue-130' nor remote branch 'origin/roark/issue-130' exists");
  });
});

async function createRepoWithRemote(): Promise<{ repo: string; remote: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "roark-worktree-test-"));
  tempDirs.push(root);
  const repo = path.join(root, "repo");
  const remote = path.join(root, "remote.git");
  await runProcessOrThrow(["git", "init", "-b", "main", repo]);
  await runProcessOrThrow(["git", "config", "user.email", "test@example.com"], { cwd: repo });
  await runProcessOrThrow(["git", "config", "user.name", "Test User"], { cwd: repo });
  await writeFile(path.join(repo, "README.md"), "hello\n", "utf8");
  await runProcessOrThrow(["git", "add", "README.md"], { cwd: repo });
  await runProcessOrThrow(["git", "commit", "-m", "initial"], { cwd: repo });
  await runProcessOrThrow(["git", "init", "--bare", remote]);
  await runProcessOrThrow(["git", "remote", "add", "origin", remote], { cwd: repo });
  await runProcessOrThrow(["git", "push", "-u", "origin", "main"], { cwd: repo });
  return { repo, remote };
}

async function gitOutput(cwd: string, args: string[]): Promise<string> {
  return (await runProcessOrThrow(["git", ...args], { cwd })).trim();
}

