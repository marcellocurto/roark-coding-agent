import { existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
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
import { defaultLifecycleHooks, defaultWorkspaceConfig, type WorkspaceConfig } from "../autorun/workspace.ts";
import { inferRepoFromOrigin, inferVerifyCommand, type RoarkConfig } from "./hydrate.ts";
import { runProcess, type ProcessResult } from "./process.ts";

type ProcessRunner = (args: string[], options?: { cwd?: string  | undefined}) => Promise<ProcessResult>;

export interface InitResult {
  root: string;
  files: string[];
  verify?: string | undefined;
  repo: string;
  guidance: string[];
}

interface InitDependencies {
  runner?: ProcessRunner | undefined  ;
}

type InitRoarkConfig = Omit<RoarkConfig, "workspace"> & { workspace: Omit<WorkspaceConfig, "copyToWorktree"> };

const managedFiles = [".roark/config.json", ".roark/.gitignore"] as const;

export const roarkGitignoreContent = `runs/
worktrees/
logs/
*.local.json
`;


export async function runInit(options: InitCliOptions, deps: InitDependencies = {}): Promise<InitResult> {
  const runner = deps.runner ?? runProcess;
  const repo = options.repo ?? (await inferRepoFromOrigin(options.cwd, runner));
  if (!repo) {
    throw new Error("Could not determine GitHub repository. Pass --repo owner/repo or set origin to a GitHub repository URL.");
  }
  assertOwnerRepo(repo);

  const verify = await inferVerifyCommand(options.cwd, runner);
  const setupHook = await inferSetupHook(options.cwd);
  const config = buildInitConfig({ repo, verify, setupHook });
  const writes = new Map<string, string>([
    [".roark/config.json", `${JSON.stringify(config, null, 2)}\n`],
    [".roark/.gitignore", roarkGitignoreContent],
  ]);

  const conflicts = managedFiles.filter((relativePath) => existsSync(path.join(options.cwd, relativePath)));
  if (conflicts.length > 0 && !options.force) {
    throw new Error(
      `Refusing to overwrite existing Roark init file(s): ${conflicts.join(", ")}. Re-run with --force to overwrite only init-managed files.`,
    );
  }

  await ensureRoarkDirectory(options.cwd);
  for (const [relativePath, content] of writes) {
    await writeFile(path.join(options.cwd, relativePath), content, "utf8");
  }

  const guidance = verify
    ? [`Configured verification command: ${verify}`]
    : ["No obvious verification command was found. Edit .roark/config.json and add a verify command before using auto/continue."];

  return {
    root: options.cwd,
    files: [...managedFiles],
    verify,
    repo,
    guidance,
  };
}

function buildInitConfig(input: { repo: string; verify?: string | undefined; setupHook?: string | undefined }): InitRoarkConfig {
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
      ...(input.setupHook ? { afterCreate: input.setupHook, beforeRun: input.setupHook, beforeVerify: input.setupHook } : {}),
      timeoutMs: defaultLifecycleHooks.timeoutMs,
    },
    sandbox: { provider: "host" },
  };
}

async function inferSetupHook(workspace: string): Promise<string | undefined> {
  if (existsSync(path.join(workspace, "bun.lock")) || existsSync(path.join(workspace, "bun.lockb"))) return "bun install --frozen-lockfile";
  if (existsSync(path.join(workspace, "pnpm-lock.yaml"))) return "pnpm install --frozen-lockfile";
  if (existsSync(path.join(workspace, "package-lock.json"))) return "npm ci";
  if (existsSync(path.join(workspace, "yarn.lock"))) {
    try {
      const lockfile = await readFile(path.join(workspace, "yarn.lock"), "utf8");
      return lockfile.startsWith("# yarn lockfile v1") ? "yarn install --frozen-lockfile" : "yarn install --immutable";
    } catch {
      return "yarn install --immutable";
    }
  }
  return undefined;
}

async function ensureRoarkDirectory(workspace: string): Promise<void> {
  const roarkDir = path.join(workspace, ".roark");
  if (existsSync(roarkDir)) {
    const existing = await stat(roarkDir);
    if (!existing.isDirectory()) throw new Error(`${roarkDir} exists but is not a directory.`);
    return;
  }
  await mkdir(roarkDir, { recursive: true });
}

function assertOwnerRepo(repo: string): void {
  if (/^[^/\s]+\/[^/\s]+$/.test(repo)) return;
  throw new Error(`GitHub repository must be in owner/repo form. Got '${repo}'.`);
}
