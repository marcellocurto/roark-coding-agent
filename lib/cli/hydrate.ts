import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { defaultAutorunFailureLabel } from "../autorun/failure.ts";
import { defaultAutorunBaseBranch } from "../autorun/branch.ts";
import { mergeLifecycleSkipLabels } from "../autorun/labels.ts";
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
  type InitCliOptions,
  type RawCliOptions,
  type ReviewPrCliOptions,
  type RevisePrCliOptions,
  type StatusCliOptions,
} from "./args.ts";
import {
  defaultLifecycleHooks,
  defaultWorkspaceConfig,
  validateCopyToWorktreeEntry,
  type LifecycleHooksConfig,
  type WorkspaceConfig,
} from "../autorun/workspace.ts";
import { runProcess, type ProcessResult } from "./process.ts";

export interface RoarkConfig {
  repo?: string | undefined  ;
  baseBranch?: string | undefined;
  verify?: string | undefined;
  readyLabel?: string | undefined;
  inProgressLabel?: string | undefined;
  successLabel?: string | undefined;
  failureLabel?: string | undefined;
  skipLabels?: string[] | undefined;
  maxFixPasses?: number | undefined;
  workspace?: WorkspaceConfig | undefined  ;
  hooks?: LifecycleHooksConfig | undefined  ;
  sandbox?: { provider: "host" } | undefined;
}

type ProcessRunner = (args: string[], options?: { cwd?: string  | undefined}) => Promise<ProcessResult>;

interface HydrateDependencies {
  cwd?: string | undefined  ;
  runner?: ProcessRunner | undefined  ;
  promptRepo?: (cwd: string) => Promise<string | undefined>;
}

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
  "workspace",
  "hooks",
  "sandbox",
]);

const unsupportedConfigKeys = new Set(["model", "thinking", "updateStrategy"]);

