import { runProcessOrThrow } from "../cli/process.ts";
import type { PullRequestMetadata } from "../github/pr.ts";

const unsafeHeadBranchNames = new Set(["main", "master", "develop", "development", "trunk", "release"]);

export function validatePrBranchSafety(pr: PullRequestMetadata, repo: string): void {
  if (pr.state !== "OPEN") throw new Error(`PR #${pr.number} must be open. Current state: ${pr.state}.`);
  if (!pr.headRefName.trim()) throw new Error(`PR #${pr.number} has an empty head branch name.`);
  if (!pr.baseRefName.trim()) throw new Error(`PR #${pr.number} has an empty base branch name.`);
  if (pr.headRefName === pr.baseRefName) {
    throw new Error(`Refusing to revise PR #${pr.number}: head branch '${pr.headRefName}' matches base branch.`);
  }
  if (unsafeHeadBranchNames.has(pr.headRefName)) {
    throw new Error(`Refusing to revise PR #${pr.number}: '${pr.headRefName}' is an unsafe shared/base branch name.`);
  }
  if (pr.headRepository && pr.headRepository !== repo) {
    throw new Error(
      `PR #${pr.number} uses fork head repository '${pr.headRepository}'. Fork PR revision checkout/push is unsupported in v1.`,
    );
  }
  if (pr.baseRepository && pr.baseRepository !== repo) {
    throw new Error(`PR #${pr.number} base repository '${pr.baseRepository}' does not match target repo '${repo}'.`);
  }
}

export function buildPrCheckoutArgv(input: { prNumber: number; repo?: string }): string[] {
  return ["gh", "pr", "checkout", String(input.prNumber), ...(input.repo ? ["--repo", input.repo] : [])];
}

export async function checkoutPrHeadBranch(options: { cwd: string; repo?: string; pr: PullRequestMetadata }): Promise<void> {
  await runProcessOrThrow(buildPrCheckoutArgv({ prNumber: options.pr.number, repo: options.repo }), {
    cwd: options.cwd,
    label: "gh pr checkout",
  });
  const currentBranch = (await runProcessOrThrow(["git", "branch", "--show-current"], {
    cwd: options.cwd,
    label: "git branch --show-current",
  })).trim();
  if (currentBranch !== options.pr.headRefName) {
    throw new Error(
      `After gh pr checkout, current branch is '${currentBranch || "(detached)"}' but PR head is '${options.pr.headRefName}'.`,
    );
  }
}
