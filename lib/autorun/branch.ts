import { runProcess, runProcessOrThrow } from "../cli/process.ts";

export const defaultAutorunBaseBranch = "main";

export type AutorunBranchPlan = {
  issueNumber: number;
  branchName: string;
  baseBranch: string;
};

export function createBranchPlan(options: {
  issueNumber: number;
  branchName: string;
  baseBranch?: string;
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

export async function checkoutIssueBranch(options: { cwd: string; plan: AutorunBranchPlan }): Promise<void> {
  if (await gitBranchExists({ cwd: options.cwd, branchName: options.plan.branchName })) {
    await switchBranch({ cwd: options.cwd, branchName: options.plan.branchName });
    return;
  }

  await runProcessOrThrow(["git", "switch", "-c", options.plan.branchName, options.plan.baseBranch], {
    cwd: options.cwd,
    label: "git switch -c",
  });
}

export async function checkoutExistingIssueBranch(options: { cwd: string; plan: AutorunBranchPlan }): Promise<void> {
  const exists = await gitBranchExists({ cwd: options.cwd, branchName: options.plan.branchName });
  if (!exists) {
    throw new Error(
      `Cannot continue autorun attempt for #${options.plan.issueNumber}: branch '${options.plan.branchName}' does not exist.`,
    );
  }
  await switchBranch({ cwd: options.cwd, branchName: options.plan.branchName });
}

async function switchBranch(options: { cwd: string; branchName: string }): Promise<void> {
  await runProcessOrThrow(["git", "switch", options.branchName], {
    cwd: options.cwd,
    label: "git switch",
  });
}

async function gitBranchExists(options: { cwd: string; branchName: string }): Promise<boolean> {
  const result = await runProcess(["git", "show-ref", "--verify", "--quiet", `refs/heads/${options.branchName}`], {
    cwd: options.cwd,
  });
  return result.exitCode === 0;
}
