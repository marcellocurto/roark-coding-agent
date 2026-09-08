import { fromLegacyPromise } from "../runtime/application.ts";
import { runApplicationPromise } from "../runtime/application.ts";
import { loadRoarkConfig, type RoarkConfig } from "./config.ts";
export type { RoarkConfig } from "./config.ts";
import type { ApplicationExecution } from "../runtime/application.ts";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { defaultAutorunFailureLabel } from "../autorun/failure.ts";
import { defaultAutorunBaseBranch } from "../autorun/branch.ts";
import { mergeLifecycleSkipLabels } from "../autorun/labels.ts";
import {
  defaultAutorunRemote,
  defaultAutorunSuccessLabel,
} from "../autorun/publish.ts";
import {
  defaultAutorunInProgressLabel,
  defaultAutorunReadyLabel,
  defaultAutorunSkipLabels,
} from "../autorun/selection.ts";
import { defaultAutorunVerifyCommand } from "../autorun/verification.ts";
import { inferVerificationCommandPromise as inferVerificationCommand } from "../autorun/verification-promise.ts";
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
  type RemoveCommandOptions,
} from "../autorun/workspace.ts";
import { type ProcessResult } from "./process.ts";
import { runProcessPromise } from "./process-promise.ts";

type ProcessRunner = (
  args: string[],
  options?: { cwd?: string | undefined },
  application?: ApplicationExecution,
) => Promise<ProcessResult>;

interface HydrateDependencies {
  cwd?: string | undefined;
  runner?: ProcessRunner | undefined;
  promptRepo?: (cwd: string) => Promise<string | undefined>;
}

export async function hydrateCliOptions(
  raw: RawCliOptions,
  deps: HydrateDependencies = {},
  application?: ApplicationExecution,
): Promise<CliOptions> {
  if (!application)
    return runApplicationPromise(
      fromLegacyPromise((application) =>
        hydrateCliOptions(raw, deps, application),
      ),
      application,
    );

  const runner = deps.runner ?? runProcessPromise;
  const workspace = await resolveWorkspace(
    raw.cwd ?? deps.cwd ?? process.cwd(),
    runner,
    application,
  );

  if (raw.command === "init") {
    return {
      command: "init",
      cwd: workspace,
      repo: raw.repo,
      force: raw.force ?? false,
    } satisfies InitCliOptions;
  }

  const config = await loadRoarkConfigPromise(workspace, application);
  const repo = await hydrateRepo(
    raw,
    config,
    workspace,
    runner,
    deps.promptRepo,
    application,
  );
  const workspaceConfig = config.workspace ?? defaultWorkspaceConfig;
  const hooks = config.hooks ?? defaultLifecycleHooks;

  if (raw.command === "remove") {
    return {
      command: "remove",
      targets: raw.targets,
      cwd: workspace,
      repo,
      force: raw.force ?? false,
      workspace: workspaceConfig,
      hooks,
    } satisfies RemoveCommandOptions;
  }

  if (raw.command === "workspace") {
    if (raw.action === "list")
      return {
        command: "workspace",
        action: "list",
        cwd: workspace,
        repo,
        workspace: workspaceConfig,
        hooks,
      };
    return {
      command: "workspace",
      action: "prune",
      olderThan: raw.olderThan,
      cwd: workspace,
      repo,
      force: raw.force ?? false,
      workspace: workspaceConfig,
      hooks,
    };
  }

  if (raw.command === "auto") {
    const verifyCommand = await hydrateRequiredVerifyCommand(
      raw.verifyCommand,
      config,
      workspace,
      runner,
      raw.command,
    );
    const inProgressLabel =
      raw.inProgressLabel ??
      config.inProgressLabel ??
      defaultAutorunInProgressLabel;
    const failureLabel =
      raw.failureLabel ?? config.failureLabel ?? defaultAutorunFailureLabel;
    const successLabel =
      raw.successLabel ?? config.successLabel ?? defaultAutorunSuccessLabel;
    const configuredSkipLabels = raw.skipLabels ??
      config.skipLabels ?? [...defaultAutorunSkipLabels];
    return {
      command: "auto",
      issue: raw.issue,
      cwd: workspace,
      repo,
      readyLabel:
        raw.readyLabel ?? config.readyLabel ?? defaultAutorunReadyLabel,
      skipLabels: mergeLifecycleSkipLabels({
        skipLabels: configuredSkipLabels,
        inProgressLabel,
        failureLabel,
        successLabel,
      }),
      limit: raw.limit ?? 1,
      inProgressLabel,
      assignee: raw.assignee,
      noAssign: raw.noAssign ?? false,
      dryRun: raw.dryRun ?? false,
      baseBranch:
        raw.baseBranch ?? config.baseBranch ?? defaultAutorunBaseBranch,
      verifyCommand,
      failureLabel,
      successLabel,
      remote: raw.remote ?? defaultAutorunRemote,
      model: raw.model,
      thinkingLevel: raw.thinkingLevel,
      thinkingProfile: raw.thinkingProfile,
      maxFixPasses:
        raw.maxFixPasses ?? config.maxFixPasses ?? defaultMaxFixPasses,
      force: raw.force ?? false,
      yes: raw.yes ?? false,
      workspace: workspaceConfig,
      hooks,
    } satisfies AutoCliOptions;
  }

  if (raw.command === "continue") {
    const verifyCommand = await hydrateRequiredVerifyCommand(
      raw.verifyCommand,
      config,
      workspace,
      runner,
      raw.command,
    );
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
      maxFixPasses:
        raw.maxFixPasses ?? config.maxFixPasses ?? defaultMaxFixPasses,
      attempt: raw.attempt,
      verifyCommand,
      readyLabel: config.readyLabel ?? defaultAutorunReadyLabel,
      failureLabel:
        raw.failureLabel ?? config.failureLabel ?? defaultAutorunFailureLabel,
      successLabel:
        raw.successLabel ?? config.successLabel ?? defaultAutorunSuccessLabel,
      inProgressLabel:
        raw.inProgressLabel ??
        config.inProgressLabel ??
        defaultAutorunInProgressLabel,
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
      verifyCommand:
        raw.verifyCommand ?? config.verify ?? defaultAutorunVerifyCommand,
      remote: raw.remote ?? defaultAutorunRemote,
      maxFixPasses:
        raw.maxFixPasses ?? config.maxFixPasses ?? defaultMaxFixPasses,
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
      verifyCommand:
        raw.verifyCommand ?? config.verify ?? defaultAutorunVerifyCommand,
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
    maxFixPasses:
      raw.maxFixPasses ?? config.maxFixPasses ?? defaultMaxFixPasses,
    fixPass: raw.fixPass,
    attempt: raw.attempt,
  };
}

