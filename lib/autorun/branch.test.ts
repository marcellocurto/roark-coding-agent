import { rejects as assertRejects } from "node:assert/strict";
import { runApplicationPromise } from "../runtime/application.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runProcessOrThrowPromise } from "../cli/process-promise.ts";
import {
  assertSafeWorkBranch,
  autorunWorktreePath,
  createBranchPlan,
  defaultAutorunBaseBranch,
} from "./branch.ts";
import { ensureIssueWorktree, checkoutExistingIssueBranch } from "./branch.ts";
const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
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
    expect(() => {
      assertSafeWorkBranch({ branchName: "main", baseBranch: "main" });
    }).toThrow("Autorun work branch cannot be the base branch 'main'");
  });
  test("refuses main as a work branch even with a non-main base branch", () => {
    expect(() => {
      assertSafeWorkBranch({ branchName: "main", baseBranch: "develop" });
    }).toThrow("Autorun work branch cannot be 'main'");
  });
  test("computes the persistent issue worktree path under .roark/worktrees", () => {
    expect(autorunWorktreePath("/repo", 123)).toBe(
      path.resolve("/repo/.roark/worktrees/issue-123"),
    );
  });
});
describe("autorun issue worktrees", () => {
  test("creates a persistent issue worktree without changing the control checkout branch", async () => {
    const { repo } = await createRepoWithRemote();
    const plan = createBranchPlan({
      issueNumber: 123,
      branchName: "roark/issue-123",
      baseBranch: "main",
    });
    const agentCwd = await runApplicationPromise(
      ensureIssueWorktree({ controlCwd: repo, plan }),
    );
    expect(agentCwd).toBe(autorunWorktreePath(repo, 123));
    expect(await gitOutput(repo, ["branch", "--show-current"])).toBe("main");
    expect(await gitOutput(agentCwd, ["branch", "--show-current"])).toBe(
      "roark/issue-123",
    );
    const status = await gitOutput(repo, [
      "status",
      "--porcelain",
      "--untracked-files=all",
    ]);
    expect(status).not.toContain(".roark/worktrees/issue-123");
  });
  test("creates new work branches from origin/<baseBranch>", async () => {
    const { repo } = await createRepoWithRemote();
    await runProcessOrThrowPromise(["git", "switch", "-c", "develop"], {
      cwd: repo,
    });
    await writeFile(path.join(repo, "develop.txt"), "from develop\n", "utf8");
    await runProcessOrThrowPromise(["git", "add", "develop.txt"], {
      cwd: repo,
    });
    await runProcessOrThrowPromise(["git", "commit", "-m", "develop"], {
      cwd: repo,
    });
    await runProcessOrThrowPromise(["git", "push", "-u", "origin", "develop"], {
      cwd: repo,
    });
    await runProcessOrThrowPromise(["git", "switch", "main"], { cwd: repo });
    const plan = createBranchPlan({
      issueNumber: 124,
      branchName: "roark/issue-124",
      baseBranch: "develop",
    });
    const agentCwd = await runApplicationPromise(
      ensureIssueWorktree({ controlCwd: repo, plan }),
    );
    expect(await gitOutput(agentCwd, ["branch", "--show-current"])).toBe(
      "roark/issue-124",
    );
    expect(await gitOutput(agentCwd, ["log", "--format=%s", "-1"])).toBe(
      "develop",
    );
  });
  test("reuses an existing issue worktree without merging a moved origin base", async () => {
    const { repo } = await createRepoWithRemote();
    const plan = createBranchPlan({
      issueNumber: 125,
      branchName: "roark/issue-125",
      baseBranch: "main",
    });
    const agentCwd = await runApplicationPromise(
      ensureIssueWorktree({ controlCwd: repo, plan }),
    );
    const originalHead = await gitOutput(agentCwd, ["rev-parse", "HEAD"]);
    await writeFile(path.join(repo, "base.txt"), "base update\n", "utf8");
    await runProcessOrThrowPromise(["git", "add", "base.txt"], { cwd: repo });
    await runProcessOrThrowPromise(["git", "commit", "-m", "base update"], {
      cwd: repo,
    });
    await runProcessOrThrowPromise(["git", "push", "origin", "main"], {
      cwd: repo,
    });
    const reused = await runApplicationPromise(
      ensureIssueWorktree({ controlCwd: repo, plan }),
    );
    expect(reused).toBe(agentCwd);
    expect(await gitOutput(agentCwd, ["rev-parse", "HEAD"])).toBe(originalHead);
    expect(await Bun.file(path.join(agentCwd, "base.txt")).exists()).toBe(
      false,
    );
  });
  test("fresh auto refuses a dirty existing issue worktree", async () => {
    const { repo } = await createRepoWithRemote();
    const plan = createBranchPlan({
      issueNumber: 126,
      branchName: "roark/issue-126",
      baseBranch: "main",
    });
    const agentCwd = await runApplicationPromise(
      ensureIssueWorktree({ controlCwd: repo, plan }),
    );
    await writeFile(path.join(agentCwd, "dirty.txt"), "failed work\n", "utf8");
    await assertRejects(
      runApplicationPromise(ensureIssueWorktree({ controlCwd: repo, plan })),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes("has uncommitted changes"),
    );
  });
  test("continue reuses an existing issue worktree and allows dirty state", async () => {
    const { repo } = await createRepoWithRemote();
    const plan = createBranchPlan({
      issueNumber: 127,
      branchName: "roark/issue-127",
      baseBranch: "main",
    });
    const agentCwd = await runApplicationPromise(
      ensureIssueWorktree({ controlCwd: repo, plan }),
    );
    await writeFile(path.join(agentCwd, "dirty.txt"), "failed work\n", "utf8");
    const recovered = await runApplicationPromise(
      checkoutExistingIssueBranch({ cwd: repo, plan }),
    );
    expect(recovered).toBe(agentCwd);
    expect(await gitOutput(recovered, ["branch", "--show-current"])).toBe(
      "roark/issue-127",
    );
    expect(await gitOutput(recovered, ["status", "--porcelain"])).toContain(
      "?? dirty.txt",
    );
  });
  test("continue recreates a missing worktree from an existing local branch", async () => {
    const { repo } = await createRepoWithRemote();
    const plan = createBranchPlan({
      issueNumber: 128,
      branchName: "roark/issue-128",
      baseBranch: "main",
    });
    const agentCwd = await runApplicationPromise(
      ensureIssueWorktree({ controlCwd: repo, plan }),
    );
    await writeFile(
      path.join(agentCwd, "work.txt"),
      "committed work\n",
      "utf8",
    );
    await runProcessOrThrowPromise(["git", "add", "work.txt"], {
      cwd: agentCwd,
    });
    await runProcessOrThrowPromise(["git", "commit", "-m", "work"], {
      cwd: agentCwd,
    });
    await rm(agentCwd, { recursive: true, force: true });
    const recovered = await runApplicationPromise(
      checkoutExistingIssueBranch({ cwd: repo, plan }),
    );
    expect(recovered).toBe(agentCwd);
    expect(await gitOutput(recovered, ["branch", "--show-current"])).toBe(
      "roark/issue-128",
    );
    expect(await readFile(path.join(recovered, "work.txt"), "utf8")).toBe(
      "committed work\n",
    );
  });
  test("continue recreates a missing worktree from an existing remote branch", async () => {
    const { repo } = await createRepoWithRemote();
    const plan = createBranchPlan({
      issueNumber: 129,
      branchName: "roark/issue-129",
      baseBranch: "main",
    });
    const agentCwd = await runApplicationPromise(
      ensureIssueWorktree({ controlCwd: repo, plan }),
    );
    await writeFile(
      path.join(agentCwd, "remote-work.txt"),
      "remote work\n",
      "utf8",
    );
    await runProcessOrThrowPromise(["git", "add", "remote-work.txt"], {
      cwd: agentCwd,
    });
    await runProcessOrThrowPromise(["git", "commit", "-m", "remote work"], {
      cwd: agentCwd,
    });
    await runProcessOrThrowPromise(
      ["git", "push", "-u", "origin", plan.branchName],
      { cwd: agentCwd },
    );
    await runProcessOrThrowPromise(
      ["git", "worktree", "remove", "--force", agentCwd],
      { cwd: repo },
    );
    await runProcessOrThrowPromise(["git", "branch", "-D", plan.branchName], {
      cwd: repo,
    });
    await runProcessOrThrowPromise(
      ["git", "update-ref", "-d", `refs/remotes/origin/${plan.branchName}`],
      { cwd: repo },
    );
    const recovered = await runApplicationPromise(
      checkoutExistingIssueBranch({ cwd: repo, plan }),
    );
    expect(recovered).toBe(agentCwd);
    expect(await gitOutput(recovered, ["branch", "--show-current"])).toBe(
      "roark/issue-129",
    );
    expect(
      await readFile(path.join(recovered, "remote-work.txt"), "utf8"),
    ).toBe("remote work\n");
  });
  test("continue fails clearly when neither worktree nor branch exists", async () => {
    const { repo } = await createRepoWithRemote();
    const plan = createBranchPlan({
      issueNumber: 130,
      branchName: "roark/issue-130",
      baseBranch: "main",
    });
    await assertRejects(
      runApplicationPromise(checkoutExistingIssueBranch({ cwd: repo, plan })),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes(
          "neither local branch 'roark/issue-130' nor remote branch 'origin/roark/issue-130' exists",
        ),
    );
  });
});
async function createRepoWithRemote(): Promise<{
  repo: string;
  remote: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "roark-worktree-test-"));
  tempDirs.push(root);
  const repo = path.join(root, "repo");
  const remote = path.join(root, "remote.git");
  await runProcessOrThrowPromise(["git", "init", "-b", "main", repo]);
  await runProcessOrThrowPromise(
    ["git", "config", "user.email", "test@example.com"],
    { cwd: repo },
  );
  await runProcessOrThrowPromise(["git", "config", "user.name", "Test User"], {
    cwd: repo,
  });
  await writeFile(path.join(repo, "README.md"), "hello\n", "utf8");
  await runProcessOrThrowPromise(["git", "add", "README.md"], { cwd: repo });
  await runProcessOrThrowPromise(["git", "commit", "-m", "initial"], {
    cwd: repo,
  });
  await runProcessOrThrowPromise(["git", "init", "--bare", remote]);
  await runProcessOrThrowPromise(["git", "remote", "add", "origin", remote], {
    cwd: repo,
  });
  await runProcessOrThrowPromise(["git", "push", "-u", "origin", "main"], {
    cwd: repo,
  });
  return { repo, remote };
}
async function gitOutput(cwd: string, args: string[]): Promise<string> {
  return (await runProcessOrThrowPromise(["git", ...args], { cwd })).trim();
}
