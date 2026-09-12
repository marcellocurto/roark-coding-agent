import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import type { Scope } from "effect";

import {
  Cause,
  Clock,
  DateTime,
  Effect,
  Exit,
  FileSystem,
  Option,
  Predicate,
  Schema,
  type PlatformError,
} from "effect";
import { Presentation } from "../runtime/services.ts";
import {
  decodeCopyToWorktreeEntry,
  type InvalidCopyPathError,
} from "./copy-path.ts";
export { validateCopyToWorktreeEntry } from "./copy-path.ts";

import { lstat as nodeLstat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { executeProcess, type ProcessResult } from "../cli/process.ts";
import { runProcess, runProcessOrThrow } from "../cli/process.ts";

import type { AutorunBranchPlan } from "./branch.ts";
import {
  defaultLifecycleHooks,
  type WorkspaceStrategy,
  type WorkspaceCloneConfig,
  type WorkspaceConfig,
  type LifecycleHooksConfig,
} from "./workspace-config.ts";
export {
  defaultLifecycleHooks,
  defaultWorkspaceConfig,
  type WorkspaceStrategy,
  type WorkspaceCloneConfig,
  type WorkspaceConfig,
  type LifecycleHooksConfig,
} from "./workspace-config.ts";
export interface AttemptWorkspaceMetadata {
  path: string;
  strategy: WorkspaceStrategy;
  cloneRemote: string;
  cloneUrl?: string | undefined;
  createdNow: boolean;
}
export interface PreparedWorkspace {
  path: string;
  metadata: AttemptWorkspaceMetadata;
}
export type PreparedPrRevisionWorkspace = PreparedWorkspace;
export interface PrReviewComparison {
  baseOid: string;
  headOid: string;
  mergeBaseOid: string;
  changedFiles: string[];
  diffStat: string;
  inspectionCommand: string;
}
export interface PreparedPrReviewWorkspace extends PreparedWorkspace {
  comparison: PrReviewComparison;
}
class PrReviewHeadChangedError extends Schema.TaggedError<PrReviewHeadChangedError>()(
  "PrReviewHeadChangedError",
  { message: Schema.String },
) {}
export type WorkspaceRemoveTarget =
  | {
      kind: "issue";
      number: number;
    }
  | {
      kind: "pr";
      number: number;
    };
export interface ManagedWorkspace {
  path: string;
  target: WorkspaceRemoveTarget;
}
export type WorkspaceCommandOptions =
  | {
      command: "workspace";
      action: "list";
      cwd: string;
      repo?: string | undefined;
      workspace: WorkspaceConfig;
      hooks: LifecycleHooksConfig;
    }
  | {
      command: "workspace";
      action: "prune";
      olderThan: string;
      cwd: string;
      repo?: string | undefined;
      force: boolean;
      workspace: WorkspaceConfig;
      hooks: LifecycleHooksConfig;
    };
export interface RemoveCommandOptions {
  command: "remove";
  targets: WorkspaceRemoveTarget[];
  cwd: string;
  repo?: string | undefined;
  force: boolean;
  workspace: WorkspaceConfig;
  hooks: LifecycleHooksConfig;
}
export const workspaceStateFile = ".roark-workspace-state.json";
export class WorkspaceCommandError extends Schema.TaggedError<WorkspaceCommandError>()(
  "WorkspaceCommandError",
  { cause: Schema.Unknown },
) {
  override get message() {
    return this.cause instanceof Error
      ? this.cause.message
      : String(this.cause);
  }
}
export type ProcessRunner = (
  ...args: Parameters<typeof executeProcess>
) => Effect.Effect<
  ProcessResult & { timedOut?: boolean | undefined },
  WorkspaceCommandError | Effect.Error<ReturnType<typeof runProcess>>,
  Effect.Services<ReturnType<typeof runProcess>>
>;
const WorkspaceLockOwner = Schema.Struct({
  token: Schema.String,
  pid: Schema.Int.check(Schema.isGreaterThan(0)),
  createdAt: Schema.String,
});
const decodeLockOwner = Schema.decodeUnknownEffect(
  Schema.fromJsonString(WorkspaceLockOwner),
);
const ownerlessLockGraceMs = 5_000;

export class WorkspaceError extends Schema.TaggedError<WorkspaceError>()(
  "WorkspaceError",
  { message: Schema.String },
) {}
class WorkspacePathError extends Schema.TaggedError<WorkspacePathError>()(
  "WorkspacePathError",
  { path: Schema.String, cause: Schema.Unknown },
) {}
// Effect FileSystem.stat follows links; these path-safety checks require lstat.
const lstat = Effect.fnUntraced(function* (path: string) {
  return yield* Effect.tryPromise({
    try: () => nodeLstat(path),
    catch: (cause) => new WorkspacePathError({ path, cause }),
  });
});

export function expandHome(input: string): string {
  if (input === "~") return os.homedir();
  if (input.startsWith(`~${path.sep}`))
    return path.join(os.homedir(), input.slice(2));
  return input;
}
export function normalizeWorkspaceRoot(root: string): string {
  return path.resolve(expandHome(root));
}
export function sanitizeWorkspaceSegment(value: string): string {
  const sanitized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "");
  return sanitized || "unknown";
}
export function workspacePathForIssue(input: {
  root: string;
  repo?: string | undefined;
  issueNumber: number;
  controlCwd?: string | undefined;
}): string {
  const root = normalizeWorkspaceRoot(input.root);
  const repoSegment = repoSegmentForWorkspace(input.repo, input.controlCwd);
  const issueSegment = `issue-${sanitizeWorkspaceSegment(String(input.issueNumber))}`;
  const workspacePath = path.resolve(root, repoSegment, issueSegment);
  assertPathInsideRoot({ root, target: workspacePath });
  return workspacePath;
}
export function workspacePathForPrRevision(input: {
  root: string;
  repo?: string | undefined;
  prNumber: number;
  controlCwd?: string | undefined;
}): string {
  const root = normalizeWorkspaceRoot(input.root);
  const repoSegment = repoSegmentForWorkspace(input.repo, input.controlCwd);
  const prSegment = `pr-${sanitizeWorkspaceSegment(String(input.prNumber))}`;
  const workspacePath = path.resolve(root, repoSegment, prSegment);
  assertPathInsideRoot({ root, target: workspacePath });
  return workspacePath;
}
export const assertWorkspacePathSafe = Effect.fn("assertWorkspacePathSafe")(
  function* (input: { root: string; workspacePath: string }) {
    const root = normalizeWorkspaceRoot(input.root);
    const workspacePath = path.resolve(input.workspacePath);
    yield* checkWorkspaceInput(() => {
      assertPathInsideRoot({ root, target: workspacePath });
    });
    yield* (yield* FileSystem.FileSystem).makeDirectory(root, {
      recursive: true,
    });
    const rootStat = yield* lstat(root);
    if (rootStat.isSymbolicLink())
      return yield* Effect.fail(
        new WorkspaceError({
          message: `Unsafe workspace root '${root}': symlink roots are not allowed.`,
        }),
      );
    const rootReal = yield* (yield* FileSystem.FileSystem).realPath(root);
    let current = rootReal;
    const relative = path.relative(root, workspacePath);
    for (const segment of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      if (!(yield* (yield* FileSystem.FileSystem).exists(current))) continue;
      const currentStat = yield* lstat(current);
      if (currentStat.isSymbolicLink())
        return yield* Effect.fail(
          new WorkspaceError({
            message: `Unsafe workspace path '${workspacePath}': symlink path component '${current}' is not allowed.`,
          }),
        );
      const currentReal = yield* (yield* FileSystem.FileSystem).realPath(
        current,
      );
      yield* checkWorkspaceInput(() => {
        assertPathInsideRoot({ root: rootReal, target: currentReal });
      });
    }
  },
);
export const resolveCloneRemote = Effect.fn("resolveCloneRemote")(
  function* (input: {
    cwd: string;
    cloneRemote?: string;
    runner?: ProcessRunner | undefined;
  }) {
    const runner = input.runner ?? runProcess;
    const remote = input.cloneRemote?.trim() ?? "origin";
    const remoteResult = yield* runner(["git", "remote", "get-url", remote], {
      cwd: input.cwd,
    });
    const url =
      remoteResult.exitCode === 0 && remoteResult.stdout.trim()
        ? remoteResult.stdout.trim()
        : remote;
    const preflight = yield* runner(["git", "ls-remote", url, "HEAD"], {
      cwd: input.cwd,
    });
    if (preflight.exitCode !== 0) {
      return yield* Effect.fail(
        new WorkspaceError({
          message: [
            `Unable to access clone remote '${remote}' (${url}).`,
            `Command: git ls-remote ${url} HEAD`,
            `Exit code: ${preflight.exitCode}`,
            `stderr: ${tail(preflight.stderr || preflight.stdout)}`,
            "Suggested fixes: check workspace.cloneRemote in .roark/config.json, verify the git remote URL, and ensure credentials allow cloning.",
          ].join("\n"),
        }),
      );
    }
    return { remote, url };
  },
);
export const resolvePrReviewCloneRemote = Effect.fn(
  "resolvePrReviewCloneRemote",
)(function* (input: {
  cwd: string;
  repo?: string | undefined;
  repositoryUrl?: string | undefined;
  runner?: ProcessRunner | undefined;
}): Effect.fn.Return<
  { remote: "origin"; url: string },
  WorkspaceFailure,
  WorkspaceRequirements
> {
  const runner = input.runner ?? runProcess;
  const repositoryUrl = input.repositoryUrl?.trim();
  const url =
    repositoryUrl && repositoryUrl.length > 0
      ? repositoryUrl
      : yield* checkWorkspaceInput(() => githubRepositoryUrl(input.repo));
  const preflight = yield* runner(["git", "ls-remote", url, "HEAD"], {
    cwd: input.cwd,
  });
  if (preflight.exitCode !== 0) {
    return yield* Effect.fail(
      new WorkspaceError({
        message: [
          `Unable to access PR repository '${input.repo ?? url}' (${url}).`,
          `Command: git ls-remote ${url} HEAD`,
          `Exit code: ${preflight.exitCode}`,
          `stderr: ${tail(preflight.stderr || preflight.stdout)}`,
          "Suggested fixes: verify --repo identifies the PR's base repository and ensure git credentials allow cloning it.",
        ].join("\n"),
      }),
    );
  }
  return { remote: "origin", url };
});
export const prepareCloneWorkspace = Effect.fn("prepareCloneWorkspace")(
  function* (input: {
    controlCwd: string;
    repo?: string | undefined;
    issueNumber: number;
    plan: AutorunBranchPlan;
    workspace: WorkspaceConfig;
    hooks: LifecycleHooksConfig;
    mode: "auto" | "continue";
    workspacePath?: string | undefined;
    runner?: ProcessRunner | undefined;
  }): Effect.fn.Return<
    PreparedWorkspace,
    WorkspaceFailure,
    WorkspaceRequirements
  > {
    const runner = input.runner ?? runProcess;
    const root = normalizeWorkspaceRoot(input.workspace.root);
    const workspacePath = path.resolve(
      input.workspacePath ??
        (yield* checkWorkspaceInput(() =>
          workspacePathForIssue({
            root,
            repo: input.repo,
            issueNumber: input.issueNumber,
            controlCwd: input.controlCwd,
          }),
        )),
    );
    yield* assertWorkspacePathSafe({ root, workspacePath });
    const remote = yield* resolveCloneRemote({
      cwd: input.controlCwd,
      cloneRemote: input.workspace.cloneRemote,
      runner,
    });
    const createdNow = !(yield* (yield* FileSystem.FileSystem).exists(
      workspacePath,
    ));
    if (createdNow) {
      yield* (yield* FileSystem.FileSystem).makeDirectory(
        path.dirname(workspacePath),
        { recursive: true },
      );
      const cloneArgs = buildCloneArgs({
        url: remote.url,
        target: workspacePath,
        clone: input.workspace.clone,
      });
      yield* runProcessOrThrowWithRunner(runner, cloneArgs, {
        cwd: input.controlCwd,
        label: "git clone",
      });
      yield* Effect.gen(function* () {
        yield* checkoutWorkspaceBranch({
          cwd: workspacePath,
          plan: input.plan,
          runner,
        });
        yield* refreshCopyToWorktree({
          controlCwd: input.controlCwd,
          worktreePath: workspacePath,
          copyToWorktree: input.workspace.copyToWorktree,
          runner,
        });
        yield* runLifecycleHook(
          "afterCreate",
          input.hooks,
          workspacePath,
          runner === runProcess ? executeProcess : runner,
        );
      }).pipe(
        Effect.onExit((exit) =>
          Exit.isFailure(exit)
            ? writePoisonState(workspacePath, exit.cause)
            : Effect.void,
        ),
      );
    } else {
      yield* assertNotPoisoned(workspacePath);
      yield* assertGitWorkspaceOnBranch({
        cwd: workspacePath,
        branchName: input.plan.branchName,
        runner,
      });
      if (
        input.mode === "auto" &&
        (yield* hasGitChanges(workspacePath, runner))
      ) {
        return yield* Effect.fail(
          new WorkspaceError({
            message: `Workspace '${workspacePath}' has uncommitted changes. Use 'roark continue ${input.issueNumber} --cwd ${input.controlCwd}' to recover a failed attempt, or clean/remove the workspace before starting fresh auto work.`,
          }),
        );
      }
      yield* refreshCopyToWorktree({
        controlCwd: input.controlCwd,
        worktreePath: workspacePath,
        copyToWorktree: input.workspace.copyToWorktree,
        runner,
      });
    }
    return {
      path: workspacePath,
      metadata: {
        path: workspacePath,
        strategy: "clone" as const,
        cloneRemote: remote.remote,
        cloneUrl: remote.url,
        createdNow,
      },
    };
  },
);
export const preparePrRevisionWorkspace = Effect.fn(
  "preparePrRevisionWorkspace",
)(function* (input: {
  controlCwd: string;
  repo?: string | undefined;
  prNumber: number;
  headRefName: string;
  workspace: WorkspaceConfig;
  hooks: LifecycleHooksConfig;
  workspacePath?: string | undefined;
  runner?: ProcessRunner | undefined;
}): Effect.fn.Return<
  PreparedPrRevisionWorkspace,
  WorkspaceFailure,
  WorkspaceRequirements | Scope.Scope
> {
  const runner = input.runner ?? runProcess;
  const root = normalizeWorkspaceRoot(input.workspace.root);
  const workspacePath = path.resolve(
    input.workspacePath ??
      (yield* checkWorkspaceInput(() =>
        workspacePathForPrRevision({
          root,
          repo: input.repo,
          prNumber: input.prNumber,
          controlCwd: input.controlCwd,
        }),
      )),
  );
  yield* assertWorkspacePathSafe({ root, workspacePath });
  yield* Effect.acquireRelease(acquireWorkspaceLock(workspacePath), (release) =>
    release().pipe(Effect.orDie),
  );
  return yield* Effect.gen(function* () {
    const remote = yield* resolveCloneRemote({
      cwd: input.controlCwd,
      cloneRemote: input.workspace.cloneRemote,
      runner,
    });
    const createdNow = !(yield* (yield* FileSystem.FileSystem).exists(
      workspacePath,
    ));
    if (createdNow) {
      yield* (yield* FileSystem.FileSystem).makeDirectory(
        path.dirname(workspacePath),
        { recursive: true },
      );
      yield* runProcessOrThrowWithRunner(
        runner,
        buildCloneArgs({
          url: remote.url,
          target: workspacePath,
          clone: input.workspace.clone,
        }),
        {
          cwd: input.controlCwd,
          label: "git clone",
        },
      );
      yield* Effect.gen(function* () {
        yield* checkoutPrWorkspaceBranch({
          cwd: workspacePath,
          headRefName: input.headRefName,
          runner,
        });
        yield* refreshCopyToWorktree({
          controlCwd: input.controlCwd,
          worktreePath: workspacePath,
          copyToWorktree: input.workspace.copyToWorktree,
          runner,
        });
        yield* runLifecycleHook(
          "afterCreate",
          input.hooks,
          workspacePath,
          runner === runProcess ? executeProcess : runner,
        );
      }).pipe(
        Effect.onExit((exit) =>
          Exit.isFailure(exit)
            ? writePoisonState(workspacePath, exit.cause)
            : Effect.void,
        ),
      );
    } else {
      yield* assertNotPoisoned(workspacePath);
      const insideWorkTree = yield* runner(
        ["git", "rev-parse", "--is-inside-work-tree"],
        { cwd: workspacePath },
      );
      if (
        insideWorkTree.exitCode !== 0 ||
        insideWorkTree.stdout.trim() !== "true"
      )
        return yield* Effect.fail(
          new WorkspaceError({
            message: `Workspace '${workspacePath}' is not a git work tree.`,
          }),
        );
      if (yield* hasGitChanges(workspacePath, runner))
        return yield* Effect.fail(
          new WorkspaceError({
            message: `Workspace '${workspacePath}' has uncommitted changes. Clean or remove it before revising PR #${input.prNumber}.`,
          }),
        );
      yield* checkoutPrWorkspaceBranch({
        cwd: workspacePath,
        headRefName: input.headRefName,
        runner,
      });
      yield* refreshCopyToWorktree({
        controlCwd: input.controlCwd,
        worktreePath: workspacePath,
        copyToWorktree: input.workspace.copyToWorktree,
        runner,
      });
    }
    return {
      path: workspacePath,
      metadata: {
        path: workspacePath,
        strategy: "clone" as const,
        cloneRemote: remote.remote,
        cloneUrl: remote.url,
        createdNow,
      },
    };
  });
});
export const preparePrReviewWorkspace = Effect.fn("preparePrReviewWorkspace")(
  function* (input: {
    controlCwd: string;
    repo?: string | undefined;
    repositoryUrl?: string | undefined;
    prNumber: number;
    baseRefName: string;
    baseRefOid: string;
    headRefOid: string;
    workspace: WorkspaceConfig;
    hooks: LifecycleHooksConfig;
    workspacePath?: string | undefined;
    runner?: ProcessRunner | undefined;
  }): Effect.fn.Return<
    PreparedPrReviewWorkspace,
    WorkspaceFailure,
    WorkspaceRequirements | Scope.Scope
  > {
    if (!input.baseRefOid || !input.headRefOid) {
      return yield* Effect.fail(
        new WorkspaceError({
          message: `PR #${input.prNumber} metadata did not include immutable base and head commit identifiers.`,
        }),
      );
    }
    const runner = input.runner ?? runProcess;
    const root = normalizeWorkspaceRoot(input.workspace.root);
    const workspacePath = path.resolve(
      input.workspacePath ??
        (yield* checkWorkspaceInput(() =>
          workspacePathForPrRevision({
            root,
            repo: input.repo,
            prNumber: input.prNumber,
            controlCwd: input.controlCwd,
          }),
        )),
    );
    yield* assertWorkspacePathSafe({ root, workspacePath });
    yield* Effect.acquireRelease(
      acquireWorkspaceLock(workspacePath),
      (release) => release().pipe(Effect.orDie),
    );
    return yield* Effect.gen(function* () {
      const remote = yield* resolvePrReviewCloneRemote({
        cwd: input.controlCwd,
        repo: input.repo,
        repositoryUrl: input.repositoryUrl,
        runner,
      });
      const createdNow = !(yield* (yield* FileSystem.FileSystem).exists(
        workspacePath,
      ));
      if (createdNow) {
        yield* (yield* FileSystem.FileSystem).makeDirectory(
          path.dirname(workspacePath),
          { recursive: true },
        );
        yield* runProcessOrThrowWithRunner(
          runner,
          buildCloneArgs({
            url: remote.url,
            target: workspacePath,
            clone: input.workspace.clone,
          }),
          {
            cwd: input.controlCwd,
            label: "git clone",
          },
        );
      } else {
        yield* assertNotPoisoned(workspacePath);
        const insideWorkTree = yield* runner(
          ["git", "rev-parse", "--is-inside-work-tree"],
          { cwd: workspacePath },
        );
        if (
          insideWorkTree.exitCode !== 0 ||
          insideWorkTree.stdout.trim() !== "true"
        )
          return yield* Effect.fail(
            new WorkspaceError({
              message: `Workspace '${workspacePath}' is not a git work tree.`,
            }),
          );
        if (yield* hasGitChanges(workspacePath, runner))
          return yield* Effect.fail(
            new WorkspaceError({
              message: `Workspace '${workspacePath}' has uncommitted changes. Clean or remove it before reviewing PR #${input.prNumber}.`,
            }),
          );
        yield* runProcessOrThrowWithRunner(
          runner,
          ["git", "remote", "set-url", "origin", remote.url],
          {
            cwd: workspacePath,
            label: "git set PR review origin",
          },
        );
      }
      return yield* Effect.gen(function* () {
        const comparison = yield* checkoutPinnedPrReview({
          cwd: workspacePath,
          prNumber: input.prNumber,
          baseRefName: input.baseRefName,
          baseRefOid: input.baseRefOid,
          headRefOid: input.headRefOid,
          runner,
        });
        yield* refreshCopyToWorktree({
          controlCwd: input.controlCwd,
          worktreePath: workspacePath,
          copyToWorktree: input.workspace.copyToWorktree,
          runner,
        });
        if (createdNow)
          yield* runLifecycleHook(
            "afterCreate",
            input.hooks,
            workspacePath,
            runner === runProcess ? executeProcess : runner,
          );
        yield* assertPinnedPrReviewWorkspace({
          cwd: workspacePath,
          headOid: input.headRefOid,
          runner,
        });
        return {
          path: workspacePath,
          comparison,
          metadata: {
            path: workspacePath,
            strategy: "clone" as const,
            cloneRemote: remote.remote,
            cloneUrl: remote.url,
            createdNow,
          },
        };
      }).pipe(
        Effect.onExit((exit) =>
          Exit.isFailure(exit) &&
          createdNow &&
          (Cause.hasDies(exit.cause) ||
            Cause.hasInterrupts(exit.cause) ||
            !(Cause.squash(exit.cause) instanceof PrReviewHeadChangedError))
            ? writePoisonState(workspacePath, exit.cause)
            : Effect.void,
        ),
      );
    });
  },
);
function githubRepositoryUrl(repo: string | undefined): string {
  const normalized = repo?.trim();
  if (!normalized || !/^[^/\s]+\/[^/\s]+$/.test(normalized)) {
    throw new WorkspaceError({
      message:
        "Cannot resolve the PR repository clone URL. Pass --repo owner/repo.",
    });
  }
  return `https://github.com/${normalized}.git`;
}
export const assertPinnedPrReviewWorkspace = Effect.fn(
  "assertPinnedPrReviewWorkspace",
)(function* (input: {
  cwd: string;
  headOid: string;
  runner?: ProcessRunner | undefined;
}) {
  const runner = input.runner ?? runProcess;
  const currentHead = (yield* runProcessOrThrowWithRunner(
    runner,
    ["git", "rev-parse", "HEAD"],
    {
      cwd: input.cwd,
      label: "git rev-parse review HEAD",
    },
  )).trim();
  if (currentHead !== input.headOid) {
    return yield* Effect.fail(
      new WorkspaceError({
        message: `PR review workspace HEAD changed from pinned commit ${input.headOid} to ${currentHead || "(unknown)"}. Refusing to publish this review.`,
      }),
    );
  }
  const status = yield* runner(
    ["git", "status", "--porcelain", "--untracked-files=all"],
    { cwd: input.cwd },
  );
  if (status.exitCode !== 0)
    return yield* Effect.fail(
      new WorkspaceError({
        message: `Unable to verify PR review workspace cleanliness: ${tail(status.stderr || status.stdout)}`,
      }),
    );
  if (status.stdout.trim()) {
    return yield* Effect.fail(
      new WorkspaceError({
        message: `PR review workspace changed during inspection. Refusing to publish this review.\n${status.stdout.trim()}`,
      }),
    );
  }
});
const checkoutPinnedPrReview = Effect.fn("checkoutPinnedPrReview")(
  function* (input: {
    cwd: string;
    prNumber: number;
    baseRefName: string;
    baseRefOid: string;
    headRefOid: string;
    runner: ProcessRunner;
  }) {
    const baseReviewRef = `refs/remotes/roark/pr-${input.prNumber}-base`;
    const headReviewRef = `refs/remotes/roark/pr-${input.prNumber}-head`;
    yield* runProcessOrThrowWithRunner(
      input.runner,
      [
        "git",
        "fetch",
        "origin",
        `+refs/heads/${input.baseRefName}:${baseReviewRef}`,
      ],
      {
        cwd: input.cwd,
        label: "git fetch PR base",
      },
    );
    yield* runProcessOrThrowWithRunner(
      input.runner,
      [
        "git",
        "fetch",
        "origin",
        `+refs/pull/${input.prNumber}/head:${headReviewRef}`,
      ],
      {
        cwd: input.cwd,
        label: "git fetch GitHub PR head",
      },
    );
    const fetchedHead = (yield* runProcessOrThrowWithRunner(
      input.runner,
      ["git", "rev-parse", headReviewRef],
      { cwd: input.cwd, label: "git rev-parse PR head" },
    )).trim();
    if (fetchedHead !== input.headRefOid) {
      return yield* Effect.fail(
        new PrReviewHeadChangedError({
          message: `PR #${input.prNumber} changed while its review workspace was prepared (expected ${input.headRefOid}, fetched ${fetchedHead}).`,
        }),
      );
    }
    yield* assertFetchedOid(input.runner, input.cwd, input.baseRefOid, "base");
    yield* assertFetchedOid(input.runner, input.cwd, input.headRefOid, "head");
    yield* ensureCompleteHistory(input.runner, input.cwd, input.prNumber);
    const mergeBaseResult = yield* input.runner(
      ["git", "merge-base", input.baseRefOid, input.headRefOid],
      { cwd: input.cwd },
    );
    const mergeBaseOid = mergeBaseResult.stdout.trim();
    if (mergeBaseResult.exitCode !== 0 || !mergeBaseOid) {
      return yield* Effect.fail(
        new WorkspaceError({
          message: `Could not determine merge base for PR #${input.prNumber} after ensuring complete clone history: ${tail(mergeBaseResult.stderr || mergeBaseResult.stdout) || "no common ancestor was available"}`,
        }),
      );
    }
    yield* runProcessOrThrowWithRunner(
      input.runner,
      ["git", "checkout", "--detach", input.headRefOid],
      { cwd: input.cwd, label: "git checkout pinned PR head" },
    );
    const changedFiles = (yield* runProcessOrThrowWithRunner(
      input.runner,
      [
        "git",
        "diff",
        "--name-only",
        `${mergeBaseOid}..${input.headRefOid}`,
        "--",
      ],
      {
        cwd: input.cwd,
        label: "git diff PR changed files",
      },
    ))
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean);
    const diffStat = (yield* runProcessOrThrowWithRunner(
      input.runner,
      ["git", "diff", "--stat", `${mergeBaseOid}..${input.headRefOid}`, "--"],
      {
        cwd: input.cwd,
        label: "git diff PR stat",
      },
    )).trim();
    return {
      baseOid: input.baseRefOid,
      headOid: input.headRefOid,
      mergeBaseOid,
      changedFiles,
      diffStat,
      inspectionCommand: `git diff ${mergeBaseOid}..${input.headRefOid} --`,
    };
  },
);
const ensureCompleteHistory = Effect.fn("ensureCompleteHistory")(function* (
  runner: ProcessRunner,
  cwd: string,
  prNumber: number,
) {
  let shallow = yield* runner(["git", "rev-parse", "--is-shallow-repository"], {
    cwd,
  });
  if (shallow.exitCode !== 0) {
    return yield* Effect.fail(
      new WorkspaceError({
        message: `Unable to inspect clone history before calculating the merge base for PR #${prNumber}: ${tail(shallow.stderr || shallow.stdout)}`,
      }),
    );
  }
  if (shallow.stdout.trim() !== "true") return;
  const unshallow = yield* runner(["git", "fetch", "--unshallow", "origin"], {
    cwd,
  });
  if (unshallow.exitCode !== 0) {
    return yield* Effect.fail(
      new WorkspaceError({
        message: `Unable to fetch complete history for shallow PR review workspace #${prNumber}: ${tail(unshallow.stderr || unshallow.stdout)}`,
      }),
    );
  }
  shallow = yield* runner(["git", "rev-parse", "--is-shallow-repository"], {
    cwd,
  });
  if (shallow.exitCode !== 0 || shallow.stdout.trim() === "true") {
    return yield* Effect.fail(
      new WorkspaceError({
        message: `PR review workspace #${prNumber} remains shallow after fetching complete history; its merge base cannot be calculated reliably.`,
      }),
    );
  }
});
const assertFetchedOid = Effect.fn("assertFetchedOid")(function* (
  runner: ProcessRunner,
  cwd: string,
  oid: string,
  label: string,
) {
  let result = yield* runner(["git", "cat-file", "-e", `${oid}^{commit}`], {
    cwd,
  });
  if (result.exitCode !== 0) {
    result = yield* runner(["git", "fetch", "origin", oid], { cwd });
    if (result.exitCode !== 0)
      return yield* Effect.fail(
        new WorkspaceError({
          message: `Unable to fetch pinned PR ${label} commit ${oid}: ${tail(result.stderr || result.stdout)}`,
        }),
      );
    result = yield* runner(["git", "cat-file", "-e", `${oid}^{commit}`], {
      cwd,
    });
  }
  if (result.exitCode !== 0)
    return yield* Effect.fail(
      new WorkspaceError({
        message: `Pinned PR ${label} commit ${oid} is unavailable after fetch.`,
      }),
    );
});
export const refreshCopyToWorktree = Effect.fn("refreshCopyToWorktree")(
  function* (input: {
    controlCwd: string;
    worktreePath: string;
    copyToWorktree?: readonly string[] | undefined;
    runner?: ProcessRunner | undefined;
  }) {
    const entries = input.copyToWorktree ?? [];
    if (entries.length === 0) return;
    const runner = input.runner ?? runProcess;
    const preflight: {
      entry: string;
      source: string;
      destination: string;
    }[] = [];
    for (const rawEntry of entries) {
      const entry = yield* decodeCopyToWorktreeEntry(rawEntry);
      const source = path.resolve(input.controlCwd, entry);
      const destination = path.resolve(input.worktreePath, entry);
      yield* checkWorkspaceInput(() => {
        assertPathInsideRoot({
          root: path.resolve(input.controlCwd),
          target: source,
        });
      });
      yield* checkWorkspaceInput(() => {
        assertPathInsideRoot({
          root: path.resolve(input.worktreePath),
          target: destination,
        });
      });
      yield* assertCopyDestinationParentsSafe({
        worktreePath: input.worktreePath,
        destination,
        entry,
      });
      yield* Effect.gen(function* () {
        yield* (yield* FileSystem.FileSystem).stat(source);
      }).pipe(
        Effect.catch(
          Effect.fnUntraced(function* () {
            return yield* Effect.fail(
              new WorkspaceError({
                message: `Configured workspace.copyToWorktree source '${entry}' is missing at '${source}'.`,
              }),
            );
          }),
        ),
      );
      const ignored = yield* runner(
        ["git", "check-ignore", "--quiet", "--", entry],
        { cwd: input.worktreePath },
      );
      if (ignored.exitCode !== 0) {
        const detail =
          ignored.exitCode === 1
            ? "path is not ignored"
            : `git check-ignore failed: ${tail(ignored.stderr || ignored.stdout) || "(empty)"}`;
        return yield* Effect.fail(
          new WorkspaceError({
            message: `Refusing to copy workspace.copyToWorktree path '${entry}': destination must be ignored by Git in '${input.worktreePath}' (${detail}).`,
          }),
        );
      }
      preflight.push({ entry, source, destination });
    }
    for (const item of preflight) {
      yield* (yield* FileSystem.FileSystem).remove(item.destination, {
        recursive: true,
        force: true,
      });
      yield* copyDereferenced(item.source, item.destination);
      const status = yield* runner(
        ["git", "status", "--porcelain", "--", item.entry],
        { cwd: input.worktreePath },
      );
      if (status.exitCode !== 0) {
        return yield* Effect.fail(
          new WorkspaceError({
            message: `git status check failed after copying workspace.copyToWorktree path '${item.entry}': ${tail(status.stderr || status.stdout)}`,
          }),
        );
      }
      if (status.stdout.trim() !== "") {
        return yield* Effect.fail(
          new WorkspaceError({
            message: `Refusing copied workspace.copyToWorktree path '${item.entry}': copied destination is visible to Git.\n${status.stdout.trim()}`,
          }),
        );
      }
    }
  },
);
const assertCopyDestinationParentsSafe = Effect.fn(
  "assertCopyDestinationParentsSafe",
)(function* (input: {
  worktreePath: string;
  destination: string;
  entry: string;
}) {
  const root = path.resolve(input.worktreePath);
  const destination = path.resolve(input.destination);
  yield* checkWorkspaceInput(() => {
    assertPathInsideRoot({ root, target: destination });
  });
  const rootStat = yield* lstat(root);
  if (rootStat.isSymbolicLink())
    return yield* Effect.fail(
      new WorkspaceError({
        message: `Refusing to copy workspace.copyToWorktree path '${input.entry}': worktree path '${root}' is a symlink.`,
      }),
    );
  const rootReal = yield* (yield* FileSystem.FileSystem).realPath(root);
  let current = root;
  const relativeParent = path.relative(root, path.dirname(destination));
  for (const segment of relativeParent.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const currentStat = yield* lstat(current).pipe(
      Effect.catch((error) =>
        Predicate.hasProperty(error.cause, "code") &&
        error.cause.code === "ENOENT"
          ? Effect.succeed(undefined)
          : Effect.fail(error),
      ),
    );
    if (!currentStat) break;
    if (currentStat.isSymbolicLink()) {
      return yield* Effect.fail(
        new WorkspaceError({
          message: `Refusing to copy workspace.copyToWorktree path '${input.entry}': destination parent '${current}' is a symlink.`,
        }),
      );
    }
    const currentReal = yield* (yield* FileSystem.FileSystem).realPath(current);
    yield* checkWorkspaceInput(() => {
      assertPathInsideRoot({ root: rootReal, target: currentReal });
    });
  }
});
const copyDereferenced = Effect.fn("copyDereferenced")(function* (
  source: string,
  destination: string,
): Effect.fn.Return<
  void,
  WorkspaceError | PlatformError.PlatformError,
  FileSystem.FileSystem
> {
  const sourceStat = yield* (yield* FileSystem.FileSystem).stat(source);
  const mode = sourceStat.mode & 0o7777;
  if (sourceStat.type === "Directory") {
    yield* (yield* FileSystem.FileSystem).makeDirectory(destination, {
      recursive: true,
      mode,
    });
    yield* (yield* FileSystem.FileSystem).chmod(destination, mode);
    const entries = yield* (yield* FileSystem.FileSystem).readDirectory(source);
    for (const entry of entries) {
      yield* copyDereferenced(
        path.join(source, entry),
        path.join(destination, entry),
      );
    }
    yield* (yield* FileSystem.FileSystem).chmod(destination, mode);
    return;
  }
  if (sourceStat.type === "File") {
    yield* (yield* FileSystem.FileSystem).makeDirectory(
      path.dirname(destination),
      { recursive: true },
    );
    yield* (yield* FileSystem.FileSystem).copyFile(source, destination);
    yield* (yield* FileSystem.FileSystem).chmod(destination, mode);
    return;
  }
  return yield* Effect.fail(
    new WorkspaceError({
      message: `Cannot copy workspace.copyToWorktree source '${source}': unsupported file type.`,
    }),
  );
});
export const runLifecycleHook = Effect.fn("runLifecycleHook")(function* (
  name: keyof LifecycleHooksConfig,
  hooks: LifecycleHooksConfig | undefined,
  cwd: string,
  runner: ProcessRunner = executeProcess,
) {
  const command = typeof hooks?.[name] === "string" ? hooks[name].trim() : "";
  if (!command) return;
  const timeoutMs = hooks?.timeoutMs ?? defaultLifecycleHooks.timeoutMs;
  const result = yield* runner(["sh", "-lc", command], {
    cwd,
    timeoutMs,
  });
  const presentation = yield* Presentation;
  if (result.timedOut !== true && result.exitCode === 0) return;
  const detail =
    result.timedOut === true
      ? `${result.stderr}\nTimed out after ${timeoutMs}ms.`
      : result.stderr;
  const message = `${name} hook failed with exit code ${result.exitCode}: ${command}\n${tail(detail || result.stdout)}`;
  if (name === "afterRun" || name === "beforeRemove") {
    presentation.warning(message);
    return;
  }
  return yield* Effect.fail(
    new WorkspaceHookError(message, {
      hook: name,
      command,
      result: { ...result, stderr: detail },
    }),
  );
});
export class WorkspaceHookError extends Schema.TaggedError<WorkspaceHookError>()(
  "WorkspaceHookError",
  {
    message: Schema.String,
    hook: Schema.String,
    command: Schema.String,
    result: Schema.Struct({
      exitCode: Schema.Number,
      stdout: Schema.String,
      stderr: Schema.String,
    }),
  },
) {
  constructor(
    message: string,
    options: { hook: string; command: string; result: ProcessResult },
  ) {
    super({ message, ...options });
  }
}
export const listManagedWorkspaces = Effect.fn("listManagedWorkspaces")(
  function* (options: {
    workspace: WorkspaceConfig;
    repo?: string | undefined;
    cwd?: string | undefined;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const repoRoot = path.dirname(
      yield* checkWorkspaceInput(() =>
        workspacePathForIssue({
          root: options.workspace.root,
          repo: options.repo,
          issueNumber: 1,
          controlCwd: options.cwd,
        }),
      ),
    );
    if (!(yield* fs.exists(repoRoot))) return [];
    const result: ManagedWorkspace[] = [];
    for (const entry of yield* fs.readDirectory(repoRoot)) {
      const fullPath = path.join(repoRoot, entry);
      // Follow the former Dirent behavior: do not list symlinked workspaces.
      const info = yield* lstat(fullPath);
      if (!info.isDirectory()) continue;
      const match = /^(issue|pr)-([1-9]\d*)$/.exec(entry);
      if (!match) continue;
      const number = Number(match[2]);
      if (!Number.isSafeInteger(number)) continue;
      result.push({
        path: fullPath,
        target: { kind: match[1] === "pr" ? "pr" : "issue", number },
      });
    }
    return result.toSorted((a, b) => a.path.localeCompare(b.path));
  },
);
export const listWorkspaces = Effect.fn("listWorkspaces")(function* (options: {
  workspace: WorkspaceConfig;
  repo?: string | undefined;
  cwd?: string | undefined;
}) {
  return (yield* listManagedWorkspaces(options)).map(
    (managedWorkspace) => managedWorkspace.path,
  );
});
export const runWorkspaceCommand = Effect.fn("runWorkspaceCommand")(function* (
  options: WorkspaceCommandOptions,
) {
  if (options.action === "list") {
    const paths = yield* listWorkspaces({
      workspace: options.workspace,
      repo: options.repo,
      cwd: options.cwd,
    });
    if (paths.length === 0) console.log("No managed workspaces found.");
    else for (const workspacePath of paths) console.log(workspacePath);
    return;
  }
  const olderThanMs = yield* checkWorkspaceInput(() =>
    parseDurationMs(options.olderThan),
  );
  const cutoff = (yield* Clock.currentTimeMillis) - olderThanMs;
  const paths = yield* listWorkspaces({
    workspace: options.workspace,
    repo: options.repo,
    cwd: options.cwd,
  });
  let removed = 0;
  for (const workspacePath of paths) {
    const stats = yield* (yield* FileSystem.FileSystem).stat(workspacePath);
    if (Option.isSome(stats.mtime) && stats.mtime.value.getTime() > cutoff)
      continue;
    if (
      yield* removeWorkspace({
        workspacePath,
        force: options.force,
        hooks: options.hooks,
      })
    )
      removed++;
  }
  console.log(`Pruned ${removed} workspace(s).`);
});
export const runRemoveCommand = Effect.fn("runRemoveCommand")(function* (
  options: RemoveCommandOptions,
) {
  if (options.targets.length === 0)
    return yield* Effect.fail(
      new WorkspaceError({
        message: "No managed workspaces selected for removal.",
      }),
    );
  const paths = [
    ...new Set(
      options.targets.map((target) =>
        target.kind === "issue"
          ? workspacePathForIssue({
              root: options.workspace.root,
              repo: options.repo,
              issueNumber: target.number,
              controlCwd: options.cwd,
            })
          : workspacePathForPrRevision({
              root: options.workspace.root,
              repo: options.repo,
              prNumber: target.number,
              controlCwd: options.cwd,
            }),
      ),
    ),
  ];
  const fs = yield* FileSystem.FileSystem;
  const missingPaths = yield* Effect.filter(paths, (path) =>
    fs.exists(path).pipe(Effect.map((exists) => !exists)),
  );
  if (missingPaths.length > 0) {
    return yield* Effect.fail(
      new WorkspaceError({
        message: `Managed workspace${missingPaths.length === 1 ? "" : "s"} not found:\n${missingPaths.join("\n")}`,
      }),
    );
  }
  if (!options.force) {
    const dirtyPaths: string[] = [];
    for (const workspacePath of paths) {
      if (yield* hasGitChanges(workspacePath, runProcess))
        dirtyPaths.push(workspacePath);
    }
    if (dirtyPaths.length > 0) {
      return yield* Effect.fail(
        new WorkspaceError({
          message: `Refusing to remove dirty workspace${dirtyPaths.length === 1 ? "" : "s"}:\n${dirtyPaths.join("\n")}\nPass --force to remove ${dirtyPaths.length === 1 ? "it" : "them"} anyway.`,
        }),
      );
    }
  }
  for (const workspacePath of paths) {
    if (
      !(yield* removeWorkspaceFiles({ workspacePath, hooks: options.hooks }))
    ) {
      return yield* Effect.fail(
        new WorkspaceError({
          message: `Managed workspace disappeared before it could be removed: ${workspacePath}`,
        }),
      );
    }
    console.log(`Removed workspace: ${workspacePath}`);
  }
});
export const removeWorkspace = Effect.fn("removeWorkspace")(function* (input: {
  workspacePath: string;
  force: boolean;
  hooks: LifecycleHooksConfig;
}) {
  const legacyLockPath = `${input.workspacePath}.lock`;
  if (!(yield* (yield* FileSystem.FileSystem).exists(input.workspacePath))) {
    yield* (yield* FileSystem.FileSystem).remove(legacyLockPath, {
      recursive: true,
      force: true,
    });
    return false;
  }
  if (!input.force && (yield* hasGitChanges(input.workspacePath, runProcess))) {
    return yield* Effect.fail(
      new WorkspaceError({
        message: `Refusing to remove dirty workspace '${input.workspacePath}'. Pass --force to remove it anyway.`,
      }),
    );
  }
  return yield* removeWorkspaceFiles({
    workspacePath: input.workspacePath,
    hooks: input.hooks,
  });
});
const removeWorkspaceFiles = Effect.fn("removeWorkspaceFiles")(
  function* (input: { workspacePath: string; hooks: LifecycleHooksConfig }) {
    if (!(yield* (yield* FileSystem.FileSystem).exists(input.workspacePath)))
      return false;
    const legacyLockPath = `${input.workspacePath}.lock`;
    yield* runLifecycleHook("beforeRemove", input.hooks, input.workspacePath);
    yield* (yield* FileSystem.FileSystem).remove(input.workspacePath, {
      recursive: true,
      force: true,
    });
    yield* (yield* FileSystem.FileSystem).remove(legacyLockPath, {
      recursive: true,
      force: true,
    });
    return true;
  },
);
const acquireWorkspaceLock = Effect.fn("acquireWorkspaceLock")(function* (
  workspacePath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const lockDir = `${workspacePath}.lock`;
  const token = crypto.randomUUID();
  yield* fs.makeDirectory(path.dirname(lockDir), { recursive: true });
  for (;;) {
    const created = yield* fs.makeDirectory(lockDir).pipe(
      Effect.as(true),
      Effect.catch((error) =>
        error.reason._tag === "AlreadyExists"
          ? Effect.succeed(false)
          : Effect.fail(error),
      ),
    );
    if (!created) {
      if (yield* removeStaleWorkspaceLock(lockDir)) continue;
      return yield* new WorkspaceError({
        message: `Workspace '${workspacePath}' is already locked (lock: ${lockDir}).`,
      });
    }
    const owner = {
      token,
      pid: process.pid,
      createdAt: DateTime.formatIso(yield* DateTime.now),
    };
    yield* fs
      .writeFileString(
        path.join(lockDir, "owner.json"),
        JSON.stringify(owner, null, 2),
      )
      .pipe(
        Effect.onError(() =>
          fs
            .remove(lockDir, { recursive: true, force: true })
            .pipe(Effect.orDie),
        ),
      );
    return Effect.fnUntraced(function* () {
      const owner = yield* readWorkspaceLockOwner(lockDir);
      if (Option.isNone(owner) || owner.value.token !== token) return;
      yield* fs.remove(lockDir, { recursive: true, force: true });
    });
  }
}, Effect.uninterruptible);

const readWorkspaceLockOwner = Effect.fnUntraced(function* (lockDir: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs
    .readFileString(path.join(lockDir, "owner.json"))
    .pipe(Effect.flatMap(decodeLockOwner), Effect.option);
});
const removeStaleWorkspaceLock = Effect.fnUntraced(function* (lockDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const owner = yield* readWorkspaceLockOwner(lockDir);
  if (Option.isSome(owner)) {
    if (isProcessAlive(owner.value.pid)) return false;
  } else {
    // Allow a new owner time to write its identity after creating the directory.
    const info = yield* fs.stat(lockDir).pipe(Effect.option);
    if (Option.isNone(info) || Option.isNone(info.value.mtime)) return false;
    const age =
      (yield* Clock.currentTimeMillis) - info.value.mtime.value.getTime();
    if (age < ownerlessLockGraceMs) return false;
  }
  yield* fs.remove(lockDir, {
    recursive: true,
    force: true,
  });
  return true;
});
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(Predicate.hasProperty(error, "code") && error.code === "ESRCH");
  }
}

