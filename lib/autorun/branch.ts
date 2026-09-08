import type { ApplicationExecution } from "../runtime/application.ts";
import { existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { runProcessPromise, runProcessOrThrowPromise } from "../cli/process.ts";

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

export async function ensureIssueWorktree(options: { controlCwd: string; plan: AutorunBranchPlan }, application?: ApplicationExecution): Promise<string> {
  const agentCwd = autorunWorktreePath(options.controlCwd, options.plan.issueNumber);
  await ensureRoarkWorktreesIgnored(options.controlCwd);
  await mkdir(path.dirname(agentCwd), { recursive: true });
  if (existsSync(agentCwd)) {
    await assertDirectory(agentCwd);
    await assertWorktreeOnBranch({ agentCwd, branchName: options.plan.branchName }, application);
    if (await hasGitChanges(agentCwd, application)) {
      throw new Error(
        `Issue worktree '${agentCwd}' has uncommitted changes. Use 'roark continue ${options.plan.issueNumber} --cwd ${options.controlCwd}' to recover a failed attempt, or clean the worktree before starting fresh auto work.`,
      );
    }
    return agentCwd;
  }

  if (await gitBranchExists({ cwd: options.controlCwd, branchName: options.plan.branchName }, application)) {
    await runProcessOrThrowPromise(["git", "worktree", "add", agentCwd, options.plan.branchName], {
      cwd: options.controlCwd,
      label: "git worktree add",
    }, application);
  } else {
    await runProcessOrThrowPromise(["git", "fetch", "origin"], { cwd: options.controlCwd, label: "git fetch origin" }, application);
    await runProcessOrThrowPromise(["git", "worktree", "add", "-b", options.plan.branchName, agentCwd, `origin/${options.plan.baseBranch}`], {
      cwd: options.controlCwd,
      label: "git worktree add -b",
    }, application);
  }

  await assertWorktreeOnBranch({ agentCwd, branchName: options.plan.branchName }, application);
  return agentCwd;
}

export async function checkoutIssueBranch(options: { cwd: string; plan: AutorunBranchPlan }, application?: ApplicationExecution): Promise<void> {
  await ensureIssueWorktree({ controlCwd: options.cwd, plan: options.plan }, application);
}

export async function checkoutExistingIssueBranch(options: { cwd: string; plan: AutorunBranchPlan; worktreePath?: string }, application?: ApplicationExecution): Promise<string> {
  const agentCwd = path.resolve(options.worktreePath ?? autorunWorktreePath(options.cwd, options.plan.issueNumber));
  if (existsSync(agentCwd)) {
    await assertDirectory(agentCwd);
    await assertWorktreeOnBranch({ agentCwd, branchName: options.plan.branchName }, application);
    return agentCwd;
  }

  await ensureRoarkWorktreesIgnored(options.cwd);
  await mkdir(path.dirname(agentCwd), { recursive: true });
  await runProcessOrThrowPromise(["git", "worktree", "prune"], { cwd: options.cwd, label: "git worktree prune" }, application);

  if (await gitBranchExists({ cwd: options.cwd, branchName: options.plan.branchName }, application)) {
    await runProcessOrThrowPromise(["git", "worktree", "add", agentCwd, options.plan.branchName], {
      cwd: options.cwd,
      label: "git worktree add",
    }, application);
  } else {
    await fetchOriginIfAvailable(options.cwd, application);
    if (!(await gitRemoteBranchExists({ cwd: options.cwd, branchName: options.plan.branchName }, application))) {
      throw new Error(
        `Cannot continue autorun attempt for #${options.plan.issueNumber}: worktree '${agentCwd}' is missing and neither local branch '${options.plan.branchName}' nor remote branch 'origin/${options.plan.branchName}' exists.`,
      );
    }
    await runProcessOrThrowPromise(["git", "worktree", "add", "-b", options.plan.branchName, agentCwd, `origin/${options.plan.branchName}`], {
      cwd: options.cwd,
      label: "git worktree add -b",
    }, application);
  }

  await assertWorktreeOnBranch({ agentCwd, branchName: options.plan.branchName }, application);
  return agentCwd;
}

async function assertDirectory(directoryPath: string): Promise<void> {
  const current = await stat(directoryPath);
  if (!current.isDirectory()) throw new Error(`${directoryPath} exists but is not a directory.`);
}

async function assertWorktreeOnBranch(options: { agentCwd: string; branchName: string }, application?: ApplicationExecution): Promise<void> {
  const currentBranch = (await runProcessOrThrowPromise(["git", "branch", "--show-current"], {
    cwd: options.agentCwd,
    label: "git branch --show-current",
  }, application)).trim();
  if (currentBranch !== options.branchName) {
    throw new Error(
      `Autorun worktree '${options.agentCwd}' is on branch '${currentBranch || "(detached)"}', expected '${options.branchName}'.`,
    );
  }
}

async function hasGitChanges(cwd: string, application?: ApplicationExecution): Promise<boolean> {
  const result = await runProcessPromise(["git", "status", "--porcelain"], { cwd }, application);
  if (result.exitCode !== 0) {
    throw new Error(`git status --porcelain failed with exit code ${result.exitCode}:\n${result.stderr || result.stdout}`);
  }
  return result.stdout.trim() !== "";
}

async function gitBranchExists(options: { cwd: string; branchName: string }, application?: ApplicationExecution): Promise<boolean> {
  const result = await runProcessPromise(["git", "show-ref", "--verify", "--quiet", `refs/heads/${options.branchName}`], {
    cwd: options.cwd,
  }, application);
  return result.exitCode === 0;
}

async function gitRemoteBranchExists(options: { cwd: string; branchName: string }, application?: ApplicationExecution): Promise<boolean> {
  const result = await runProcessPromise(["git", "show-ref", "--verify", "--quiet", `refs/remotes/origin/${options.branchName}`], {
    cwd: options.cwd,
  }, application);
  return result.exitCode === 0;
}

async function fetchOriginIfAvailable(cwd: string, application?: ApplicationExecution): Promise<void> {
  await runProcessPromise(["git", "fetch", "origin"], { cwd }, application);
}