export async function resolveWorkspace(
  startCwd: string,
  runner: ProcessRunner = runProcessPromise,
  application?: ApplicationExecution,
): Promise<string> {
  if (!application)
    return runApplicationPromise(
      fromLegacyPromise((application) =>
        resolveWorkspace(startCwd, runner, application),
      ),
      application,
    );

  const absoluteStart = path.resolve(startCwd);
  const result = await runner(
    ["git", "rev-parse", "--show-toplevel"],
    { cwd: absoluteStart },
    application,
  );
  return workspaceFromGitResult(absoluteStart, result);
}

export function workspaceFromGitResult(
  absoluteStart: string,
  result: ProcessResult,
): string {
  if (result.exitCode !== 0) {
    throw new Error(
      `Roark commands must be run inside a git repository. '${absoluteStart}' is not inside a git work tree.`,
    );
  }
  const gitRoot = result.stdout.trim();
  if (!gitRoot)
    throw new Error(
      "git rev-parse --show-toplevel returned an empty workspace path.",
    );
  return path.resolve(gitRoot);
}

export function loadRoarkConfigPromise(
  workspace: string,
  application?: ApplicationExecution,
): Promise<RoarkConfig> {
  return runApplicationPromise(loadRoarkConfig(workspace), application);
}

export function parseGithubRepoFromOrigin(
  originUrl: string,
): string | undefined {
  const trimmed = originUrl.trim();
  const match =
    /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(
      trimmed,
    ) ??
    /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i.exec(trimmed) ??
    /^ssh:\/\/git@github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(
      trimmed,
    );
  if (!match?.[1] || !match[2]) return undefined;
  return `${match[1]}/${match[2]}`;
}

async function hydrateRepo(
  raw: RawCliOptions,
  config: RoarkConfig,
  workspace: string,
  runner: ProcessRunner,
  promptRepo?: (cwd: string) => Promise<string | undefined>,
  application?: ApplicationExecution,
): Promise<string | undefined> {
  if (raw.repo) return raw.repo;

  const issueRepo = repoFromQualifiedIssueRef(
    "issue" in raw && typeof raw.issue === "string" ? raw.issue : undefined,
  );
  if (issueRepo) return issueRepo;

  if (config.repo) return config.repo;

  const inferred = await inferRepoFromOrigin(workspace, runner, application);
  if (inferred) return inferred;

  if (raw.command === "status" || raw.command === "workspace") return undefined;

  const prompted = promptRepo
    ? await promptRepo(workspace)
    : await promptForRepoIfInteractive(workspace, application?.signal);
  if (prompted) return prompted;

  throw new Error(
    "Could not determine GitHub repository. Pass --repo, add .roark/config.json with a repo value, or set GitHub origin remote.",
  );
}

function repoFromQualifiedIssueRef(
  issue: string | undefined,
): string | undefined {
  const urlMatch = issue?.match(
    /^https?:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/\d+/i,
  );
  if (urlMatch?.[1]) return urlMatch[1];

  const shorthandMatch = issue?.match(/^([^/\s]+\/[^#\s]+)#\d+$/);
  if (shorthandMatch?.[1]) return shorthandMatch[1];

  return undefined;
}

export async function inferRepoFromOrigin(
  workspace: string,
  runner: ProcessRunner = runProcessPromise,
  application?: ApplicationExecution,
): Promise<string | undefined> {
  if (!application)
    return runApplicationPromise(
      fromLegacyPromise((application) =>
        inferRepoFromOrigin(workspace, runner, application),
      ),
      application,
    );

  const result = await runner(
    ["git", "remote", "get-url", "origin"],
    { cwd: workspace },
    application,
  );
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
  const verifyCommand =
    cliVerify ?? config.verify ?? (await inferVerifyCommand(workspace, runner));
  if (verifyCommand) return verifyCommand;
  throw new Error(
    `Could not determine verification command for '${command}'. Pass --verify, add .roark/config.json with a verify value, or add package.json scripts.typecheck/scripts.test or a Makefile test target.`,
  );
}

export async function inferVerifyCommand(
  workspace: string,
  runner: ProcessRunner = runProcessPromise,
): Promise<string | undefined> {
  void runner;
  return inferVerificationCommand(workspace);
}

async function promptForRepoIfInteractive(
  workspace: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return undefined;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (
      await rl.question(`GitHub repository for ${workspace} (owner/repo): `, {
        signal,
      })
    ).trim();
    return answer || undefined;
  } finally {
    rl.close();
  }
}
