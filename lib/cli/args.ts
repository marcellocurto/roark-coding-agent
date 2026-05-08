import { defaultAutorunFailureLabel } from "../autorun/failure.ts";
import { defaultAutorunRemote, defaultAutorunSuccessLabel } from "../autorun/publish.ts";
import {
  defaultAutorunInProgressLabel,
  defaultAutorunReadyLabel,
  defaultAutorunSkipLabels,
} from "../autorun/selection.ts";
import { defaultAutorunBaseBranch } from "../autorun/branch.ts";

export type IssueWorkflowCommand =
  | "do"
  | "fetch"
  | "triage"
  | "plan"
  | "implement"
  | "review"
  | "fix"
  | "final-review"
  | "readiness"
  | "curate-issues"
  | "create-issues";

export type ContinueCommand = "continue";
export type StatusCommand = "status";
export type InitCommand = "init";

export type WorkflowCommand = IssueWorkflowCommand | "auto" | "revise-pr" | ContinueCommand | StatusCommand | InitCommand;

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
  attempt?: number;
};

export type AutoCliOptions = {
  command: "auto";
  issue?: string;
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
  verifyCommand: string;
  failureLabel: string;
  successLabel: string;
  remote: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  maxFixPasses: number;
  force: boolean;
  yes: boolean;
};

export type ContinueCliOptions = {
  command: "continue";
  issue: string;
  cwd: string;
  outDir: string;
  repo?: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  force: boolean;
  yes: boolean;
  maxFixPasses: number;
  attempt?: number;
  verifyCommand: string;
  failureLabel: string;
  successLabel: string;
  inProgressLabel: string;
  remote: string;
};

export type RevisePrCliOptions = {
  command: "revise-pr";
  prNumber: number;
  cwd: string;
  outDir: string;
  repo?: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  verifyCommand: string;
  remote: string;
  maxFixPasses: number;
  force: boolean;
  yes: boolean;
  comment: boolean;
};

export type StatusCliOptions = {
  command: "status";
  issue?: string;
  all: boolean;
  cwd: string;
  outDir: string;
  repo?: string;
  attempt?: number;
  maxFixPasses?: never;
  yes?: never;
};

export type InitCliOptions = {
  command: "init";
  cwd: string;
  repo?: string;
  force: boolean;
  maxFixPasses?: never;
  yes?: never;
};

export type CliOptions = IssueCliOptions | AutoCliOptions | RevisePrCliOptions | ContinueCliOptions | StatusCliOptions | InitCliOptions;

export type RawIssueCliOptions = {
  command: IssueWorkflowCommand;
  issue: string;
  cwd?: string;
  outDir?: string;
  repo?: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  force?: true;
  yes?: true;
  maxFixPasses?: number;
  fixPass?: number;
  attempt?: number;
};

export type RawAutoCliOptions = {
  command: "auto";
  issue?: string;
  cwd?: string;
  repo?: string;
  readyLabel?: string;
  skipLabels?: string[];
  limit?: number;
  inProgressLabel?: string;
  assignee?: string;
  noAssign?: true;
  dryRun?: true;
  baseBranch?: string;
  verifyCommand?: string;
  failureLabel?: string;
  successLabel?: string;
  remote?: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  maxFixPasses?: number;
  force?: true;
  yes?: true;
};

export type RawContinueCliOptions = {
  command: "continue";
  issue: string;
  cwd?: string;
  outDir?: string;
  repo?: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  force?: true;
  yes?: true;
  maxFixPasses?: number;
  attempt?: number;
  verifyCommand?: string;
  failureLabel?: string;
  successLabel?: string;
  inProgressLabel?: string;
  remote?: string;
};

export type RawRevisePrCliOptions = {
  command: "revise-pr";
  prNumber: number;
  cwd?: string;
  outDir?: string;
  repo?: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  verifyCommand?: string;
  remote?: string;
  maxFixPasses?: number;
  force?: true;
  yes?: true;
  comment?: false;
};

export type RawStatusCliOptions = {
  command: "status";
  issue?: string;
  all?: true;
  cwd?: string;
  outDir?: string;
  repo?: string;
  attempt?: number;
};

export type RawInitCliOptions = {
  command: "init";
  cwd?: string;
  repo?: string;
  force?: true;
};

