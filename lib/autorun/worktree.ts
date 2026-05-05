import path from "node:path";
import { mkdir } from "node:fs/promises";
import { runProcess, runProcessOrThrow } from "../cli/process.ts";

export const defaultAutorunBaseBranch = "main";
export const defaultAutorunWorktreeRoot = ".roark/worktrees";

export type AutorunWorktreePlan = {
  issueNumber: number;
  branchName: string;
  baseBranch: string;
  worktreePath: string;
  worktreePathRelative: string;
};

export function createWorktreePlan(options: {
  cwd: string;
  issueNumber: number;
  branchName: string;
  baseBranch?: string;
  worktreeRoot?: string;
}): AutorunWorktreePlan {
  const baseBranch = options.baseBranch ?? defaultAutorunBaseBranch;
  assertSafeWorkBranch({ branchName: options.branchName, baseBranch });

  const worktreePathRelative = path.join(options.worktreeRoot ?? defaultAutorunWorktreeRoot, `issue-${options.issueNumber}`);
  return {
    issueNumber: options.issueNumber,
    branchName: options.branchName,
    baseBranch,
    worktreePath: path.resolve(options.cwd, worktreePathRelative),
    worktreePathRelative,
  };
}

export function assertSafeWorkBranch(options: { branchName: string; baseBranch: string }): void {
  const branchName = options.branchName.trim();
  const baseBranch = options.baseBranch.trim();

  if (!branchName) throw new Error("Autorun work branch cannot be empty.");
  if (branchName === baseBranch) throw new Error(`Autorun work branch cannot be the base branch '${baseBranch}'.`);
  if (branchName === defaultAutorunBaseBranch) throw new Error(`Autorun work branch cannot be '${defaultAutorunBaseBranch}'.`);
}

export async function createIssueWorktree(options: { cwd: string; plan: AutorunWorktreePlan }): Promise<void> {
  await mkdir(path.dirname(options.plan.worktreePath), { recursive: true });

  if (await gitBranchExists({ cwd: options.cwd, branchName: options.plan.branchName })) {
    await runProcessOrThrow(
      ["git", "worktree", "add", options.plan.worktreePath, options.plan.branchName],
      { cwd: options.cwd, label: "git worktree add" },
    );
    return;
  }

  await runProcessOrThrow(
    ["git", "worktree", "add", "-b", options.plan.branchName, options.plan.worktreePath, options.plan.baseBranch],
    { cwd: options.cwd, label: "git worktree add -b" },
  );
}

async function gitBranchExists(options: { cwd: string; branchName: string }): Promise<boolean> {
  const result = await runProcess(["git", "show-ref", "--verify", "--quiet", `refs/heads/${options.branchName}`], {
    cwd: options.cwd,
  });
  return result.exitCode === 0;
}