const checkoutWorkspaceBranch = Effect.fn("checkoutWorkspaceBranch")(
  function* (input: {
    cwd: string;
    plan: AutorunBranchPlan;
    runner: ProcessRunner;
  }) {
    yield* runProcessOrThrowWithRunner(
      input.runner,
      ["git", "fetch", "origin"],
      { cwd: input.cwd, label: "git fetch origin" },
    );
    const remoteBranch = yield* gitRemoteBranchExists({
      cwd: input.cwd,
      branchName: input.plan.branchName,
      runner: input.runner,
    });
    if (remoteBranch) {
      yield* runProcessOrThrowWithRunner(
        input.runner,
        [
          "git",
          "checkout",
          "-B",
          input.plan.branchName,
          `origin/${input.plan.branchName}`,
        ],
        { cwd: input.cwd, label: "git checkout issue branch" },
      );
    } else {
      yield* runProcessOrThrowWithRunner(
        input.runner,
        [
          "git",
          "checkout",
          "-B",
          input.plan.branchName,
          `origin/${input.plan.baseBranch}`,
        ],
        { cwd: input.cwd, label: "git checkout issue branch from base" },
      );
    }
  },
);
const checkoutPrWorkspaceBranch = Effect.fn("checkoutPrWorkspaceBranch")(
  function* (input: {
    cwd: string;
    headRefName: string;
    runner: ProcessRunner;
  }) {
    yield* runProcessOrThrowWithRunner(
      input.runner,
      [
        "git",
        "fetch",
        "origin",
        `+refs/heads/${input.headRefName}:refs/remotes/origin/${input.headRefName}`,
      ],
      {
        cwd: input.cwd,
        label: "git fetch PR head",
      },
    );
    yield* assertNoUnpushedBranchCommits({
      cwd: input.cwd,
      branchName: input.headRefName,
      upstreamRef: `origin/${input.headRefName}`,
      runner: input.runner,
    });
    yield* runProcessOrThrowWithRunner(
      input.runner,
      [
        "git",
        "checkout",
        "-B",
        input.headRefName,
        `origin/${input.headRefName}`,
      ],
      {
        cwd: input.cwd,
        label: "git checkout PR head",
      },
    );
  },
);
const assertNoUnpushedBranchCommits = Effect.fn(
  "assertNoUnpushedBranchCommits",
)(function* (input: {
  cwd: string;
  branchName: string;
  upstreamRef: string;
  runner: ProcessRunner;
}) {
  const localBranch = yield* input.runner(
    [
      "git",
      "show-ref",
      "--verify",
      "--quiet",
      `refs/heads/${input.branchName}`,
    ],
    { cwd: input.cwd },
  );
  if (localBranch.exitCode !== 0) return;
  const ahead = yield* input.runner(
    [
      "git",
      "rev-list",
      "--count",
      input.branchName,
      "--not",
      input.upstreamRef,
    ],
    { cwd: input.cwd },
  );
  if (ahead.exitCode !== 0)
    return yield* Effect.fail(
      new WorkspaceError({
        message: `Unable to inspect local commits on '${input.branchName}': ${tail(ahead.stderr || ahead.stdout)}`,
      }),
    );
  const aheadCount = Number(ahead.stdout.trim());
  if (!Number.isFinite(aheadCount))
    return yield* Effect.fail(
      new WorkspaceError({
        message: `Unable to inspect local commits on '${input.branchName}': unexpected rev-list output '${ahead.stdout.trim()}'.`,
      }),
    );
  if (aheadCount > 0) {
    return yield* Effect.fail(
      new WorkspaceError({
        message: `Workspace '${input.cwd}' has ${aheadCount} unpushed local commit(s) on '${input.branchName}'. Refusing to reset it to '${input.upstreamRef}'. Push, remove, or repair the workspace before revising this PR.`,
      }),
    );
  }
});
const assertGitWorkspaceOnBranch = Effect.fn("assertGitWorkspaceOnBranch")(
  function* (input: {
    cwd: string;
    branchName: string;
    runner: ProcessRunner;
  }) {
    const result = yield* input.runner(
      ["git", "rev-parse", "--is-inside-work-tree"],
      { cwd: input.cwd },
    );
    if (result.exitCode !== 0 || result.stdout.trim() !== "true")
      return yield* Effect.fail(
        new WorkspaceError({
          message: `Workspace '${input.cwd}' is not a git work tree.`,
        }),
      );
    const currentBranch = (yield* runProcessOrThrowWithRunner(
      input.runner,
      ["git", "branch", "--show-current"],
      { cwd: input.cwd, label: "git branch --show-current" },
    )).trim();
    if (currentBranch !== input.branchName)
      return yield* Effect.fail(
        new WorkspaceError({
          message: `Workspace '${input.cwd}' is on branch '${currentBranch || "(detached)"}', expected '${input.branchName}'.`,
        }),
      );
  },
);
const assertNotPoisoned = Effect.fn("assertNotPoisoned")(function* (
  workspacePath: string,
) {
  const sentinel = path.join(workspacePath, workspaceStateFile);
  if (!(yield* (yield* FileSystem.FileSystem).exists(sentinel))) return;
  const detail = yield* (yield* FileSystem.FileSystem)
    .readFileString(sentinel)
    .pipe(Effect.catch(() => Effect.succeed("")));
  return yield* Effect.fail(
    new WorkspaceError({
      message: `Workspace '${workspacePath}' is marked poisoned by a failed lifecycle hook. Remove or repair the workspace before reusing it.\n${detail}`,
    }),
  );
});
const writePoisonState = Effect.fn("writePoisonState")(function* (
  workspacePath: string,
  cause: Cause.Cause<unknown>,
) {
  const error = Cause.squash(cause);
  yield* (yield* FileSystem.FileSystem).makeDirectory(workspacePath, {
    recursive: true,
  });

  const payload: Record<string, unknown> = {
    failedAt: DateTime.formatIso(yield* DateTime.now),
    message:
      Cause.prettyErrors(cause)
        .map((error) => error.message)
        .join("\n") || "Interrupted.",
  };
  if (error instanceof WorkspaceHookError) {
    payload["hook"] = error.hook;
    payload["command"] = error.command;
    payload["exitCode"] = error.result.exitCode;
    payload["stdoutTail"] = tail(error.result.stdout);
    payload["stderrTail"] = tail(error.result.stderr);
  }
  yield* (yield* FileSystem.FileSystem).writeFileString(
    path.join(workspacePath, workspaceStateFile),
    `${JSON.stringify(payload, null, 2)}\n`,
  );
});
const hasGitChanges = Effect.fn("hasGitChanges")(function* (
  cwd: string,
  runner: ProcessRunner,
) {
  const result = yield* runner(["git", "status", "--porcelain"], { cwd });
  if (result.exitCode !== 0)
    return yield* Effect.fail(
      new WorkspaceError({
        message: `git status --porcelain failed with exit code ${result.exitCode}:\n${result.stderr || result.stdout}`,
      }),
    );
  return result.stdout.trim() !== "";
});
const gitRemoteBranchExists = Effect.fn("gitRemoteBranchExists")(
  function* (input: {
    cwd: string;
    branchName: string;
    runner: ProcessRunner;
  }) {
    const result = yield* input.runner(
      [
        "git",
        "show-ref",
        "--verify",
        "--quiet",
        `refs/remotes/origin/${input.branchName}`,
      ],
      { cwd: input.cwd },
    );
    return result.exitCode === 0;
  },
);
const runProcessOrThrowWithRunner = Effect.fn("runProcessOrThrowWithRunner")(
  function* (
    runner: ProcessRunner,
    args: string[],
    options: {
      cwd?: string | undefined;
      label?: string;
    },
  ) {
    if (runner === runProcess) return yield* runProcessOrThrow(args, options);
    const result = yield* runner(args, { cwd: options.cwd });
    if (result.exitCode !== 0)
      return yield* Effect.fail(
        new WorkspaceError({
          message: `${options.label ?? args.join(" ")} failed with exit code ${result.exitCode}:\n${result.stderr || result.stdout}`,
        }),
      );
    return result.stdout;
  },
);
function buildCloneArgs(input: {
  url: string;
  target: string;
  clone: WorkspaceCloneConfig;
}): string[] {
  const args = ["git", "clone"];
  if (input.clone.filter) args.push(`--filter=${input.clone.filter}`);
  if (input.clone.depth !== null && input.clone.depth !== undefined)
    args.push("--depth", String(input.clone.depth));
  args.push(input.url, input.target);
  return args;
}
function assertPathInsideRoot(input: { root: string; target: string }): void {
  const relative = path.relative(input.root, input.target);
  if (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  )
    return;
  throw new WorkspaceError({
    message: `Workspace path '${input.target}' must stay inside workspace root '${input.root}'.`,
  });
}
function repoSegmentForWorkspace(repo?: string, controlCwd?: string): string {
  if (repo && /^[^/\s]+\/[^/\s]+$/.test(repo)) {
    const [owner, name] = repo.split("/");
    return `${sanitizeWorkspaceSegment(owner ?? "unknown")}-${sanitizeWorkspaceSegment(name ?? "repo")}`;
  }
  const fallback = controlCwd
    ? path.basename(path.resolve(controlCwd))
    : "repo";
  return `local-${sanitizeWorkspaceSegment(fallback)}`;
}
function parseDurationMs(value: string): number {
  const match = /^(\d+)([dhm])$/i.exec(value.trim());
  if (!match)
    throw new WorkspaceError({
      message: `Invalid duration '${value}'. Use formats like 30d, 12h, or 60m.`,
    });
  const amount = Number(match[1]);
  const unit = match[2]?.toLowerCase();
  if (unit === "d") return amount * 24 * 60 * 60 * 1000;
  if (unit === "h") return amount * 60 * 60 * 1000;
  return amount * 60 * 1000;
}
function tail(value: string, max = 4000): string {
  return value.length <= max ? value : value.slice(-max);
}

export type WorkspaceFailure =
  | WorkspaceError
  | WorkspacePathError
  | WorkspaceCommandError
  | WorkspaceHookError
  | PrReviewHeadChangedError
  | PlatformError.PlatformError
  | Effect.Error<ReturnType<typeof runProcessOrThrow>>
  | InvalidCopyPathError;
export type WorkspaceRequirements =
  | FileSystem.FileSystem
  | ChildProcessSpawner
  | Presentation;

const checkWorkspaceInput = Effect.fnUntraced(function* <A>(read: () => A) {
  return yield* Effect.try({ try: read, catch: (error) => error }).pipe(
    Effect.catch((error) =>
      error instanceof WorkspaceError ? Effect.fail(error) : Effect.die(error),
    ),
  );
});