export type RawCliOptions =
  | RawIssueCliOptions
  | RawAutoCliOptions
  | RawRevisePrCliOptions
  | RawContinueCliOptions
  | RawStatusCliOptions
  | RawInitCliOptions;

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
  "curate-issues",
  "create-issues",
]);

const commands = new Set<WorkflowCommand>([...issueCommands, "auto", "revise-pr", "continue", "status", "init"]);

export const defaultMaxFixPasses = 3;

export const usage = `roark <command> [issue] [options]

Commands:
  init                  Scaffold repo-local .roark configuration and workflow policy.
  auto [issue]          Find and claim eligible GitHub issues, or target one issue, switch branches, and run the full workflow.
  revise-pr <number>     Manually revise an existing open PR from PR feedback.
  continue <issue>       Continue a prior autorun attempt and publish if gates pass.
  status [issue]         Print persisted run observability status; use --all for all known issues.
  do <issue>             Run the full issue workflow.
  fetch <issue>          Fetch the GitHub issue into .roark/runs/issue/<number>/.
  triage <issue>         Run only the triage agent.
  plan <issue>           Run only the implementation planning agent.
  implement <issue>      Run only the implementation agent.
  review <issue>         Run both review agents.
  fix <issue>            Run only the fix agent.
  final-review <issue>   Run only the final review agent.
  readiness <issue>      Write deterministic PR readiness markdown.
  curate-issues <issue>  Write a deterministic issue creation plan from reviewer findings.
  create-issues <issue>  Create approved GitHub issues from the issue curation plan; dry-run unless --yes.

Issue can be a number, a GitHub issue URL, or owner/repo#123.
Auto without an issue discovers eligible issues; auto with an issue targets that issue directly.

Options:
  --repo <owner/repo>    Repository for gh issue commands.
  --cwd <path>           Repository working directory. Defaults to current directory.
  --out <path>           Runs directory. Defaults to .roark/runs.
  --model <provider/id>  Optional Pi model override, e.g. anthropic/claude-sonnet-4-5.
  --thinking <level>     Override thinking level for agent-backed phases (off|minimal|low|medium|high|xhigh).
  --max-fix-passes <n>   Maximum automatic fix/review cycles for auto/do/continue. Defaults to ${defaultMaxFixPasses}.
  --fix-pass <n>         Pass number for standalone fix/final-review.
  --attempt <n>          Issue/continue/status commands only: use a specific autorun attempt directory.
  --all                  Status command only: summarize all known issue runs.
  --label <label>        Auto eligibility label. Defaults to ${defaultAutorunReadyLabel}.
  --skip-label <label>   Auto skip label. Can be passed multiple times; lifecycle labels are still appended.
  --skip-labels <labels> Auto skip labels as a comma-separated list; lifecycle labels are still appended.
  --limit <n>            Maximum number of eligible auto issues to claim. Defaults to 1.
  --in-progress-label <label>
                          Auto claim label, and the label removed on terminal continue success/failure. Defaults to ${defaultAutorunInProgressLabel}.
  --assignee <login>     GitHub user to assign when claiming. Defaults to the authenticated gh user.
  --no-assign            Claim without assigning a user.
  --dry-run              Print selected issues without claiming them or switching branches.
  --base-branch <branch> Auto issue branch base branch. Defaults to ${defaultAutorunBaseBranch}.
  --verify <cmd>         Verification command to run before publishing. Runs via 'sh -c'. Inferred for auto/continue when omitted.
  --failure-label <label>
                          Label applied to the issue when readiness or verification fails. Defaults to ${defaultAutorunFailureLabel}.
  --success-label <label>
                          Label applied to the issue when a draft PR is opened. Defaults to ${defaultAutorunSuccessLabel}.
  --remote <name>        Git remote to push the issue/PR branch to. Defaults to ${defaultAutorunRemote}.
  --no-comment           revise-pr only: do not post the terminal PR summary comment.
  --force                Re-run phases even if their markdown artifact already exists.
  --yes                  Continue past dirty git preflight for implementation/fix/revise-pr; approve create-issues mutations.
  -h, --help             Show this help.
`;

