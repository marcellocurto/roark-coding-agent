import type { AutoCliOptions, IssueCliOptions } from "../cli/args.ts";
import { createWorkflowContext, type WorkflowContext } from "../workflow/artifacts.ts";
import type { AutorunIssueCandidate } from "./selection.ts";
import type { AutorunWorktreePlan } from "./worktree.ts";

export function createAutorunWorkflowContext(
  issue: AutorunIssueCandidate,
  worktreePlan: AutorunWorktreePlan,
  options: AutoCliOptions,
): WorkflowContext {
  return createWorkflowContext(createAutorunWorkflowOptions(issue, worktreePlan, options));
}

export function createAutorunWorkflowOptions(
  issue: AutorunIssueCandidate,
  worktreePlan: AutorunWorktreePlan,
  options: AutoCliOptions,
): IssueCliOptions {
  return {
    command: "do",
    issue: String(issue.number),
    cwd: worktreePlan.worktreePath,
    outDir: ".roark/runs",
    repo: options.repo,
    model: options.model,
    thinkingLevel: options.thinkingLevel,
    force: options.force,
    yes: options.yes,
    maxFixPasses: options.maxFixPasses,
  };
}
