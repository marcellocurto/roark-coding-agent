import type { AutoCliOptions, IssueCliOptions } from "../cli/args.ts";
import { createWorkflowContext, type WorkflowContext } from "../workflow/artifacts.ts";
import type { AutorunIssueCandidate } from "./selection.ts";
import { autorunWorktreePath, type AutorunBranchPlan } from "./branch.ts";

export function createAutorunWorkflowContext(
  issue: AutorunIssueCandidate,
  branchPlan: AutorunBranchPlan,
  options: AutoCliOptions,
  attempt?: number,
  agentCwd = autorunWorktreePath(options.cwd, issue.number),
): WorkflowContext {
  return createWorkflowContext(
    createAutorunWorkflowOptions(issue, branchPlan, options, attempt),
    { agentCwd },
  );
}

export function createAutorunWorkflowOptions(
  issue: AutorunIssueCandidate,
  branchPlan: AutorunBranchPlan,
  options: AutoCliOptions,
  attempt?: number,
): IssueCliOptions {
  return {
    command: "do",
    issue: String(issue.number),
    cwd: options.cwd,
    outDir: ".roark/runs",
    repo: options.repo,
    model: options.model,
    thinkingLevel: options.thinkingLevel,
    force: options.force,
    yes: options.yes,
    maxFixPasses: options.maxFixPasses,
    attempt,
  };
}
