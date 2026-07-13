import { defaultAutorunFailureLabel } from "../autorun/failure.ts";
import { defaultAutorunRemote, defaultAutorunSuccessLabel } from "../autorun/publish.ts";
import {
  defaultAutorunInProgressLabel,
  defaultAutorunReadyLabel,
} from "../autorun/selection.ts";
import { defaultAutorunBaseBranch } from "../autorun/branch.ts";
import type { LifecycleHooksConfig, RemoveCommandOptions, WorkspaceCommandOptions, WorkspaceConfig, WorkspaceRemoveTarget } from "../autorun/workspace.ts";
import type { ThinkingProfileName } from "../workflow/thinking.ts";
import { singlePhaseCommands, type SinglePhaseCommand } from "../workflow/phase-vocabulary.ts";

export type IssueWorkflowCommand = "do" | SinglePhaseCommand;

export type ContinueCommand = "continue";
export type StatusCommand = "status";
export type InitCommand = "init";
export type WorkspaceCommand = "workspace";
export type RemoveCommand = "remove";

export type WorkflowCommand = IssueWorkflowCommand | "auto" | "review-pr" | "revise-pr" | ContinueCommand | StatusCommand | InitCommand | WorkspaceCommand | RemoveCommand;

export const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof thinkingLevels)[number];

export interface IssueCliOptions {
  command: IssueWorkflowCommand;
  issue: string;
  cwd: string;
  outDir: string;
  repo?: string | undefined  ;
  model?: string | undefined  ;
  thinkingLevel?: ThinkingLevel | undefined  ;
  thinkingProfile?: ThinkingProfileName | undefined  ;
  force: boolean;
  yes: boolean;
  maxFixPasses: number;
  fixPass?: number | undefined;
  attempt?: number | undefined;
}

export interface AutoCliOptions {
  command: "auto";
  issue?: string | undefined;
  cwd: string;
  repo?: string | undefined  ;
  readyLabel: string;
  skipLabels: string[];
  limit: number;
  inProgressLabel: string;
  assignee?: string | undefined  ;
  noAssign: boolean;
  dryRun: boolean;
  baseBranch: string;
  verifyCommand: string;
  failureLabel: string;
  successLabel: string;
  remote: string;
  model?: string | undefined  ;
  thinkingLevel?: ThinkingLevel | undefined  ;
  thinkingProfile?: ThinkingProfileName | undefined  ;
  maxFixPasses: number;
  force: boolean;
  yes: boolean;
  workspace?: WorkspaceConfig | undefined  ;
  hooks?: LifecycleHooksConfig | undefined  ;
}

export interface ContinueCliOptions {
  command: "continue";
  issue: string;
  cwd: string;
  outDir: string;
  repo?: string | undefined  ;
  model?: string | undefined  ;
  thinkingLevel?: ThinkingLevel | undefined  ;
  thinkingProfile?: ThinkingProfileName | undefined  ;
  force: boolean;
  yes: boolean;
  maxFixPasses: number;
  attempt?: number | undefined;
  verifyCommand: string;
  failureLabel: string;
  successLabel: string;
  inProgressLabel: string;
  remote: string;
  workspace?: WorkspaceConfig | undefined  ;
  hooks?: LifecycleHooksConfig | undefined  ;
}

export interface RevisePrCliOptions {
  command: "revise-pr";
  prNumber: number;
  cwd: string;
  outDir: string;
  repo?: string | undefined  ;
  model?: string | undefined  ;
  thinkingLevel?: ThinkingLevel | undefined  ;
  thinkingProfile?: ThinkingProfileName | undefined  ;
  verifyCommand: string;
  remote: string;
  maxFixPasses: number;
  force: boolean;
  yes: boolean;
  comment: boolean;
  workspace?: WorkspaceConfig | undefined;
  hooks?: LifecycleHooksConfig | undefined;
}

export interface ReviewPrCliOptions {
  command: "review-pr";
  prNumber: number;
  cwd: string;
  outDir: string;
  repo?: string | undefined;
  model?: string | undefined;
  thinkingLevel?: ThinkingLevel | undefined;
  thinkingProfile?: ThinkingProfileName | undefined;
  verifyCommand?: string | undefined;
  verificationSource: "explicit" | "unresolved";
  comment: boolean;
  workspace?: WorkspaceConfig | undefined;
}

