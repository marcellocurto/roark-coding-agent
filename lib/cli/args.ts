export type WorkflowCommand =
  | "do"
  | "fetch"
  | "triage"
  | "plan"
  | "implement"
  | "review"
  | "fix"
  | "final-review"
  | "readiness";

export type CliOptions = {
  command: WorkflowCommand;
  issue: string;
  cwd: string;
  outDir: string;
  repo?: string;
  model?: string;
  force: boolean;
  yes: boolean;
  maxFixPasses: number;
  fixPass?: number;
};

const commands = new Set<WorkflowCommand>([
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

export const usage = `roark-coding-agent <command> <issue> [options]

Commands:
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

Options:
  --repo <owner/repo>    Repository for gh issue view when issue is just a number.
  --cwd <path>           Repository working directory. Defaults to current directory.
  --out <path>           Runs directory. Defaults to .roark/runs.
  --model <provider/id>  Optional Pi model override, e.g. anthropic/claude-sonnet-4-5.
  --max-fix-passes <n>   Maximum automatic fix/review cycles for do. Defaults to 1.
  --fix-pass <n>         Pass number for standalone fix/final-review.
  --force                Re-run phases even if their markdown artifact already exists.
  --yes                  Continue past dirty git preflight for implementation/fix.
  -h, --help             Show this help.
`;

export function parseArgs(argv: string[]): CliOptions | { help: true } {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) return { help: true };

  const [rawCommand, rawIssue, ...rest] = argv;
  if (!rawCommand || !commands.has(rawCommand as WorkflowCommand)) {
    throw new Error(`Unknown command '${rawCommand ?? ""}'.\n\n${usage}`);
  }
  if (!rawIssue) throw new Error(`Missing issue.\n\n${usage}`);

  const command = rawCommand as WorkflowCommand;
  const options: CliOptions = {
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
    else if (arg === "--max-fix-passes") {
      options.maxFixPasses = parsePositiveInteger(requiredValue(rest, ++index, arg), arg);
      maxFixPassesProvided = true;
    } else if (arg === "--fix-pass") {
      options.fixPass = parsePositiveInteger(requiredValue(rest, ++index, arg), arg);
      fixPassProvided = true;
    }
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
