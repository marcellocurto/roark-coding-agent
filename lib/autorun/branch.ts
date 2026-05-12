import { existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { runProcess, runProcessOrThrow } from "../cli/process.ts";

export const defaultAutorunBaseBranch = "main";

export interface AutorunBranchPlan {
  issueNumber: number;
  branchName: string;
  baseBranch: string;
}

export function createBranchPlan(options: {
  issueNumber: number;
  branchName: string;
  baseBranch?: string | undefined;
}): AutorunBranchPlan {
  const baseBranch = options.baseBranch ?? defaultAutorunBaseBranch;
  assertSafeWorkBranch({ branchName: options.branchName, baseBranch });

  return {
    issueNumber: options.issueNumber,
    branchName: options.branchName,
    baseBranch,
  };
}

export function assertSafeWorkBranch(options: { branchName: string; baseBranch: string }): void {
  const branchName = options.branchName.trim();
  const baseBranch = options.baseBranch.trim();

  if (!branchName) throw new Error("Autorun work branch cannot be empty.");
  if (branchName === baseBranch) throw new Error(`Autorun work branch cannot be the base branch '${baseBranch}'.`);
  if (branchName === defaultAutorunBaseBranch) throw new Error(`Autorun work branch cannot be '${defaultAutorunBaseBranch}'.`);
}

export function autorunWorktreePath(controlCwd: string, issueNumber: number): string {
  return path.resolve(controlCwd, ".roark/worktrees", `issue-${issueNumber}`);
}

export async function ensureRoarkWorktreesIgnored(controlCwd: string): Promise<void> {
  const roarkDir = path.resolve(controlCwd, ".roark");
  await mkdir(roarkDir, { recursive: true });

  const ignorePath = path.join(roarkDir, ".gitignore");
  const desiredLine = "worktrees/";
  const existing = existsSync(ignorePath) ? await readFile(ignorePath, "utf8") : "";
  const lines = existing.split(/\r?\n/).map((line) => line.trim());
  if (lines.includes(desiredLine)) return;

  const prefix = existing.length === 0 || existing.endsWith("\n") ? existing : `${existing}\n`;
  await writeFile(ignorePath, `${prefix}${desiredLine}\n`, "utf8");
}

export async function ensureIssueWorktree(options: { controlCwd: string; plan: AutorunBranchPlan }): Promise<string> {
  const agentCwd = autorunWorktreePath(options.controlCwd, options.plan.issueNumber);
  await ensureRoarkWorktreesIgnored(options.controlCwd);
  await mkdir(path.dirname(agentCwd), { recursive: true });
  await runProcessOrThrow(["git", "fetch", "origin"], { cwd: options.controlCwd, label: "git fetch origin" });

  if (existsSync(agentCwd)) {
    await assertDirectory(agentCwd);
    await assertWorktreeOnBranch({ agentCwd, branchName: options.plan.branchName });
    if (await hasGitChanges(agentCwd)) {
      throw new Error(
        `Issue worktree '${agentCwd}' has uncommitted changes. Use 'roark continue ${options.plan.issueNumber} --cwd ${options.controlCwd}' to recover a failed attempt, or clean the worktree before starting fresh auto work.`,
      );
    }
    await updateIssueBranchFromBase({ agentCwd, baseBranch: options.plan.baseBranch });
    return agentCwd;
  }

  if (await gitBranchExists({ cwd: options.controlCwd, branchName: options.plan.branchName })) {
    await runProcessOrThrow(["git", "worktree", "add", agentCwd, options.plan.branchName], {
      cwd: options.controlCwd,
      label: "git worktree add",
    });
  } else {
    await runProcessOrThrow(["git", "worktree", "add", "-b", options.plan.branchName, agentCwd, `origin/${options.plan.baseBranch}`], {
      cwd: options.controlCwd,
      label: "git worktree add -b",
    });
  }

  await assertWorktreeOnBranch({ agentCwd, branchName: options.plan.branchName });
  await updateIssueBranchFromBase({ agentCwd, baseBranch: options.plan.baseBranch });
  return agentCwd;
}

export async function updateIssueBranchFromBase(options: {
  agentCwd: string;
  baseBranch: string;
  preserveUncommitted?: boolean | undefined;
}): Promise<void> {
  await runProcessOrThrow(["git", "fetch", "origin"], { cwd: options.agentCwd, label: "git fetch origin" });

  const shouldStash = options.preserveUncommitted === true && (await hasGitChanges(options.agentCwd));
  if (shouldStash) {
    await runProcessOrThrow(
      ["git", "stash", "push", "--include-untracked", "-m", "roark: preserve uncommitted changes before base merge"],
      { cwd: options.agentCwd, label: "git stash push" },
    );
  }

  let merged = false;
  try {
    await runProcessOrThrow(["git", "merge", `origin/${options.baseBranch}`], {
      cwd: options.agentCwd,
      label: `git merge origin/${options.baseBranch}`,
    });
    merged = true;
  } finally {
    if (shouldStash && merged) {
      await runProcessOrThrow(["git", "stash", "pop"], { cwd: options.agentCwd, label: "git stash pop" });
    }
  }
}

export async function checkoutIssueBranch(options: { cwd: string; plan: AutorunBranchPlan }): Promise<void> {
  await ensureIssueWorktree({ controlCwd: options.cwd, plan: options.plan });
}

export async function checkoutExistingIssueBranch(options: { cwd: string; plan: AutorunBranchPlan; worktreePath?: string }): Promise<string> {
  const agentCwd = path.resolve(options.worktreePath ?? autorunWorktreePath(options.cwd, options.plan.issueNumber));
  if (existsSync(agentCwd)) {
    await assertDirectory(agentCwd);
    await assertWorktreeOnBranch({ agentCwd, branchName: options.plan.branchName });
    return agentCwd;
  }

  await ensureRoarkWorktreesIgnored(options.cwd);
  await mkdir(path.dirname(agentCwd), { recursive: true });
  await runProcessOrThrow(["git", "worktree", "prune"], { cwd: options.cwd, label: "git worktree prune" });

  if (await gitBranchExists({ cwd: options.cwd, branchName: options.plan.branchName })) {
    await runProcessOrThrow(["git", "worktree", "add", agentCwd, options.plan.branchName], {
      cwd: options.cwd,
      label: "git worktree add",
    });
  } else {
    await fetchOriginIfAvailable(options.cwd);
    if (!(await gitRemoteBranchExists({ cwd: options.cwd, branchName: options.plan.branchName }))) {
      throw new Error(
        `Cannot continue autorun attempt for #${options.plan.issueNumber}: worktree '${agentCwd}' is missing and neither local branch '${options.plan.branchName}' nor remote branch 'origin/${options.plan.branchName}' exists.`,
      );
    }
    await runProcessOrThrow(["git", "worktree", "add", "-b", options.plan.branchName, agentCwd, `origin/${options.plan.branchName}`], {
      cwd: options.cwd,
      label: "git worktree add -b",
    });
  }

  await assertWorktreeOnBranch({ agentCwd, branchName: options.plan.branchName });
  return agentCwd;
}

async function assertDirectory(directoryPath: string): Promise<void> {
  const current = await stat(directoryPath);
  if (!current.isDirectory()) throw new Error(`${directoryPath} exists but is not a directory.`);
}

async function assertWorktreeOnBranch(options: { agentCwd: string; branchName: string }): Promise<void> {
  const currentBranch = (await runProcessOrThrow(["git", "branch", "--show-current"], {
    cwd: options.agentCwd,
    label: "git branch --show-current",
  })).trim();
  if (currentBranch !== options.branchName) {
    throw new Error(
      `Autorun worktree '${options.agentCwd}' is on branch '${currentBranch || "(detached)"}', expected '${options.branchName}'.`,
    );
  }
}

async function hasGitChanges(cwd: string): Promise<boolean> {
  const result = await runProcess(["git", "status", "--porcelain"], { cwd });
  if (result.exitCode !== 0) {
    throw new Error(`git status --porcelain failed with exit code ${result.exitCode}:\n${result.stderr || result.stdout}`);
  }
  return result.stdout.trim() !== "";
}

async function gitBranchExists(options: { cwd: string; branchName: string }): Promise<boolean> {
  const result = await runProcess(["git", "show-ref", "--verify", "--quiet", `refs/heads/${options.branchName}`], {
    cwd: options.cwd,
  });
  return result.exitCode === 0;
}

async function gitRemoteBranchExists(options: { cwd: string; branchName: string }): Promise<boolean> {
  const result = await runProcess(["git", "show-ref", "--verify", "--quiet", `refs/remotes/origin/${options.branchName}`], {
    cwd: options.cwd,
  });
  return result.exitCode === 0;
}

async function fetchOriginIfAvailable(cwd: string): Promise<void> {
  await runProcess(["git", "fetch", "origin"], { cwd });
}
