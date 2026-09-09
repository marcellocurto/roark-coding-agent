import { Effect, FileSystem, Schema } from "effect";

import path from "node:path";
import { runProcess, runProcessOrThrow } from "../cli/process.ts";
export class AutorunBranchError extends Schema.TaggedError<AutorunBranchError>()(
  "AutorunBranchError",
  { message: Schema.String },
) {}

export const defaultAutorunBaseBranch = "main";
export interface AutorunBranchPlan {
  issueNumber: number;
  branchName: string;
  baseBranch: string;
}
export function createBranchPlan(options: {
  issueNumber: number;
  branchName: string;
  baseBranch?: string | undefined;
}): AutorunBranchPlan {
  const baseBranch = options.baseBranch ?? defaultAutorunBaseBranch;
  assertSafeWorkBranch({ branchName: options.branchName, baseBranch });
  return {
    issueNumber: options.issueNumber,
    branchName: options.branchName,
    baseBranch,
  };
}
export function assertSafeWorkBranch(options: {
  branchName: string;
  baseBranch: string;
}): void {
  const branchName = options.branchName.trim();
  const baseBranch = options.baseBranch.trim();
  if (!branchName)
    throw new AutorunBranchError({
      message: "Autorun work branch cannot be empty.",
    });
  if (branchName === baseBranch)
    throw new AutorunBranchError({
      message: `Autorun work branch cannot be the base branch '${baseBranch}'.`,
    });
  if (branchName === defaultAutorunBaseBranch)
    throw new AutorunBranchError({
      message: `Autorun work branch cannot be '${defaultAutorunBaseBranch}'.`,
    });
}
export function autorunWorktreePath(
  controlCwd: string,
  issueNumber: number,
): string {
  return path.resolve(controlCwd, ".roark/worktrees", `issue-${issueNumber}`);
}
export const ensureRoarkWorktreesIgnored = Effect.fn(
  "ensureRoarkWorktreesIgnored",
)(function* (controlCwd: string) {
  const roarkDir = path.resolve(controlCwd, ".roark");
  yield* (yield* FileSystem.FileSystem).makeDirectory(roarkDir, {
    recursive: true,
  });
  const ignorePath = path.join(roarkDir, ".gitignore");
  const desiredLine = "worktrees/";
  const existing = (yield* (yield* FileSystem.FileSystem).exists(ignorePath))
    ? yield* (yield* FileSystem.FileSystem).readFileString(ignorePath)
    : "";
  const lines = existing.split(/\r?\n/).map((line) => line.trim());
  if (lines.includes(desiredLine)) return;
  const prefix =
    existing.length === 0 || existing.endsWith("\n")
      ? existing
      : `${existing}\n`;
  yield* (yield* FileSystem.FileSystem).writeFileString(
    ignorePath,
    `${prefix}${desiredLine}\n`,
  );
});
export const ensureIssueWorktree = Effect.fn("ensureIssueWorktree")(
  function* (options: { controlCwd: string; plan: AutorunBranchPlan }) {
    const agentCwd = autorunWorktreePath(
      options.controlCwd,
      options.plan.issueNumber,
    );
    yield* ensureRoarkWorktreesIgnored(options.controlCwd);
    yield* (yield* FileSystem.FileSystem).makeDirectory(
      path.dirname(agentCwd),
      { recursive: true },
    );
    if (yield* (yield* FileSystem.FileSystem).exists(agentCwd)) {
      yield* assertDirectory(agentCwd);
      yield* assertWorktreeOnBranch({
        agentCwd,
        branchName: options.plan.branchName,
      });
      if (yield* hasGitChanges(agentCwd)) {
        return yield* Effect.fail(
          new AutorunBranchError({
            message: `Issue worktree '${agentCwd}' has uncommitted changes. Use 'roark continue ${options.plan.issueNumber} --cwd ${options.controlCwd}' to recover a failed attempt, or clean the worktree before starting fresh auto work.`,
          }),
        );
      }
      return agentCwd;
    }
    if (
      yield* gitBranchExists({
        cwd: options.controlCwd,
        branchName: options.plan.branchName,
      })
    ) {
      yield* runProcessOrThrow(
        ["git", "worktree", "add", agentCwd, options.plan.branchName],
        {
          cwd: options.controlCwd,
          label: "git worktree add",
        },
      );
    } else {
      yield* runProcessOrThrow(["git", "fetch", "origin"], {
        cwd: options.controlCwd,
        label: "git fetch origin",
      });
      yield* runProcessOrThrow(
        [
          "git",
          "worktree",
          "add",
          "-b",
          options.plan.branchName,
          agentCwd,
          `origin/${options.plan.baseBranch}`,
        ],
        {
          cwd: options.controlCwd,
          label: "git worktree add -b",
        },
      );
    }
    yield* assertWorktreeOnBranch({
      agentCwd,
      branchName: options.plan.branchName,
    });
    return agentCwd;
  },
);
export const checkoutIssueBranch = Effect.fn("checkoutIssueBranch")(
  function* (options: { cwd: string; plan: AutorunBranchPlan }) {
    yield* ensureIssueWorktree({ controlCwd: options.cwd, plan: options.plan });
  },
);
export const checkoutExistingIssueBranch = Effect.fn(
  "checkoutExistingIssueBranch",
)(function* (options: {
  cwd: string;
  plan: AutorunBranchPlan;
  worktreePath?: string;
}) {
  const agentCwd = path.resolve(
    options.worktreePath ??
      autorunWorktreePath(options.cwd, options.plan.issueNumber),
  );
  if (yield* (yield* FileSystem.FileSystem).exists(agentCwd)) {
    yield* assertDirectory(agentCwd);
    yield* assertWorktreeOnBranch({
      agentCwd,
      branchName: options.plan.branchName,
    });
    return agentCwd;
  }
  yield* ensureRoarkWorktreesIgnored(options.cwd);
  yield* (yield* FileSystem.FileSystem).makeDirectory(path.dirname(agentCwd), {
    recursive: true,
  });
  yield* runProcessOrThrow(["git", "worktree", "prune"], {
    cwd: options.cwd,
    label: "git worktree prune",
  });
  if (
    yield* gitBranchExists({
      cwd: options.cwd,
      branchName: options.plan.branchName,
    })
  ) {
    yield* runProcessOrThrow(
      ["git", "worktree", "add", agentCwd, options.plan.branchName],
      {
        cwd: options.cwd,
        label: "git worktree add",
      },
    );
  } else {
    yield* fetchOriginIfAvailable(options.cwd);
    if (
      !(yield* gitRemoteBranchExists({
        cwd: options.cwd,
        branchName: options.plan.branchName,
      }))
    ) {
      return yield* Effect.fail(
        new AutorunBranchError({
          message: `Cannot continue autorun attempt for #${options.plan.issueNumber}: worktree '${agentCwd}' is missing and neither local branch '${options.plan.branchName}' nor remote branch 'origin/${options.plan.branchName}' exists.`,
        }),
      );
    }
    yield* runProcessOrThrow(
      [
        "git",
        "worktree",
        "add",
        "-b",
        options.plan.branchName,
        agentCwd,
        `origin/${options.plan.branchName}`,
      ],
      {
        cwd: options.cwd,
        label: "git worktree add -b",
      },
    );
  }
  yield* assertWorktreeOnBranch({
    agentCwd,
    branchName: options.plan.branchName,
  });
  return agentCwd;
});
const assertDirectory = Effect.fn("assertDirectory")(function* (
  directoryPath: string,
) {
  const current = yield* (yield* FileSystem.FileSystem).stat(directoryPath);
  if (current.type !== "Directory")
    return yield* Effect.fail(
      new AutorunBranchError({
        message: `${directoryPath} exists but is not a directory.`,
      }),
    );
});
const assertWorktreeOnBranch = Effect.fn("assertWorktreeOnBranch")(
  function* (options: { agentCwd: string; branchName: string }) {
    const currentBranch = (yield* runProcessOrThrow(
      ["git", "branch", "--show-current"],
      {
        cwd: options.agentCwd,
        label: "git branch --show-current",
      },
    )).trim();
    if (currentBranch !== options.branchName) {
      return yield* Effect.fail(
        new AutorunBranchError({
          message: `Autorun worktree '${options.agentCwd}' is on branch '${currentBranch || "(detached)"}', expected '${options.branchName}'.`,
        }),
      );
    }
  },
);
const hasGitChanges = Effect.fn("hasGitChanges")(function* (cwd: string) {
  const result = yield* runProcess(["git", "status", "--porcelain"], { cwd });
  if (result.exitCode !== 0) {
    return yield* Effect.fail(
      new AutorunBranchError({
        message: `git status --porcelain failed with exit code ${result.exitCode}:\n${result.stderr || result.stdout}`,
      }),
    );
  }
  return result.stdout.trim() !== "";
});
const gitBranchExists = Effect.fn("gitBranchExists")(function* (options: {
  cwd: string;
  branchName: string;
}) {
  const result = yield* runProcess(
    [
      "git",
      "show-ref",
      "--verify",
      "--quiet",
      `refs/heads/${options.branchName}`,
    ],
    {
      cwd: options.cwd,
    },
  );
  return result.exitCode === 0;
});
const gitRemoteBranchExists = Effect.fn("gitRemoteBranchExists")(
  function* (options: { cwd: string; branchName: string }) {
    const result = yield* runProcess(
      [
        "git",
        "show-ref",
        "--verify",
        "--quiet",
        `refs/remotes/origin/${options.branchName}`,
      ],
      {
        cwd: options.cwd,
      },
    );
    return result.exitCode === 0;
  },
);
const fetchOriginIfAvailable = Effect.fn("fetchOriginIfAvailable")(function* (
  cwd: string,
) {
  yield* runProcess(["git", "fetch", "origin"], { cwd });
});
