import { defaultAutorunFailureLabel } from "../autorun/failure.ts";
import {
  defaultAutorunInProgressLabel,
  defaultAutorunReadyLabel,
  defaultAutorunSkipLabels,
} from "../autorun/selection.ts";
import { defaultAutorunVerifyCommand } from "../autorun/verification.ts";
import { defaultAutorunBaseBranch, defaultAutorunWorktreeRoot } from "../autorun/worktree.ts";

export type IssueWorkflowCommand =
  | "do"
  | "fetch"
  | "triage"
  | "plan"
  | "implement"
  | "review"
  | "fix"
  | "final-review"
  | "readiness";

export type WorkflowCommand = IssueWorkflowCommand | "auto";

export const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
export type ThinkingLevel = (typeof thinkingLevels)[number];

export type IssueCliOptions = {
  command: IssueWorkflowCommand;
  issue: string;
  cwd: string;
  outDir: string;
  repo?: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  force: boolean;
  yes: boolean;
  maxFixPasses: number;
  fixPass?: number;
};

export type AutoCliOptions = {
  command: "auto";
  cwd: string;
  repo?: string;
  readyLabel: string;
  skipLabels: string[];
  limit: number;
  inProgressLabel: string;
  assignee?: string;
  noAssign: boolean;
  dryRun: boolean;
  baseBranch: string;
  worktreeRoot: string;
  verifyCommand: string;
  failureLabel: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  maxFixPasses: number;
  force: boolean;
  yes: boolean;
};

export type CliOptions = IssueCliOptions | AutoCliOptions;

const issueCommands = new Set<IssueWorkflowCommand>([
  "do",
  "fetch",
  "triage",
  "plan",
  "implement",
  "review",
  "fix",
  "final-review",
  "readiness",
]);

const commands = new Set<WorkflowCommand>([...issueCommands, "auto"]);

export const usage = `roark-coding-agent <command> [issue] [options]

Commands:
  auto                  Find and claim eligible GitHub issues, create worktrees, and run the full workflow.
  do <issue>             Run the full issue workflow.
  fetch <issue>          Fetch the GitHub issue into .roark/runs/issue/<number>/.
  triage <issue>         Run only the triage agent.
  plan <issue>           Run only the implementation planning agent.
  implement <issue>      Run only the implementation agent.
  review <issue>         Run both review agents.
  fix <issue>            Run only the fix agent.
  final-review <issue>   Run only the final review agent.
  readiness <issue>      Write deterministic PR readiness markdown.

Issue can be a number, a GitHub issue URL, or owner/repo#123.
The auto command does not take an issue argument.

Options:
  --repo <owner/repo>    Repository for gh issue commands.
  --cwd <path>           Repository working directory. Defaults to current directory.
  --out <path>           Runs directory. Defaults to .roark/runs.
  --model <provider/id>  Optional Pi model override, e.g. anthropic/claude-sonnet-4-5.
  --thinking <level>     Override thinking level for agent-backed phases (off|minimal|low|medium|high|xhigh).
  --max-fix-passes <n>   Maximum automatic fix/review cycles for do. Defaults to 1.
  --fix-pass <n>         Pass number for standalone fix/final-review.
  --label <label>        Auto eligibility label. Defaults to ${defaultAutorunReadyLabel}.
  --skip-label <label>   Auto skip label. Can be passed multiple times.
  --skip-labels <labels> Auto skip labels as a comma-separated list.
  --limit <n>            Maximum number of eligible auto issues to claim. Defaults to 1.
  --in-progress-label <label>
                          Auto claim label. Defaults to ${defaultAutorunInProgressLabel}.
  --assignee <login>     GitHub user to assign when claiming. Defaults to the authenticated gh user.
  --no-assign            Claim without assigning a user.
  --dry-run              Print selected issues without claiming them or creating worktrees.
  --base-branch <branch> Auto worktree base branch. Defaults to ${defaultAutorunBaseBranch}.
  --worktree-root <path> Auto worktree root. Defaults to ${defaultAutorunWorktreeRoot}.
  --verify <cmd>         Verification command to run before publishing. Runs via 'sh -c'. Defaults to '${defaultAutorunVerifyCommand}'.
  --failure-label <label>
                          Label applied to the issue when readiness or verification fails. Defaults to ${defaultAutorunFailureLabel}.
  --force                Re-run phases even if their markdown artifact already exists.
  --yes                  Continue past dirty git preflight for implementation/fix.
  -h, --help             Show this help.
`;

export function parseArgs(argv: string[]): CliOptions | { help: true } {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) return { help: true };

  const [rawCommand, ...rest] = argv;
  if (!rawCommand || !commands.has(rawCommand as WorkflowCommand)) {
    throw new Error(`Unknown command '${rawCommand ?? ""}'.\n\n${usage}`);
  }

  if (rawCommand === "auto") return parseAutoArgs(rest);
  return parseIssueArgs(rawCommand as IssueWorkflowCommand, rest);
}

