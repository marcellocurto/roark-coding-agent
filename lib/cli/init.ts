import { Effect, FileSystem, Schema } from "effect";
import { inferVerificationCommand } from "../autorun/verification.ts";
import { runProcess } from "./process.ts";
import path from "node:path";
import { defaultAutorunFailureLabel } from "../autorun/failure.ts";
import { defaultAutorunBaseBranch } from "../autorun/branch.ts";
import { defaultAutorunSuccessLabel } from "../autorun/publish.ts";
import {
  defaultAutorunInProgressLabel,
  defaultAutorunReadyLabel,
  defaultAutorunSkipLabels,
} from "../autorun/selection.ts";
import { defaultMaxFixPasses, type InitCliOptions } from "./args.ts";
import {
  defaultLifecycleHooks,
  defaultWorkspaceConfig,
  type WorkspaceConfig,
} from "../autorun/workspace.ts";
import { inferRepoFromOrigin, type RoarkConfig } from "./hydrate.ts";
type ProcessRunner = typeof runProcess;
export interface InitResult {
  root: string;
  files: string[];
  verify?: string | undefined;
  repo: string;
  guidance: string[];
}
interface InitDependencies {
  runner?: ProcessRunner | undefined;
}
type InitRoarkConfig = Omit<RoarkConfig, "workspace"> & {
  workspace: Omit<WorkspaceConfig, "copyToWorktree">;
};
const managedFiles = [".roark/config.json", ".roark/.gitignore"] as const;
export const roarkGitignoreContent = `runs/
worktrees/
logs/
*.local.json
`;
export const runInit = Effect.fn("runInit")(function* (
  options: InitCliOptions,
  deps: InitDependencies = {},
) {
  const runner = deps.runner ?? runProcess;
  const rawRepo =
    options.repo ?? (yield* inferRepoFromOrigin(options.cwd, runner));
  if (!rawRepo) {
    return yield* Effect.fail(
      new InitializationError({
        message:
          "Could not determine GitHub repository. Pass --repo owner/repo or set origin to a GitHub repository URL.",
      }),
    );
  }
  yield* assertOwnerRepo(rawRepo);
  const repo = options.repo
    ? rawRepo
    : yield* canonicalizeGitHubRepo(rawRepo, runner);
  yield* assertOwnerRepo(repo);
  const verify = yield* inferVerificationCommand(options.cwd);
  const setupHook = yield* inferSetupHook(options.cwd);
  const config = buildInitConfig({ repo, verify, setupHook });
  const writes = new Map<string, string>([
    [".roark/config.json", `${JSON.stringify(config, null, 2)}\n`],
    [".roark/.gitignore", roarkGitignoreContent],
  ]);
  const fs = yield* FileSystem.FileSystem;
  const conflicts = yield* Effect.filter(managedFiles, (relativePath) =>
    fs.exists(path.join(options.cwd, relativePath)),
  );
  if (conflicts.length > 0 && !options.force) {
    return yield* Effect.fail(
      new InitializationError({
        message: `Refusing to overwrite existing Roark init file(s): ${conflicts.join(", ")}. Re-run with --force to overwrite only init-managed files.`,
      }),
    );
  }
  yield* Effect.gen(function* () {
    yield* ensureRoarkDirectory(options.cwd);
    for (const [relativePath, content] of writes) {
      yield* fs.writeFileString(path.join(options.cwd, relativePath), content);
    }
  }).pipe(Effect.uninterruptible);
  const guidance = verify
    ? [`Configured verification command: ${verify}`]
    : [
        "No obvious verification command was found. Edit .roark/config.json and add a verify command before using auto/continue.",
      ];
  return {
    root: options.cwd,
    files: [...managedFiles],
    verify,
    repo,
    guidance,
  };
});
const canonicalizeGitHubRepo = Effect.fn("canonicalizeGitHubRepo")(function* (
  repo: string,
  runner: ProcessRunner,
) {
  const result = yield* runner(
    [
      "gh",
      "repo",
      "view",
      repo,
      "--json",
      "nameWithOwner",
      "--jq",
      ".nameWithOwner",
    ],
    undefined,
  );
  if (result.exitCode !== 0) return repo;
  const canonical = result.stdout.trim();
  return /^[^/\s]+\/[^/\s]+$/.test(canonical) ? canonical : repo;
});
function buildInitConfig(input: {
  repo: string;
  verify?: string | undefined;
  setupHook?: string | undefined;
}): InitRoarkConfig {
  const workspaceDefaults = {
    root: defaultWorkspaceConfig.root,
    strategy: defaultWorkspaceConfig.strategy,
    cloneRemote: defaultWorkspaceConfig.cloneRemote,
    clone: defaultWorkspaceConfig.clone,
  };
  return {
    repo: input.repo,
    baseBranch: defaultAutorunBaseBranch,
    ...(input.verify ? { verify: input.verify } : {}),
    readyLabel: defaultAutorunReadyLabel,
    inProgressLabel: defaultAutorunInProgressLabel,
    successLabel: defaultAutorunSuccessLabel,
    failureLabel: defaultAutorunFailureLabel,
    skipLabels: [...defaultAutorunSkipLabels],
    maxFixPasses: defaultMaxFixPasses,
    workspace: workspaceDefaults,
    hooks: {
      ...(input.setupHook
        ? { beforeRun: input.setupHook, beforeVerify: input.setupHook }
        : {}),
      timeoutMs: defaultLifecycleHooks.timeoutMs,
    },
    sandbox: { provider: "host" },
  };
}
const inferSetupHook = Effect.fnUntraced(function* (workspace: string) {
  const fs = yield* FileSystem.FileSystem;
  for (const [file, command] of [
    ["bun.lock", "bun install --frozen-lockfile"],
    ["bun.lockb", "bun install --frozen-lockfile"],
    ["pnpm-lock.yaml", "pnpm install --frozen-lockfile"],
    ["package-lock.json", "npm ci"],
  ] as const) {
    if (yield* fs.exists(path.join(workspace, file))) return command;
  }
  if (!(yield* fs.exists(path.join(workspace, "yarn.lock")))) return undefined;
  return yield* fs.readFileString(path.join(workspace, "yarn.lock")).pipe(
    Effect.map((lock) =>
      lock.startsWith("# yarn lockfile v1")
        ? "yarn install --frozen-lockfile"
        : "yarn install --immutable",
    ),
    Effect.catch(() => Effect.succeed("yarn install --immutable")),
  );
});
const ensureRoarkDirectory = Effect.fn("ensureRoarkDirectory")(function* (
  workspace: string,
) {
  const roarkDir = path.join(workspace, ".roark");
  if (yield* (yield* FileSystem.FileSystem).exists(roarkDir)) {
    const existing = yield* (yield* FileSystem.FileSystem).stat(roarkDir);
    if (existing.type !== "Directory")
      return yield* Effect.fail(
        new InitializationError({
          message: `${roarkDir} exists but is not a directory.`,
        }),
      );
    return;
  }
  yield* (yield* FileSystem.FileSystem).makeDirectory(roarkDir, {
    recursive: true,
  });
});
const assertOwnerRepo = Effect.fnUntraced(function* (repo: string) {
  if (/^[^/\s]+\/[^/\s]+$/.test(repo)) return;
  return yield* new InitializationError({
    message: `GitHub repository must be in owner/repo form. Got '${repo}'.`,
  });
});
export class InitializationError extends Schema.TaggedError<InitializationError>()(
  "InitializationError",
  { message: Schema.String },
) {}