export interface StatusCliOptions {
  command: "status";
  issue?: string | undefined;
  all: boolean;
  cwd: string;
  outDir: string;
  repo?: string | undefined  ;
  attempt?: number | undefined;
  maxFixPasses?: never;
  yes?: never;
}

export interface InitCliOptions {
  command: "init";
  cwd: string;
  repo?: string | undefined  ;
  force: boolean;
  maxFixPasses?: never;
  yes?: never;
}

export type CliOptions = IssueCliOptions | AutoCliOptions | ReviewPrCliOptions | RevisePrCliOptions | ContinueCliOptions | StatusCliOptions | InitCliOptions | WorkspaceCommandOptions | RemoveCommandOptions;

export interface RawIssueCliOptions {
  command: IssueWorkflowCommand;
  issue: string;
  cwd?: string | undefined  ;
  outDir?: string | undefined;
  repo?: string | undefined  ;
  model?: string | undefined  ;
  thinkingLevel?: ThinkingLevel | undefined  ;
  thinkingProfile?: ThinkingProfileName | undefined  ;
  force?: true | undefined;
  yes?: true | undefined;
  maxFixPasses?: number | undefined;
  fixPass?: number | undefined;
  attempt?: number | undefined;
}

export interface RawAutoCliOptions {
  command: "auto";
  issue?: string | undefined;
  cwd?: string | undefined  ;
  repo?: string | undefined  ;
  readyLabel?: string | undefined;
  skipLabels?: string[] | undefined;
  limit?: number | undefined;
  inProgressLabel?: string | undefined;
  assignee?: string | undefined  ;
  noAssign?: true | undefined;
  dryRun?: true | undefined;
  baseBranch?: string | undefined;
  verifyCommand?: string | undefined;
  failureLabel?: string | undefined;
  successLabel?: string | undefined;
  remote?: string | undefined;
  model?: string | undefined  ;
  thinkingLevel?: ThinkingLevel | undefined  ;
  thinkingProfile?: ThinkingProfileName | undefined  ;
  maxFixPasses?: number | undefined;
  force?: true | undefined;
  yes?: true | undefined;
}

export interface RawContinueCliOptions {
  command: "continue";
  issue: string;
  cwd?: string | undefined  ;
  outDir?: string | undefined;
  repo?: string | undefined  ;
  model?: string | undefined  ;
  thinkingLevel?: ThinkingLevel | undefined  ;
  thinkingProfile?: ThinkingProfileName | undefined  ;
  force?: true | undefined;
  yes?: true | undefined;
  maxFixPasses?: number | undefined;
  attempt?: number | undefined;
  verifyCommand?: string | undefined;
  failureLabel?: string | undefined;
  successLabel?: string | undefined;
  inProgressLabel?: string | undefined;
  remote?: string | undefined;
}

export interface RawRevisePrCliOptions {
  command: "revise-pr";
  prNumber: number;
  cwd?: string | undefined  ;
  outDir?: string | undefined;
  repo?: string | undefined  ;
  model?: string | undefined  ;
  thinkingLevel?: ThinkingLevel | undefined  ;
  thinkingProfile?: ThinkingProfileName | undefined  ;
  verifyCommand?: string | undefined;
  remote?: string | undefined;
  maxFixPasses?: number | undefined;
  force?: true | undefined;
  yes?: true | undefined;
  comment?: false | undefined;
}

export interface RawReviewPrCliOptions {
  command: "review-pr";
  prNumber: number;
  cwd?: string | undefined;
  outDir?: string | undefined;
  repo?: string | undefined;
  model?: string | undefined;
  thinkingLevel?: ThinkingLevel | undefined;
  thinkingProfile?: ThinkingProfileName | undefined;
  verifyCommand?: string | undefined;
  comment?: false | undefined;
}

export interface RawStatusCliOptions {
  command: "status";
  issue?: string | undefined;
  all?: true | undefined;
  cwd?: string | undefined  ;
  outDir?: string | undefined;
  repo?: string | undefined  ;
  attempt?: number | undefined;
}

