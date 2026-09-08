import { fromLegacyPromise } from "../runtime/application.ts";
import { runApplicationPromise } from "../runtime/application.ts";
import type { ApplicationExecution } from "../runtime/application.ts";
import { runProcessOrThrowPromise } from "../cli/process-promise.ts";
import { presenter } from "../presentation/presenter.ts";

export interface PreImplementationBaseline {
  head: string;
  capturedAt: string;
  excludes: readonly [".roark"];
}

export async function assertCleanGit(
  context: { cwd: string; yes: boolean },
  application?: ApplicationExecution,
): Promise<void> {
  if (!application)
    return runApplicationPromise(
      fromLegacyPromise((application) => assertCleanGit(context, application)),
      application,
    );

  const dirtyLines = await gitDirtyLinesOutsideRoark(context.cwd, application);

  if (dirtyLines.length === 0) return;
  if (context.yes) {
    presenter(application).warning(
      "git tree has pre-existing changes; continuing because --yes was provided",
    );
    return;
  }

  throw new Error(
    `Git working tree has changes outside .roark. Commit/stash them or pass --yes.\n\n${dirtyLines.join("\n")}`,
  );
}

export async function assertCleanAutorunGit(
  context: { cwd: string },
  application?: ApplicationExecution,
): Promise<void> {
  if (!application)
    return runApplicationPromise(
      fromLegacyPromise((application) =>
        assertCleanAutorunGit(context, application),
      ),
      application,
    );

  const dirtyLines = await gitDirtyLinesOutsideRoark(context.cwd, application);
  if (dirtyLines.length === 0) return;

  throw new Error(
    `Autorun needs a clean git working tree before it can claim issues, switch branches, push, or open PRs. ` +
      `Commit or stash changes outside .roark, or use 'do <issue>' for local/manual mode.\n\n${dirtyLines.join("\n")}`,
  );
}

export async function assertCleanGitTree(
  context: { cwd: string; yes: boolean },
  application?: ApplicationExecution,
): Promise<void> {
  if (!application)
    return runApplicationPromise(
      fromLegacyPromise((application) =>
        assertCleanGitTree(context, application),
      ),
      application,
    );

  const dirtyLines = await gitDirtyLines(context.cwd, application);
  if (dirtyLines.length === 0) return;
  if (context.yes) {
    presenter(application).warning(
      "git tree has pre-existing changes; continuing because --yes was provided",
    );
    return;
  }

  throw new Error(
    `Git working tree has changes. Commit/stash them or pass --yes.\n\n${dirtyLines.join("\n")}`,
  );
}

export async function gitDirtyLines(
  cwd: string,
  application?: ApplicationExecution,
): Promise<string[]> {
  if (!application)
    return runApplicationPromise(
      fromLegacyPromise((application) => gitDirtyLines(cwd, application)),
      application,
    );

  const stdout = await runProcessOrThrowPromise(
    ["git", "status", "--porcelain"],
    { cwd, label: "git status" },
    application,
  );
  return stdout
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean);
}

export async function capturePreImplementationBaseline(
  context: { cwd: string; yes: boolean },
  application?: ApplicationExecution,
): Promise<PreImplementationBaseline> {
  if (!application)
    return runApplicationPromise(
      fromLegacyPromise((application) =>
        capturePreImplementationBaseline(context, application),
      ),
      application,
    );

  await assertCleanGit({ cwd: context.cwd, yes: context.yes }, application);
  const head = (
    await runProcessOrThrowPromise(
      ["git", "rev-parse", "HEAD"],
      { cwd: context.cwd, label: "git rev-parse HEAD" },
      application,
    )
  ).trim();
  return {
    head,
    capturedAt: new Date().toISOString(),
    excludes: [".roark"],
  };
}

export async function resetWorktreeToPreImplementationBaseline(
  context: { cwd: string; baseline: PreImplementationBaseline },
  application?: ApplicationExecution,
): Promise<void> {
  if (!application)
    return runApplicationPromise(
      fromLegacyPromise((application) =>
        resetWorktreeToPreImplementationBaseline(context, application),
      ),
      application,
    );

  const baselineHead = context.baseline.head || "HEAD";
  await runProcessOrThrowPromise(
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
    application,
  );
  await runProcessOrThrowPromise(
    ["git", "clean", "-fd", "--", ".", ":(exclude).roark"],
    { cwd: context.cwd, label: "git clean pre-implementation baseline" },
    application,
  );
}

async function gitDirtyLinesOutsideRoark(
  cwd: string,
  application?: ApplicationExecution,
): Promise<string[]> {
  return (await gitDirtyLines(cwd, application)).filter(
    (line) => !isRoarkOnlyStatusLine(line),
  );
}

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