export async function hydrateCliOptions(raw: RawCliOptions, deps: HydrateDependencies = {}): Promise<CliOptions> {
  const runner = deps.runner ?? runProcess;
  const workspace = await resolveWorkspace(raw.cwd ?? deps.cwd ?? process.cwd(), runner);

  if (raw.command === "init") {
    return {
      command: "init",
      cwd: workspace,
      repo: raw.repo,
      force: raw.force ?? false,
    } satisfies InitCliOptions;
  }

  const config = await loadRoarkConfig(workspace);
  const repo = await hydrateRepo(raw, config, workspace, runner, deps.promptRepo);
  const workspaceConfig = config.workspace ?? defaultWorkspaceConfig;
  const hooks = config.hooks ?? defaultLifecycleHooks;

  if (raw.command === "workspace") {
    if (raw.action === "list") return { command: "workspace", action: "list", cwd: workspace, repo, workspace: workspaceConfig, hooks };
    if (raw.action === "remove") return { command: "workspace", action: "remove", target: raw.target, cwd: workspace, repo, force: raw.force ?? false, workspace: workspaceConfig, hooks };
    return { command: "workspace", action: "prune", olderThan: raw.olderThan, cwd: workspace, repo, force: raw.force ?? false, workspace: workspaceConfig, hooks };
  }

  if (raw.command === "auto") {
    const verifyCommand = await hydrateRequiredVerifyCommand(raw.verifyCommand, config, workspace, runner, raw.command);
    const inProgressLabel = raw.inProgressLabel ?? config.inProgressLabel ?? defaultAutorunInProgressLabel;
    const failureLabel = raw.failureLabel ?? config.failureLabel ?? defaultAutorunFailureLabel;
    const successLabel = raw.successLabel ?? config.successLabel ?? defaultAutorunSuccessLabel;
    const configuredSkipLabels = raw.skipLabels ?? config.skipLabels ?? [...defaultAutorunSkipLabels];
    return {
      command: "auto",
      issue: raw.issue,
      cwd: workspace,
      repo,
      readyLabel: raw.readyLabel ?? config.readyLabel ?? defaultAutorunReadyLabel,
      skipLabels: mergeLifecycleSkipLabels({ skipLabels: configuredSkipLabels, inProgressLabel, failureLabel, successLabel }),
      limit: raw.limit ?? 1,
      inProgressLabel,
      assignee: raw.assignee,
      noAssign: raw.noAssign ?? false,
      dryRun: raw.dryRun ?? false,
      baseBranch: raw.baseBranch ?? config.baseBranch ?? defaultAutorunBaseBranch,
      verifyCommand,
      failureLabel,
      successLabel,
      remote: raw.remote ?? defaultAutorunRemote,
      model: raw.model,
      thinkingLevel: raw.thinkingLevel,
      thinkingProfile: raw.thinkingProfile,
      maxFixPasses: raw.maxFixPasses ?? config.maxFixPasses ?? defaultMaxFixPasses,
      force: raw.force ?? false,
      yes: raw.yes ?? false,
      workspace: workspaceConfig,
      hooks,
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
      thinkingProfile: raw.thinkingProfile,
      force: raw.force ?? false,
      yes: raw.yes ?? false,
      maxFixPasses: raw.maxFixPasses ?? config.maxFixPasses ?? defaultMaxFixPasses,
      attempt: raw.attempt,
      verifyCommand,
      failureLabel: raw.failureLabel ?? config.failureLabel ?? defaultAutorunFailureLabel,
      successLabel: raw.successLabel ?? config.successLabel ?? defaultAutorunSuccessLabel,
      inProgressLabel: raw.inProgressLabel ?? config.inProgressLabel ?? defaultAutorunInProgressLabel,
      remote: raw.remote ?? defaultAutorunRemote,
      workspace: workspaceConfig,
      hooks,
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
      thinkingProfile: raw.thinkingProfile,
      verifyCommand: raw.verifyCommand ?? config.verify ?? defaultAutorunVerifyCommand,
      remote: raw.remote ?? defaultAutorunRemote,
      maxFixPasses: raw.maxFixPasses ?? config.maxFixPasses ?? defaultMaxFixPasses,
      force: raw.force ?? false,
      yes: raw.yes ?? false,
      comment: raw.comment ?? true,
      workspace: workspaceConfig,
      hooks,
    } satisfies RevisePrCliOptions;
  }

  if (raw.command === "review-pr") {
    return {
      command: "review-pr",
      prNumber: raw.prNumber,
      cwd: workspace,
      outDir: raw.outDir ?? ".roark/runs",
      repo,
      model: raw.model,
      thinkingLevel: raw.thinkingLevel,
      thinkingProfile: raw.thinkingProfile,
      verifyCommand: raw.verifyCommand ?? config.verify,
      verificationSource: raw.verifyCommand ? "explicit" : config.verify ? "config" : "unresolved",
      comment: raw.comment ?? true,
      workspace: workspaceConfig,
      hooks,
    } satisfies ReviewPrCliOptions;
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
    thinkingProfile: raw.thinkingProfile,
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

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
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

  if (record["skipLabels"] !== undefined) {
    if (!Array.isArray(record["skipLabels"]) || record["skipLabels"].some((label) => typeof label !== "string" || label.trim() === "")) {
      throw new Error(`Invalid Roark config at ${configPath}: 'skipLabels' must be an array of non-empty strings.`);
    }
    config.skipLabels = record["skipLabels"].filter((label): label is string => typeof label === "string");
  }

  if (record["maxFixPasses"] !== undefined) {
    if (!Number.isInteger(record["maxFixPasses"]) || (record["maxFixPasses"] as number) < 1) {
      throw new Error(`Invalid Roark config at ${configPath}: 'maxFixPasses' must be a positive integer.`);
    }
    config.maxFixPasses = record["maxFixPasses"] as number;
  }

  if (record["workspace"] !== undefined) config.workspace = parseWorkspaceConfig(record["workspace"], configPath);
  if (record["hooks"] !== undefined) config.hooks = parseHooksConfig(record["hooks"], configPath);
  if (record["sandbox"] !== undefined) config.sandbox = parseSandboxConfig(record["sandbox"], configPath);

  return config;
}

function parseWorkspaceConfig(value: unknown, configPath: string): WorkspaceConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Invalid Roark config at ${configPath}: 'workspace' must be an object.`);
  }
  const record = value as Record<string, unknown>;
  assertKnownNestedKeys(record, new Set(["root", "strategy", "cloneRemote", "clone", "copyToWorktree"]), "workspace", configPath);
  const strategy = record["strategy"] ?? defaultWorkspaceConfig.strategy;
  if (strategy !== "clone") throw new Error(`Invalid Roark config at ${configPath}: 'workspace.strategy' must be 'clone'.`);
  const root = record["root"] ?? defaultWorkspaceConfig.root;
  if (typeof root !== "string" || root.trim() === "") throw new Error(`Invalid Roark config at ${configPath}: 'workspace.root' must be a non-empty string.`);
  const cloneRemote = record["cloneRemote"] ?? defaultWorkspaceConfig.cloneRemote;
  if (typeof cloneRemote !== "string" || cloneRemote.trim() === "") throw new Error(`Invalid Roark config at ${configPath}: 'workspace.cloneRemote' must be a non-empty string.`);

  const clone = { ...defaultWorkspaceConfig.clone };
  if (record["clone"] !== undefined) {
    if (!record["clone"] || typeof record["clone"] !== "object" || Array.isArray(record["clone"])) {
      throw new Error(`Invalid Roark config at ${configPath}: 'workspace.clone' must be an object.`);
    }
    const cloneRecord = record["clone"] as Record<string, unknown>;
    assertKnownNestedKeys(cloneRecord, new Set(["filter", "depth"]), "workspace.clone", configPath);
    if (cloneRecord["filter"] !== undefined) {
      if (cloneRecord["filter"] !== null && (typeof cloneRecord["filter"] !== "string" || cloneRecord["filter"].trim() === "")) {
        throw new Error(`Invalid Roark config at ${configPath}: 'workspace.clone.filter' must be a non-empty string or null.`);
      }
      clone.filter = cloneRecord["filter"];
    }
    if (cloneRecord["depth"] !== undefined) {
      if (cloneRecord["depth"] !== null && (!Number.isInteger(cloneRecord["depth"]) || (cloneRecord["depth"] as number) < 1)) {
        throw new Error(`Invalid Roark config at ${configPath}: 'workspace.clone.depth' must be a positive integer or null.`);
      }
      clone.depth = cloneRecord["depth"] as number | null;
    }
  }

  const copyToWorktree = parseCopyToWorktree(record["copyToWorktree"], configPath);

  return { root, strategy: "clone", cloneRemote, clone, copyToWorktree };
}

function parseCopyToWorktree(value: unknown, configPath: string): string[] {
  if (value === undefined) return [...defaultWorkspaceConfig.copyToWorktree];
  if (!Array.isArray(value)) throw new Error(`Invalid Roark config at ${configPath}: 'workspace.copyToWorktree' must be an array of relative paths.`);
  return value.map((entry, index) => {
    if (typeof entry !== "string") throw new Error(`Invalid Roark config at ${configPath}: 'workspace.copyToWorktree[${index}]' must be a non-empty string.`);
    try {
      return validateCopyToWorktreeEntry(entry, `workspace.copyToWorktree[${index}]`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid Roark config at ${configPath}: ${detail}`);
    }
  });
}