export interface RawInitCliOptions {
  command: "init";
  cwd?: string | undefined  ;
  repo?: string | undefined  ;
  force?: true | undefined;
}

export type RawWorkspaceCliOptions =
  | { command: "workspace"; action: "list"; cwd?: string | undefined; repo?: string  | undefined}
  | { command: "workspace"; action: "prune"; olderThan: string; cwd?: string | undefined; repo?: string | undefined; force?: true | undefined };

export interface RawRemoveCliOptions {
  command: "remove";
  targets: WorkspaceRemoveTarget[];
  cwd?: string | undefined;
  repo?: string | undefined;
  force?: true | undefined;
}

export type RawCliOptions =
  | RawIssueCliOptions
  | RawAutoCliOptions
  | RawReviewPrCliOptions
  | RawRevisePrCliOptions
  | RawContinueCliOptions
  | RawStatusCliOptions
  | RawInitCliOptions
  | RawRemoveCliOptions
  | RawWorkspaceCliOptions;

const issueCommands = new Set<IssueWorkflowCommand>([
  "do",
  ...singlePhaseCommands,
]);

const commands = new Set<WorkflowCommand>([...issueCommands, "auto", "review-pr", "revise-pr", "continue", "status", "init", "remove", "workspace"]);

export const defaultMaxFixPasses = 3;

const thinkingProfileFlags = {
  "--fast": "fast",
  "--deep": "deep",
} as const satisfies Record<string, ThinkingProfileName>;

export const usage = `roark <command> [issue] [options]

Commands:
  init                  Initialize Roark in the current repository.
  auto [issue]          Work on the next ready issue, or a specific issue, in a managed workspace and publish after all gates pass.
  review-pr <number>     Review an existing PR without changing code and post actionable feedback.
  revise-pr <number>     Address required PR review feedback and push verified fixes when needed.
  continue <issue>       Resume a stopped issue workflow and publish after all gates pass.
  status [issue]         View workflow status and recovery information; use --all for every known issue run.
  remove [issue ...] [--pr <n>] [--force]
                        Select and remove managed workspaces. With no targets, opens an interactive multi-select.
  workspace list         View managed workspaces.
  workspace prune --older-than <duration> [--force]
                        Remove old clean workspaces, e.g. --older-than 30d.
  do <issue>             Run the complete issue workflow in the current checkout without publishing.
  fetch <issue>          Fetch the GitHub issue into .roark/runs/issue/<number>/.
  triage <issue>         Run only the triage agent.
  plan-draft <issue>     Run only the draft planning agent.
  plan <issue>           Refine the draft plan into the final implementation plan.
  capture-baseline <issue>
                        Capture the pre-implementation baseline.
  implement <issue>      Run only the implementation agent.
  refine-code <issue>    Run only the code refinement agent.
  review <issue>         Run both review agents for the latest refinement cycle.
  fix <issue>            Run only the fix agent.
  reset-baseline <issue> Reset non-.roark worktree state to the captured baseline.
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
  --thinking <level>     Override thinking level for agent-backed phases (off|minimal|low|medium|high|xhigh|max).
  --fast                 Use the fast workflow thinking profile (cannot combine with --thinking or --deep).
  --deep                 Use the deep workflow thinking profile (cannot combine with --thinking or --fast).
  --max-fix-passes <n>   Maximum automatic fix/review cycles for auto/do/continue. Defaults to ${defaultMaxFixPasses}.
  --fix-pass <n>         Pass number for a standalone fix.
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
                          Label applied to the issue when a PR is opened. Defaults to ${defaultAutorunSuccessLabel}.
  --remote <name>        Git remote to push the issue/PR branch to. Defaults to ${defaultAutorunRemote}.
  --no-comment           review-pr/revise-pr: do not post the terminal PR comment.
  --force                Re-run phases, or remove managed workspaces that have uncommitted changes.
  --yes                  Continue past dirty git preflight for implementation/fix/revise-pr; approve create-issues mutations.
  -v, --version          Top-level only: print the installed Roark version.
  -h, --help             Show this help.
`;

