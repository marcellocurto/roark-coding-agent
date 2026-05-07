import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { defaultAutorunFailureLabel } from "../autorun/failure.ts";
import { defaultAutorunBaseBranch } from "../autorun/branch.ts";
import { defaultAutorunRemote, defaultAutorunSuccessLabel } from "../autorun/publish.ts";
import {
  defaultAutorunInProgressLabel,
  defaultAutorunReadyLabel,
  defaultAutorunSkipLabels,
} from "../autorun/selection.ts";
import { defaultAutorunVerifyCommand } from "../autorun/verification.ts";
import {
  defaultMaxFixPasses,
  type AutoCliOptions,
  type CliOptions,
  type ContinueCliOptions,
  type RawCliOptions,
  type RevisePrCliOptions,
  type StatusCliOptions,
} from "./args.ts";
import { runProcess, type ProcessResult } from "./process.ts";

export type RoarkConfig = {
  repo?: string;
  baseBranch?: string;
  verify?: string;
  readyLabel?: string;
  inProgressLabel?: string;
  successLabel?: string;
  failureLabel?: string;
  skipLabels?: string[];
  maxFixPasses?: number;
};

type ProcessRunner = (args: string[], options?: { cwd?: string }) => Promise<ProcessResult>;

type HydrateDependencies = {
  cwd?: string;
  runner?: ProcessRunner;
  promptRepo?: (cwd: string) => Promise<string | undefined>;
};

const configKeys = new Set([
  "repo",
  "baseBranch",
  "verify",
  "readyLabel",
  "inProgressLabel",
  "successLabel",
  "failureLabel",
  "skipLabels",
  "maxFixPasses",
]);

const unsupportedConfigKeys = new Set(["model", "thinking", "updateStrategy"]);

export async function hydrateCliOptions(raw: RawCliOptions, deps: HydrateDependencies = {}): Promise<CliOptions> {
  const runner = deps.runner ?? runProcess;
  const workspace = await resolveWorkspace(raw.cwd ?? deps.cwd ?? process.cwd(), runner);
  const config = await loadRoarkConfig(workspace);
  const repo = await hydrateRepo(raw, config, workspace, runner, deps.promptRepo);

  if (raw.command === "auto") {
    const verifyCommand = await hydrateRequiredVerifyCommand(raw.verifyCommand, config, workspace, runner, raw.command);
    return {
      command: "auto",
      issue: raw.issue,
      cwd: workspace,
      repo,
      readyLabel: raw.readyLabel ?? config.readyLabel ?? defaultAutorunReadyLabel,
      skipLabels: raw.skipLabels ?? config.skipLabels ?? [...defaultAutorunSkipLabels],
      limit: raw.limit ?? 1,
      inProgressLabel: raw.inProgressLabel ?? config.inProgressLabel ?? defaultAutorunInProgressLabel,
      assignee: raw.assignee,
      noAssign: raw.noAssign ?? false,
      dryRun: raw.dryRun ?? false,
      baseBranch: raw.baseBranch ?? config.baseBranch ?? defaultAutorunBaseBranch,
      verifyCommand,
      failureLabel: raw.failureLabel ?? config.failureLabel ?? defaultAutorunFailureLabel,
      successLabel: raw.successLabel ?? config.successLabel ?? defaultAutorunSuccessLabel,
      remote: raw.remote ?? defaultAutorunRemote,
      model: raw.model,
      thinkingLevel: raw.thinkingLevel,
      maxFixPasses: raw.maxFixPasses ?? config.maxFixPasses ?? defaultMaxFixPasses,
      force: raw.force ?? false,
      yes: raw.yes ?? false,
    } satisfies AutoCliOptions;
  }

  if (raw.command === "continue") {
    const verifyCommand = await hydrateRequiredVerifyCommand(raw.verifyCommand, config, workspace, runner, raw.command);
    return {
      command: "continue",
      issue: raw.issue,
      cwd: workspace,
      outDir: raw.outDir ?? ".roark/runs",
      repo,
      model: raw.model,
      thinkingLevel: raw.thinkingLevel,
      force: raw.force ?? false,
      yes: raw.yes ?? false,
      maxFixPasses: raw.maxFixPasses ?? config.maxFixPasses ?? defaultMaxFixPasses,
      attempt: raw.attempt,
      verifyCommand,
      failureLabel: raw.failureLabel ?? config.failureLabel ?? defaultAutorunFailureLabel,
      successLabel: raw.successLabel ?? config.successLabel ?? defaultAutorunSuccessLabel,
      inProgressLabel: raw.inProgressLabel ?? config.inProgressLabel ?? defaultAutorunInProgressLabel,
      remote: raw.remote ?? defaultAutorunRemote,
    } satisfies ContinueCliOptions;
  }

  if (raw.command === "revise-pr") {
    return {
      command: "revise-pr",
      prNumber: raw.prNumber,
      cwd: workspace,
      outDir: raw.outDir ?? ".roark/runs",
      repo,
      model: raw.model,
      thinkingLevel: raw.thinkingLevel,
      verifyCommand: raw.verifyCommand ?? config.verify ?? defaultAutorunVerifyCommand,
      remote: raw.remote ?? defaultAutorunRemote,
      maxFixPasses: raw.maxFixPasses ?? config.maxFixPasses ?? 1,
      force: raw.force ?? false,
      yes: raw.yes ?? false,
      comment: raw.comment ?? true,
    } satisfies RevisePrCliOptions;
  }

  if (raw.command === "status") {
    return {
      command: "status",
      issue: raw.issue,
      all: raw.all ?? false,
      cwd: workspace,
      outDir: raw.outDir ?? ".roark/runs",
      repo,
      attempt: raw.attempt,
    } satisfies StatusCliOptions;
  }

  return {
    command: raw.command,
    issue: raw.issue,
    cwd: workspace,
    outDir: raw.outDir ?? ".roark/runs",
    repo,
    model: raw.model,
    thinkingLevel: raw.thinkingLevel,
    force: raw.force ?? false,
    yes: raw.yes ?? false,
    maxFixPasses: raw.maxFixPasses ?? config.maxFixPasses ?? defaultMaxFixPasses,
    fixPass: raw.fixPass,
    attempt: raw.attempt,
  };
}