export function parseArgs(argv: string[]): RawCliOptions | { help: true } {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) return { help: true };

  const [rawCommand, ...rest] = argv;
  if (!rawCommand || !commands.has(rawCommand as WorkflowCommand)) {
    throw new Error(`Unknown command '${rawCommand ?? ""}'.\n\n${usage}`);
  }

  if (rawCommand === "init") return parseInitArgs(rest);
  if (rawCommand === "auto") return parseAutoArgs(rest);
  if (rawCommand === "revise-pr") return parseRevisePrArgs(rest);
  if (rawCommand === "continue") return parseContinueArgs(rest);
  if (rawCommand === "status") return parseStatusArgs(rest);
  return parseIssueArgs(rawCommand as IssueWorkflowCommand, rest);
}

function parseInitArgs(args: string[]): RawInitCliOptions {
  const options: RawInitCliOptions = { command: "init" };

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--repo") options.repo = requiredValue(args, ++index, arg);
    else if (arg === "--cwd") options.cwd = requiredValue(args, ++index, arg);
    else if (arg === "--force") options.force = true;
    else if (arg?.startsWith("--")) throw new Error(`Unknown option '${arg}'.\n\n${usage}`);
    else throw new Error(`Unexpected argument '${arg}'.\n\n${usage}`);
  }

  return options;
}

function parseAutoArgs(args: string[]): RawAutoCliOptions {
  const options: RawAutoCliOptions = { command: "auto" };

  let skipLabelsProvided = false;
  let issueArg: string | undefined;

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
      options.skipLabels?.push(requiredValue(args, ++index, arg));
    } else if (arg === "--skip-labels") {
      if (!skipLabelsProvided) {
        options.skipLabels = [];
        skipLabelsProvided = true;
      }
      options.skipLabels?.push(...parseCommaSeparatedLabels(requiredValue(args, ++index, arg)));
    } else if (arg === "--limit") options.limit = parsePositiveInteger(requiredValue(args, ++index, arg), arg);
    else if (arg === "--in-progress-label") options.inProgressLabel = requiredValue(args, ++index, arg);
    else if (arg === "--assignee") options.assignee = requiredValue(args, ++index, arg);
    else if (arg === "--no-assign") options.noAssign = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--base-branch") options.baseBranch = requiredValue(args, ++index, arg);
    else if (arg === "--verify") options.verifyCommand = requiredValue(args, ++index, arg);
    else if (arg === "--failure-label") options.failureLabel = requiredValue(args, ++index, arg);
    else if (arg === "--success-label") options.successLabel = requiredValue(args, ++index, arg);
    else if (arg === "--remote") options.remote = requiredValue(args, ++index, arg);
    else if (arg === "--model") options.model = requiredValue(args, ++index, arg);
    else if (arg === "--thinking") options.thinkingLevel = parseThinkingLevel(requiredValue(args, ++index, arg), arg);
    else if (arg === "--max-fix-passes") options.maxFixPasses = parsePositiveInteger(requiredValue(args, ++index, arg), arg);
    else if (arg === "--force") options.force = true;
    else if (arg === "--yes") options.yes = true;
    else if (arg?.startsWith("--")) throw new Error(`Unknown option '${arg}'.\n\n${usage}`);
    else if (issueArg) throw new Error(`The auto command accepts at most one issue argument. Got '${issueArg}' and '${arg}'.\n\n${usage}`);
    else issueArg = arg;
  }

  options.issue = issueArg;

  if (options.noAssign && options.assignee) {
    throw new Error("--assignee cannot be combined with --no-assign.");
  }

  return options;
}

function parseRevisePrArgs(args: string[]): RawRevisePrCliOptions {
  const [rawPrNumber, ...rest] = args;
  if (!rawPrNumber) throw new Error(`Missing PR number.\n\n${usage}`);
  if (rawPrNumber.startsWith("--")) throw new Error(`Missing PR number.\n\n${usage}`);

  const prNumber = parsePositiveInteger(rawPrNumber.replace(/^#/, ""), "PR number");
  const options: RawRevisePrCliOptions = { command: "revise-pr", prNumber };

  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index];
    if (arg === "--repo") options.repo = requiredValue(rest, ++index, arg);
    else if (arg === "--cwd") options.cwd = requiredValue(rest, ++index, arg);
    else if (arg === "--out") options.outDir = requiredValue(rest, ++index, arg);
    else if (arg === "--model") options.model = requiredValue(rest, ++index, arg);
    else if (arg === "--thinking") options.thinkingLevel = parseThinkingLevel(requiredValue(rest, ++index, arg), arg);
    else if (arg === "--verify") options.verifyCommand = requiredValue(rest, ++index, arg);
    else if (arg === "--remote") options.remote = requiredValue(rest, ++index, arg);
    else if (arg === "--max-fix-passes") options.maxFixPasses = parsePositiveInteger(requiredValue(rest, ++index, arg), arg);
    else if (arg === "--force") options.force = true;
    else if (arg === "--yes") options.yes = true;
    else if (arg === "--no-comment") options.comment = false;
    else if (arg?.startsWith("--")) throw new Error(`Unknown option '${arg}'.\n\n${usage}`);
    else throw new Error(`Unexpected argument '${arg}'.\n\n${usage}`);
  }

  return options;
}