export function parseArgs(argv: string[]): RawCliOptions | { help: true } {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) return { help: true };

  const [rawCommand, ...rest] = argv;
  if (!rawCommand || !commands.has(rawCommand as WorkflowCommand)) {
    throw new Error(`Unknown command '${rawCommand ?? ""}'.\n\n${usage}`);
  }

  if (rawCommand === "init") return parseInitArgs(rest);
  if (rawCommand === "remove") return parseRemoveArgs(rest);
  if (rawCommand === "workspace") return parseWorkspaceArgs(rest);
  if (rawCommand === "auto") return parseAutoArgs(rest);
  if (rawCommand === "review-pr") return parseReviewPrArgs(rest);
  if (rawCommand === "revise-pr") return parseRevisePrArgs(rest);
  if (rawCommand === "continue") return parseContinueArgs(rest);
  if (rawCommand === "status") return parseStatusArgs(rest);
  return parseIssueArgs(rawCommand as IssueWorkflowCommand, rest);
}

function parseReviewPrArgs(args: string[]): RawReviewPrCliOptions {
  const [rawPrNumber, ...rest] = args;
  if (rawPrNumber === undefined || rawPrNumber.startsWith("--")) throw new Error(`Missing PR number.\n\n${usage}`);
  const options: RawReviewPrCliOptions = {
    command: "review-pr",
    prNumber: parsePositiveInteger(rawPrNumber.replace(/^#/, ""), "PR number"),
  };
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index];
    if (arg === "--repo") options.repo = requiredValue(rest, ++index, arg);
    else if (arg === "--cwd") options.cwd = requiredValue(rest, ++index, arg);
    else if (arg === "--out") options.outDir = requiredValue(rest, ++index, arg);
    else if (arg === "--model") options.model = requiredValue(rest, ++index, arg);
    else if (arg === "--thinking") options.thinkingLevel = parseThinkingLevel(requiredValue(rest, ++index, arg), arg);
    else if (isThinkingProfileFlag(arg)) applyThinkingProfileFlag(options, arg);
    else if (arg === "--verify") options.verifyCommand = requiredValue(rest, ++index, arg);
    else if (arg === "--no-comment") options.comment = false;
    else if (arg?.startsWith("--") === true) throw new Error(`Unknown option '${formatCliArg(arg)}'.\n\n${usage}`);
    else throw new Error(`Unexpected argument '${formatCliArg(arg)}'.\n\n${usage}`);
  }
  validateThinkingSelection(options);
  return options;
}

function parseInitArgs(args: string[]): RawInitCliOptions {
  const options: RawInitCliOptions = { command: "init" };

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--repo") options.repo = requiredValue(args, ++index, arg);
    else if (arg === "--cwd") options.cwd = requiredValue(args, ++index, arg);
    else if (arg === "--force") options.force = true;
    else if (arg?.startsWith("--") === true) throw new Error(`Unknown option '${formatCliArg(arg)}'.\n\n${usage}`);
    else throw new Error(`Unexpected argument '${formatCliArg(arg)}'.\n\n${usage}`);
  }

  return options;
}

function parseWorkspaceArgs(args: string[]): RawWorkspaceCliOptions {
  const [action, ...rest] = args;
  if (action !== "list" && action !== "prune") {
    throw new Error(`workspace requires one of: list, prune.\n\n${usage}`);
  }

  let cwd: string | undefined;
  let repo: string | undefined;
  let force: true | undefined;
  let olderThan: string | undefined;

  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index];
    if (arg === "--cwd") cwd = requiredValue(rest, ++index, arg);
    else if (arg === "--repo") repo = requiredValue(rest, ++index, arg);
    else if (arg === "--force") force = true;
    else if (arg === "--older-than") olderThan = requiredValue(rest, ++index, arg);
    else if (arg?.startsWith("--") === true) throw new Error(`Unknown option '${formatCliArg(arg)}'.\n\n${usage}`);
    else throw new Error(`Unexpected argument '${formatCliArg(arg)}'.\n\n${usage}`);
  }

  if (action === "list") {
    if (force === true || olderThan !== undefined) throw new Error("workspace list only accepts --cwd and --repo.");
    return { command: "workspace", action, cwd, repo };
  }

  if (olderThan === undefined) throw new Error("workspace prune requires --older-than <duration>.");
  return { command: "workspace", action, olderThan, cwd, repo, force };
}

