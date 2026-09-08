import { Presentation } from "../runtime/services.ts";
import { Effect, Schema } from "effect";
import { runProcessOrThrow } from "../cli/process.ts";

export interface PreImplementationBaseline {
  head: string;
  capturedAt: string;
  excludes: readonly [".roark"];
}
export const parsePreImplementationBaseline = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      head: Schema.String,
      capturedAt: Schema.String,
      excludes: Schema.Tuple([Schema.Literal(".roark")]),
    }),
  ),
);
export const assertCleanGit = Effect.fn("assertCleanGit")(function* (context: {
  cwd: string;
  yes: boolean;
}) {
  const dirtyLines = yield* gitDirtyLinesOutsideRoark(context.cwd);
  if (dirtyLines.length === 0) return;
  if (context.yes) {
    (yield* Presentation).warning(
      "git tree has pre-existing changes; continuing because --yes was provided",
    );
    return;
  }
  return yield* Effect.fail(
    new GitWorkspaceError({
      message: `Git working tree has changes outside .roark. Commit/stash them or pass --yes.\n\n${dirtyLines.join("\n")}`,
    }),
  );
});
export const assertCleanAutorunGit = Effect.fn("assertCleanAutorunGit")(
  function* (context: { cwd: string }) {
    const dirtyLines = yield* gitDirtyLinesOutsideRoark(context.cwd);
    if (dirtyLines.length === 0) return;
    return yield* Effect.fail(
      new GitWorkspaceError({
        message:
          `Autorun needs a clean git working tree before it can claim issues, switch branches, push, or open PRs. ` +
          `Commit or stash changes outside .roark, or use 'do <issue>' for local/manual mode.\n\n${dirtyLines.join("\n")}`,
      }),
    );
  },
);
export const assertCleanGitTree = Effect.fn("assertCleanGitTree")(
  function* (context: { cwd: string; yes: boolean }) {
    const dirtyLines = yield* gitDirtyLines(context.cwd);
    if (dirtyLines.length === 0) return;
    if (context.yes) {
      (yield* Presentation).warning(
        "git tree has pre-existing changes; continuing because --yes was provided",
      );
      return;
    }
    return yield* Effect.fail(
      new GitWorkspaceError({
        message: `Git working tree has changes. Commit/stash them or pass --yes.\n\n${dirtyLines.join("\n")}`,
      }),
    );
  },
);
export const gitDirtyLines = Effect.fn("gitDirtyLines")(function* (
  cwd: string,
) {
  const stdout = yield* runProcessOrThrow(["git", "status", "--porcelain"], {
    cwd,
    label: "git status",
  });
  return stdout
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean);
});
export const capturePreImplementationBaseline = Effect.fn(
  "capturePreImplementationBaseline",
)(function* (context: { cwd: string; yes: boolean }) {
  yield* assertCleanGit({ cwd: context.cwd, yes: context.yes });
  const head = (yield* runProcessOrThrow(["git", "rev-parse", "HEAD"], {
    cwd: context.cwd,
    label: "git rev-parse HEAD",
  })).trim();
  return {
    head,
    capturedAt: new Date().toISOString(),
    excludes: [".roark"] as const,
  };
});
export const resetWorktreeToPreImplementationBaseline = Effect.fn(
  "resetWorktreeToPreImplementationBaseline",
)(function* (context: { cwd: string; baseline: PreImplementationBaseline }) {
  const baselineHead = context.baseline.head || "HEAD";
  yield* runProcessOrThrow(
    [
      "git",
      "restore",
      "--source",
      baselineHead,
      "--staged",
      "--worktree",
      "--",
      ".",
      ":(exclude).roark",
    ],
    { cwd: context.cwd, label: "git restore pre-implementation baseline" },
  );
  yield* runProcessOrThrow(
    ["git", "clean", "-fd", "--", ".", ":(exclude).roark"],
    { cwd: context.cwd, label: "git clean pre-implementation baseline" },
  );
});
const gitDirtyLinesOutsideRoark = Effect.fn("gitDirtyLinesOutsideRoark")(
  function* (cwd: string) {
    return (yield* gitDirtyLines(cwd)).filter(
      (line) => !isRoarkOnlyStatusLine(line),
    );
  },
);
function isRoarkOnlyStatusLine(line: string): boolean {
  return (
    statusLinePaths(line).length > 0 && statusLinePaths(line).every(isRoarkPath)
  );
}
function statusLinePaths(line: string): string[] {
  const pathPart = line.slice(3).trim();
  if (!pathPart) return [];
  return pathPart.split(" -> ").map(unquoteGitPath);
}
function isRoarkPath(filePath: string): boolean {
  return filePath === ".roark" || filePath.startsWith(".roark/");
}
function unquoteGitPath(filePath: string): string {
  if (filePath.startsWith('"') && filePath.endsWith('"')) {
    return filePath.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return filePath;
}

export class GitWorkspaceError extends Schema.TaggedError<GitWorkspaceError>()(
  "GitWorkspaceError",
  { message: Schema.String },
) {}