function parseStatusArgs(args: string[]): RawStatusCliOptions {
  const options: RawStatusCliOptions = { command: "status" };

  let issueArg: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--all") options.all = true;
    else if (arg === "--repo") options.repo = requiredValue(args, ++index, arg);
    else if (arg === "--cwd") options.cwd = requiredValue(args, ++index, arg);
    else if (arg === "--out") options.outDir = requiredValue(args, ++index, arg);
    else if (arg === "--attempt") options.attempt = parsePositiveInteger(requiredValue(args, ++index, arg), arg);
    else if (arg?.startsWith("--")) throw new Error(`Unknown option '${arg}'.\n\n${usage}`);
    else if (issueArg) throw new Error(`The status command accepts at most one issue argument. Got '${issueArg}' and '${arg}'.\n\n${usage}`);
    else issueArg = arg;
  }

  if (options.all && issueArg) throw new Error("status --all cannot be combined with an issue argument.");
  if (options.all && options.attempt !== undefined) throw new Error("status --all cannot be combined with --attempt.");
  if (!options.all && !issueArg) throw new Error(`Missing issue. Use status --all to summarize all known runs.\n\n${usage}`);
  options.issue = issueArg;
  return options;
}

function parseContinueArgs(args: string[]): RawContinueCliOptions {
  const [rawIssue, ...rest] = args;
  if (!rawIssue) throw new Error(`Missing issue.\n\n${usage}`);
  if (rawIssue.startsWith("--")) throw new Error(`Missing issue.\n\n${usage}`);

  const options: RawContinueCliOptions = { command: "continue", issue: rawIssue };

  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index];
    if (arg === "--repo") options.repo = requiredValue(rest, ++index, arg);
    else if (arg === "--cwd") options.cwd = requiredValue(rest, ++index, arg);
    else if (arg === "--out") options.outDir = requiredValue(rest, ++index, arg);
    else if (arg === "--model") options.model = requiredValue(rest, ++index, arg);
    else if (arg === "--thinking") options.thinkingLevel = parseThinkingLevel(requiredValue(rest, ++index, arg), arg);
    else if (arg === "--max-fix-passes") options.maxFixPasses = parsePositiveInteger(requiredValue(rest, ++index, arg), arg);
    else if (arg === "--attempt") options.attempt = parsePositiveInteger(requiredValue(rest, ++index, arg), arg);
    else if (arg === "--verify") options.verifyCommand = requiredValue(rest, ++index, arg);
    else if (arg === "--failure-label") options.failureLabel = requiredValue(rest, ++index, arg);
    else if (arg === "--success-label") options.successLabel = requiredValue(rest, ++index, arg);
    else if (arg === "--in-progress-label") options.inProgressLabel = requiredValue(rest, ++index, arg);
    else if (arg === "--remote") options.remote = requiredValue(rest, ++index, arg);
    else if (arg === "--force") options.force = true;
    else if (arg === "--yes") options.yes = true;
    else if (arg?.startsWith("--")) throw new Error(`Unknown option '${arg}'.\n\n${usage}`);
    else throw new Error(`Unexpected argument '${arg}'.\n\n${usage}`);
  }

  return options;
}

function parseIssueArgs(command: IssueWorkflowCommand, args: string[]): RawIssueCliOptions {
  const [rawIssue, ...rest] = args;
  if (!rawIssue) throw new Error(`Missing issue.\n\n${usage}`);
  if (rawIssue.startsWith("--")) throw new Error(`Missing issue.\n\n${usage}`);

  const options: RawIssueCliOptions = { command, issue: rawIssue };

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
    } else if (arg === "--attempt") options.attempt = parsePositiveInteger(requiredValue(rest, ++index, arg), arg);
    else if (arg === "--force") options.force = true;
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