function parseHooksConfig(value: unknown, configPath: string): LifecycleHooksConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Invalid Roark config at ${configPath}: 'hooks' must be an object.`);
  }
  const record = value as Record<string, unknown>;
  assertKnownNestedKeys(record, new Set(["afterCreate", "beforeRun", "beforeVerify", "afterRun", "beforeRemove", "timeoutMs"]), "hooks", configPath);
  const hooks: LifecycleHooksConfig = { timeoutMs: defaultLifecycleHooks.timeoutMs };
  for (const key of ["afterCreate", "beforeRun", "beforeVerify", "afterRun", "beforeRemove"] as const) {
    const hook = record[key];
    if (hook === undefined) continue;
    if (typeof hook !== "string" || hook.trim() === "") throw new Error(`Invalid Roark config at ${configPath}: 'hooks.${key}' must be a non-empty string.`);
    hooks[key] = hook;
  }
  if (record["timeoutMs"] !== undefined) {
    if (!Number.isInteger(record["timeoutMs"]) || (record["timeoutMs"] as number) < 1) throw new Error(`Invalid Roark config at ${configPath}: 'hooks.timeoutMs' must be a positive integer.`);
    hooks.timeoutMs = record["timeoutMs"] as number;
  }
  return hooks;
}

function parseSandboxConfig(value: unknown, configPath: string): { provider: "host" } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`Invalid Roark config at ${configPath}: 'sandbox' must be an object.`);
  const record = value as Record<string, unknown>;
  assertKnownNestedKeys(record, new Set(["provider"]), "sandbox", configPath);
  if (record["provider"] !== undefined && record["provider"] !== "host") throw new Error(`Invalid Roark config at ${configPath}: 'sandbox.provider' must be 'host'.`);
  return { provider: "host" };
}

function assertKnownNestedKeys(record: Record<string, unknown>, allowed: Set<string>, keyPath: string, configPath: string): void {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw new Error(`Unknown Roark config key '${keyPath}.${key}' in ${configPath}.`);
  }
}

export function parseGithubRepoFromOrigin(originUrl: string): string | undefined {
  const trimmed = originUrl.trim();
  const match =
    (/^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(trimmed)) ??
    (/^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i.exec(trimmed)) ??
    (/^ssh:\/\/git@github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(trimmed));
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

  const issueRepo = repoFromQualifiedIssueRef("issue" in raw && typeof raw.issue === "string" ? raw.issue : undefined);
  if (issueRepo) return issueRepo;

  if (config.repo) return config.repo;

  const inferred = await inferRepoFromOrigin(workspace, runner);
  if (inferred) return inferred;

  if (raw.command === "status" || raw.command === "workspace") return undefined;

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

export async function inferRepoFromOrigin(workspace: string, runner: ProcessRunner = runProcess): Promise<string | undefined> {
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
  void runner;
  const packageJsonPath = path.join(workspace, "package.json");
  if (existsSync(packageJsonPath)) {
    try {
      const parsed = JSON.parse(await readFile(packageJsonPath, "utf8")) as { scripts?: Record<string, unknown> };
      if (typeof parsed.scripts?.["typecheck"] === "string") return "bun run typecheck";
      if (typeof parsed.scripts?.["test"] === "string") return "bun run test";
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
