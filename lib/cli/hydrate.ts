import { Effect, Schema, type FileSystem } from "effect";
import { runProcess, type ProcessResult } from "./process.ts";
import * as nativeVerification from "../autorun/verification.ts";
import { loadRoarkConfig, type RoarkConfig } from "./config.ts";
export type { RoarkConfig } from "./config.ts";
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
type ProcessRunner = typeof runProcess;
interface HydrateDependencies {
  cwd?: string | undefined;
  runner?: ProcessRunner | undefined;
  promptRepo?: (
    cwd: string,
  ) => Effect.Effect<string | undefined, CliConfigurationError>;
}
export const hydrateCliOptions = Effect.fn("hydrateCliOptions")(function* (
  raw: RawCliOptions,
  deps: HydrateDependencies = {},
): Effect.fn.Return<
  CliOptions,
  | CliConfigurationError
  | Effect.Error<ReturnType<typeof loadRoarkConfig>>
  | Effect.Error<ReturnType<typeof runProcess>>,
  | Effect.Services<ReturnType<typeof loadRoarkConfig>>
  | Effect.Services<ReturnType<typeof runProcess>>
  | FileSystem.FileSystem
> {
  const runner = deps.runner ?? runProcess;
  const workspace = yield* resolveWorkspace(
    raw.cwd ?? deps.cwd ?? process.cwd(),
    runner,
  );
  if (raw.command === "init") {
    return {
      command: "init",
      cwd: workspace,
      repo: raw.repo,
      force: raw.force ?? false,
    } satisfies InitCliOptions;
  }
  const config = yield* loadRoarkConfig(workspace);
  const repo = yield* hydrateRepo(
    raw,
    config,
    workspace,
    runner,
    deps.promptRepo,
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
    const verifyCommand = yield* hydrateRequiredVerifyCommand(
      raw.verifyCommand,
      config,
      workspace,
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
    const verifyCommand = yield* hydrateRequiredVerifyCommand(
      raw.verifyCommand,
      config,
      workspace,
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
});
export const resolveWorkspace = Effect.fn("resolveWorkspace")(function* (
  startCwd: string,
  runner: ProcessRunner = runProcess,
) {
  const absoluteStart = path.resolve(startCwd);
  const result = yield* runner(["git", "rev-parse", "--show-toplevel"], {
    cwd: absoluteStart,
  });
  return yield* workspaceFromGitResult(absoluteStart, result);
});
export const workspaceFromGitResult = Effect.fnUntraced(function* (
  absoluteStart: string,
  result: ProcessResult,
) {
  if (result.exitCode !== 0) {
    return yield* new CliConfigurationError({
      message: `Roark commands must be run inside a git repository. '${absoluteStart}' is not inside a git work tree.`,
    });
  }
  const gitRoot = result.stdout.trim();
  if (!gitRoot)
    return yield* new CliConfigurationError({
      message:
        "git rev-parse --show-toplevel returned an empty workspace path.",
    });
  return path.resolve(gitRoot);
});
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
const hydrateRepo = Effect.fn("hydrateRepo")(function* (
  raw: RawCliOptions,
  config: RoarkConfig,
  workspace: string,
  runner: ProcessRunner,
  promptRepo?: (
    cwd: string,
  ) => Effect.Effect<string | undefined, CliConfigurationError>,
) {
  if (raw.repo) return raw.repo;
  const issueRepo = repoFromQualifiedIssueRef(
    "issue" in raw && typeof raw.issue === "string" ? raw.issue : undefined,
  );
  if (issueRepo) return issueRepo;
  if (config.repo) return config.repo;
  const inferred = yield* inferRepoFromOrigin(workspace, runner);
  if (inferred) return inferred;
  if (raw.command === "status" || raw.command === "workspace") return undefined;
  const prompted = promptRepo
    ? yield* promptRepo(workspace)
    : yield* promptForRepoIfInteractive(workspace);
  if (prompted) return prompted;
  return yield* Effect.fail(
    new CliConfigurationError({
      message:
        "Could not determine GitHub repository. Pass --repo, add .roark/config.json with a repo value, or set GitHub origin remote.",
    }),
  );
});
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
export const inferRepoFromOrigin = Effect.fn("inferRepoFromOrigin")(function* (
  workspace: string,
  runner: ProcessRunner = runProcess,
) {
  const result = yield* runner(["git", "remote", "get-url", "origin"], {
    cwd: workspace,
  });
  if (result.exitCode !== 0) return undefined;
  return parseGithubRepoFromOrigin(result.stdout);
});
const hydrateRequiredVerifyCommand = Effect.fn("hydrateRequiredVerifyCommand")(
  function* (
    cliVerify: string | undefined,
    config: RoarkConfig,
    workspace: string,
    command: "auto" | "continue",
  ) {
    const verifyCommand =
      cliVerify ??
      config.verify ??
      (yield* nativeVerification.inferVerificationCommand(workspace));
    if (verifyCommand) return verifyCommand;
    return yield* Effect.fail(
      new CliConfigurationError({
        message: `Could not determine verification command for '${command}'. Pass --verify, add .roark/config.json with a verify value, or add package.json scripts.typecheck/scripts.test or a Makefile test target.`,
      }),
    );
  },
);
const promptForRepoIfInteractive = Effect.fnUntraced(function* (
  workspace: string,
) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return undefined;
  return yield* Effect.acquireUseRelease(
    Effect.sync(() =>
      createInterface({ input: process.stdin, output: process.stdout }),
    ),
    (rl) =>
      Effect.tryPromise({
        try: (signal) =>
          rl.question(`GitHub repository for ${workspace} (owner/repo): `, {
            signal,
          }),
        catch: (cause) =>
          new CliConfigurationError({
            message: cause instanceof Error ? cause.message : String(cause),
          }),
      }).pipe(Effect.map((answer) => answer.trim() || undefined)),
    (rl) =>
      Effect.sync(() => {
        rl.close();
      }),
  );
});
export class CliConfigurationError extends Schema.TaggedError<CliConfigurationError>()(
  "CliConfigurationError",
  { message: Schema.String },
) {}