export async function resolveWorkspace(startCwd: string, runner: ProcessRunner = runProcess): Promise<string> {
  const absoluteStart = path.resolve(startCwd);
  const result = await runner(["git", "rev-parse", "--show-toplevel"], { cwd: absoluteStart });
  if (result.exitCode !== 0) {
    throw new Error(`Roark commands must be run inside a git repository. '${absoluteStart}' is not inside a git work tree.`);
  }
  const gitRoot = result.stdout.trim();
  if (!gitRoot) throw new Error("git rev-parse --show-toplevel returned an empty workspace path.");
  return path.resolve(gitRoot);
}

export async function loadRoarkConfig(workspace: string): Promise<RoarkConfig> {
  const configPath = path.join(workspace, ".roark", "config.json");
  if (!existsSync(configPath)) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(configPath, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid Roark config at ${configPath}: ${detail}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid Roark config at ${configPath}: expected a JSON object.`);
  }

  const record = parsed as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (unsupportedConfigKeys.has(key)) {
      throw new Error(`Unsupported Roark config key '${key}' in ${configPath}. '${key}' is CLI-only or not supported in config v1.`);
    }
    if (!configKeys.has(key)) throw new Error(`Unknown Roark config key '${key}' in ${configPath}.`);
  }

  const config: RoarkConfig = {};
  for (const key of ["repo", "baseBranch", "verify", "readyLabel", "inProgressLabel", "successLabel", "failureLabel"] as const) {
    const value = record[key];
    if (value === undefined) continue;
    if (typeof value !== "string" || value.trim() === "") {
      throw new Error(`Invalid Roark config at ${configPath}: '${key}' must be a non-empty string.`);
    }
    config[key] = value;
  }

  if (record.skipLabels !== undefined) {
    if (!Array.isArray(record.skipLabels) || record.skipLabels.some((label) => typeof label !== "string" || label.trim() === "")) {
      throw new Error(`Invalid Roark config at ${configPath}: 'skipLabels' must be an array of non-empty strings.`);
    }
    config.skipLabels = [...record.skipLabels] as string[];
  }

  if (record.maxFixPasses !== undefined) {
    if (!Number.isInteger(record.maxFixPasses) || (record.maxFixPasses as number) < 1) {
      throw new Error(`Invalid Roark config at ${configPath}: 'maxFixPasses' must be a positive integer.`);
    }
    config.maxFixPasses = record.maxFixPasses as number;
  }

  return config;
}

export function parseGithubRepoFromOrigin(originUrl: string): string | undefined {
  const trimmed = originUrl.trim();
  const match =
    trimmed.match(/^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i) ??
    trimmed.match(/^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i) ??
    trimmed.match(/^ssh:\/\/git@github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  if (!match?.[1] || !match[2]) return undefined;
  return `${match[1]}/${match[2]}`;
}

async function hydrateRepo(
  raw: RawCliOptions,
  config: RoarkConfig,
  workspace: string,
  runner: ProcessRunner,
  promptRepo?: (cwd: string) => Promise<string | undefined>,
): Promise<string | undefined> {
  if (raw.repo) return raw.repo;

  const issueRepo = repoFromQualifiedIssueRef("issue" in raw ? raw.issue : undefined);
  if (issueRepo) return issueRepo;

  if (config.repo) return config.repo;

  const inferred = await inferRepoFromOrigin(workspace, runner);
  if (inferred) return inferred;

  if (raw.command === "status") return undefined;

  const prompted = promptRepo ? await promptRepo(workspace) : await promptForRepoIfInteractive(workspace);
  if (prompted) return prompted;

  throw new Error(
    "Could not determine GitHub repository. Pass --repo, add .roark/config.json with a repo value, or set GitHub origin remote.",
  );
}

function repoFromQualifiedIssueRef(issue: string | undefined): string | undefined {
  const urlMatch = issue?.match(/^https?:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/\d+/i);
  if (urlMatch?.[1]) return urlMatch[1];

  const shorthandMatch = issue?.match(/^([^/\s]+\/[^#\s]+)#\d+$/);
  if (shorthandMatch?.[1]) return shorthandMatch[1];

  return undefined;
}

async function inferRepoFromOrigin(workspace: string, runner: ProcessRunner): Promise<string | undefined> {
  const result = await runner(["git", "remote", "get-url", "origin"], { cwd: workspace });
  if (result.exitCode !== 0) return undefined;
  return parseGithubRepoFromOrigin(result.stdout);
}

async function hydrateRequiredVerifyCommand(
  cliVerify: string | undefined,
  config: RoarkConfig,
  workspace: string,
  runner: ProcessRunner,
  command: "auto" | "continue",
): Promise<string> {
  const verifyCommand = cliVerify ?? config.verify ?? await inferVerifyCommand(workspace, runner);
  if (verifyCommand) return verifyCommand;
  throw new Error(
    `Could not determine verification command for '${command}'. Pass --verify, add .roark/config.json with a verify value, or add package.json scripts.typecheck/scripts.test or a Makefile test target.`,
  );
}

export async function inferVerifyCommand(workspace: string, runner: ProcessRunner = runProcess): Promise<string | undefined> {
  const packageJsonPath = path.join(workspace, "package.json");
  if (existsSync(packageJsonPath)) {
    try {
      const parsed = JSON.parse(await readFile(packageJsonPath, "utf8")) as { scripts?: Record<string, unknown> };
      if (typeof parsed.scripts?.typecheck === "string") return "bun run typecheck";
      if (typeof parsed.scripts?.test === "string") return "bun run test";
    } catch {
      // Ignore malformed package.json for inference and continue to Makefile detection.
    }
  }

  const makefilePath = path.join(workspace, "Makefile");
  if (existsSync(makefilePath)) {
    const makefile = await readFile(makefilePath, "utf8");
    if (/^test\s*:/m.test(makefile)) return "make test";
  }

  return undefined;
}

async function promptForRepoIfInteractive(workspace: string): Promise<string | undefined> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return undefined;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`GitHub repository for ${workspace} (owner/repo): `)).trim();
    return answer || undefined;
  } finally {
    rl.close();
  }
}