function parseAutoArgs(args: string[]): AutoCliOptions {
  const options: AutoCliOptions = {
    command: "auto",
    cwd: process.cwd(),
    readyLabel: defaultAutorunReadyLabel,
    skipLabels: [...defaultAutorunSkipLabels],
    limit: 1,
    inProgressLabel: defaultAutorunInProgressLabel,
    noAssign: false,
    dryRun: false,
    baseBranch: defaultAutorunBaseBranch,
    worktreeRoot: defaultAutorunWorktreeRoot,
    verifyCommand: defaultAutorunVerifyCommand,
    failureLabel: defaultAutorunFailureLabel,
    maxFixPasses: 1,
    force: false,
    yes: false,
  };

  let skipLabelsProvided = false;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--repo") options.repo = requiredValue(args, ++index, arg);
    else if (arg === "--cwd") options.cwd = requiredValue(args, ++index, arg);
    else if (arg === "--label") options.readyLabel = requiredValue(args, ++index, arg);
    else if (arg === "--skip-label") {
      if (!skipLabelsProvided) {
        options.skipLabels = [];
        skipLabelsProvided = true;
      }
      options.skipLabels.push(requiredValue(args, ++index, arg));
    } else if (arg === "--skip-labels") {
      if (!skipLabelsProvided) {
        options.skipLabels = [];
        skipLabelsProvided = true;
      }
      options.skipLabels.push(...parseCommaSeparatedLabels(requiredValue(args, ++index, arg)));
    } else if (arg === "--limit") options.limit = parsePositiveInteger(requiredValue(args, ++index, arg), arg);
    else if (arg === "--in-progress-label") options.inProgressLabel = requiredValue(args, ++index, arg);
    else if (arg === "--assignee") options.assignee = requiredValue(args, ++index, arg);
    else if (arg === "--no-assign") options.noAssign = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--base-branch") options.baseBranch = requiredValue(args, ++index, arg);
    else if (arg === "--worktree-root") options.worktreeRoot = requiredValue(args, ++index, arg);
    else if (arg === "--verify") options.verifyCommand = requiredValue(args, ++index, arg);
    else if (arg === "--failure-label") options.failureLabel = requiredValue(args, ++index, arg);
    else if (arg === "--model") options.model = requiredValue(args, ++index, arg);
    else if (arg === "--thinking") options.thinkingLevel = parseThinkingLevel(requiredValue(args, ++index, arg), arg);
    else if (arg === "--max-fix-passes") options.maxFixPasses = parsePositiveInteger(requiredValue(args, ++index, arg), arg);
    else if (arg === "--force") options.force = true;
    else if (arg === "--yes") options.yes = true;
    else if (arg?.startsWith("--")) throw new Error(`Unknown option '${arg}'.\n\n${usage}`);
    else throw new Error(`The auto command does not take an issue argument. Got '${arg}'.\n\n${usage}`);
  }

  if (options.noAssign && options.assignee) {
    throw new Error("--assignee cannot be combined with --no-assign.");
  }

  return options;
}

function parseIssueArgs(command: IssueWorkflowCommand, args: string[]): IssueCliOptions {
  const [rawIssue, ...rest] = args;
  if (!rawIssue) throw new Error(`Missing issue.\n\n${usage}`);
  if (rawIssue.startsWith("--")) throw new Error(`Missing issue.\n\n${usage}`);

  const options: IssueCliOptions = {
    command,
    issue: rawIssue,
    cwd: process.cwd(),
    outDir: ".roark/runs",
    force: false,
    yes: false,
    maxFixPasses: 1,
  };

  let maxFixPassesProvided = false;
  let fixPassProvided = false;

  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index];
    if (arg === "--repo") options.repo = requiredValue(rest, ++index, arg);
    else if (arg === "--cwd") options.cwd = requiredValue(rest, ++index, arg);
    else if (arg === "--out") options.outDir = requiredValue(rest, ++index, arg);
    else if (arg === "--model") options.model = requiredValue(rest, ++index, arg);
    else if (arg === "--thinking") options.thinkingLevel = parseThinkingLevel(requiredValue(rest, ++index, arg), arg);
    else if (arg === "--max-fix-passes") {
      options.maxFixPasses = parsePositiveInteger(requiredValue(rest, ++index, arg), arg);
      maxFixPassesProvided = true;
    } else if (arg === "--fix-pass") {
      options.fixPass = parsePositiveInteger(requiredValue(rest, ++index, arg), arg);
      fixPassProvided = true;
    } else if (arg === "--force") options.force = true;
    else if (arg === "--yes") options.yes = true;
    else throw new Error(`Unknown option '${arg}'.\n\n${usage}`);
  }

  if (maxFixPassesProvided && command !== "do") {
    throw new Error("--max-fix-passes is only valid with the do command.");
  }
  if (fixPassProvided && command !== "fix" && command !== "final-review") {
    throw new Error("--fix-pass is only valid with fix or final-review.");
  }

  return options;
}

function requiredValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}.`);
  return value;
}

function parsePositiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${flag} must be a positive integer.`);
  return parsed;
}

function parseThinkingLevel(value: string, flag: string): ThinkingLevel {
  if ((thinkingLevels as readonly string[]).includes(value)) return value as ThinkingLevel;
  throw new Error(`${flag} must be one of: ${thinkingLevels.join(", ")}. Got '${value}'.`);
}

function parseCommaSeparatedLabels(value: string): string[] {
  return value
    .split(",")
    .map((label) => label.trim())
    .filter(Boolean);
}