function parseRemoveArgs(args: string[]): RawRemoveCliOptions {
  let cwd: string | undefined;
  let repo: string | undefined;
  let force: true | undefined;
  const targets: WorkspaceRemoveTarget[] = [];

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--cwd") cwd = requiredValue(args, ++index, arg);
    else if (arg === "--repo") repo = requiredValue(args, ++index, arg);
    else if (arg === "--force") force = true;
    else if (arg === "--pr") targets.push({ kind: "pr", number: parsePositiveInteger(requiredValue(args, ++index, arg), arg) });
    else if (arg?.startsWith("--") === true) throw new Error(`Unknown option '${formatCliArg(arg)}'.\n\n${usage}`);
    else targets.push({ kind: "issue", number: parsePositiveInteger(arg ?? "", "issue number") });
  }

  const uniqueTargets = targets.filter((target, index) =>
    targets.findIndex((candidate) => candidate.kind === target.kind && candidate.number === target.number) === index
  );
  return { command: "remove", targets: uniqueTargets, cwd, repo, force };
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
    else if (isThinkingProfileFlag(arg)) applyThinkingProfileFlag(options, arg);
    else if (arg === "--max-fix-passes") options.maxFixPasses = parsePositiveInteger(requiredValue(args, ++index, arg), arg);
    else if (arg === "--force") options.force = true;
    else if (arg === "--yes") options.yes = true;
    else if (arg?.startsWith("--") === true) throw new Error(`Unknown option '${formatCliArg(arg)}'.\n\n${usage}`);
    else if (issueArg !== undefined) throw new Error(`The auto command accepts at most one issue argument. Got '${issueArg}' and '${formatCliArg(arg)}'.\n\n${usage}`);
    else issueArg = arg;
  }

  options.issue = issueArg;

  if (options.noAssign === true && options.assignee !== undefined) {
    throw new Error("--assignee cannot be combined with --no-assign.");
  }
  validateThinkingSelection(options);

  return options;
}

function parseRevisePrArgs(args: string[]): RawRevisePrCliOptions {
  const [rawPrNumber, ...rest] = args;
  if (rawPrNumber === undefined) throw new Error(`Missing PR number.\n\n${usage}`);
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
    else if (isThinkingProfileFlag(arg)) applyThinkingProfileFlag(options, arg);
    else if (arg === "--verify") options.verifyCommand = requiredValue(rest, ++index, arg);
    else if (arg === "--remote") options.remote = requiredValue(rest, ++index, arg);
    else if (arg === "--max-fix-passes") options.maxFixPasses = parsePositiveInteger(requiredValue(rest, ++index, arg), arg);
    else if (arg === "--force") options.force = true;
    else if (arg === "--yes") options.yes = true;
    else if (arg === "--no-comment") options.comment = false;
    else if (arg?.startsWith("--") === true) throw new Error(`Unknown option '${formatCliArg(arg)}'.\n\n${usage}`);
    else throw new Error(`Unexpected argument '${formatCliArg(arg)}'.\n\n${usage}`);
  }

  validateThinkingSelection(options);
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
    else if (arg?.startsWith("--") === true) throw new Error(`Unknown option '${formatCliArg(arg)}'.\n\n${usage}`);
    else if (issueArg !== undefined) throw new Error(`The status command accepts at most one issue argument. Got '${issueArg}' and '${formatCliArg(arg)}'.\n\n${usage}`);
    else issueArg = arg;
  }

  if (options.all === true && issueArg !== undefined) throw new Error("status --all cannot be combined with an issue argument.");
  if (options.all === true && options.attempt !== undefined) throw new Error("status --all cannot be combined with --attempt.");
  if (options.all !== true && issueArg === undefined) throw new Error(`Missing issue. Use status --all to summarize all known runs.\n\n${usage}`);
  options.issue = issueArg;
  return options;
}

function parseContinueArgs(args: string[]): RawContinueCliOptions {
  const [rawIssue, ...rest] = args;
  if (rawIssue === undefined) throw new Error(`Missing issue.\n\n${usage}`);
  if (rawIssue.startsWith("--")) throw new Error(`Missing issue.\n\n${usage}`);

  const options: RawContinueCliOptions = { command: "continue", issue: rawIssue };

  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index];
    if (arg === "--repo") options.repo = requiredValue(rest, ++index, arg);
    else if (arg === "--cwd") options.cwd = requiredValue(rest, ++index, arg);
    else if (arg === "--out") options.outDir = requiredValue(rest, ++index, arg);
    else if (arg === "--model") options.model = requiredValue(rest, ++index, arg);
    else if (arg === "--thinking") options.thinkingLevel = parseThinkingLevel(requiredValue(rest, ++index, arg), arg);
    else if (isThinkingProfileFlag(arg)) applyThinkingProfileFlag(options, arg);
    else if (arg === "--max-fix-passes") options.maxFixPasses = parsePositiveInteger(requiredValue(rest, ++index, arg), arg);
    else if (arg === "--attempt") options.attempt = parsePositiveInteger(requiredValue(rest, ++index, arg), arg);
    else if (arg === "--verify") options.verifyCommand = requiredValue(rest, ++index, arg);
    else if (arg === "--failure-label") options.failureLabel = requiredValue(rest, ++index, arg);
    else if (arg === "--success-label") options.successLabel = requiredValue(rest, ++index, arg);
    else if (arg === "--in-progress-label") options.inProgressLabel = requiredValue(rest, ++index, arg);
    else if (arg === "--remote") options.remote = requiredValue(rest, ++index, arg);
    else if (arg === "--force") options.force = true;
    else if (arg === "--yes") options.yes = true;
    else if (arg?.startsWith("--") === true) throw new Error(`Unknown option '${formatCliArg(arg)}'.\n\n${usage}`);
    else throw new Error(`Unexpected argument '${formatCliArg(arg)}'.\n\n${usage}`);
  }

  validateThinkingSelection(options);
  return options;
}

function parseIssueArgs(command: IssueWorkflowCommand, args: string[]): RawIssueCliOptions {
  const [rawIssue, ...rest] = args;
  if (rawIssue === undefined) throw new Error(`Missing issue.\n\n${usage}`);
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
    else if (isThinkingProfileFlag(arg)) applyThinkingProfileFlag(options, arg);
    else if (arg === "--max-fix-passes") {
      options.maxFixPasses = parsePositiveInteger(requiredValue(rest, ++index, arg), arg);
      maxFixPassesProvided = true;
    } else if (arg === "--fix-pass") {
      options.fixPass = parsePositiveInteger(requiredValue(rest, ++index, arg), arg);
      fixPassProvided = true;
    } else if (arg === "--attempt") options.attempt = parsePositiveInteger(requiredValue(rest, ++index, arg), arg);
    else if (arg === "--force") options.force = true;
    else if (arg === "--yes") options.yes = true;
    else throw new Error(`Unknown option '${formatCliArg(arg)}'.\n\n${usage}`);
  }

  if (maxFixPassesProvided && command !== "do") {
    throw new Error("--max-fix-passes is only valid with the do command.");
  }
  if (fixPassProvided && command !== "fix") {
    throw new Error("--fix-pass is only valid with fix.");
  }
  validateThinkingSelection(options);

  return options;
}

function isThinkingProfileFlag(arg: string | undefined): arg is keyof typeof thinkingProfileFlags {
  return arg !== undefined && Object.hasOwn(thinkingProfileFlags, arg);
}

function applyThinkingProfileFlag(options: { thinkingProfile?: ThinkingProfileName  | undefined}, flag: keyof typeof thinkingProfileFlags): void {
  const profile = thinkingProfileFlags[flag];
  if (options.thinkingProfile && options.thinkingProfile !== profile) {
    throw new Error("--fast cannot be combined with --deep.");
  }
  options.thinkingProfile = profile;
}

function validateThinkingSelection(options: { thinkingLevel?: ThinkingLevel | undefined; thinkingProfile?: ThinkingProfileName  | undefined}): void {
  if (options.thinkingLevel && options.thinkingProfile) {
    throw new Error("--thinking cannot be combined with --fast or --deep.");
  }
}

function requiredValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}.`);
  return value;
}

function formatCliArg(arg: string | undefined): string {
  return arg ?? "";
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
