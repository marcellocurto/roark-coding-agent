import { runProcessOrThrow } from "../cli/process.ts";

export interface PreImplementationBaseline {
  head: string;
  capturedAt: string;
  excludes: readonly [".roark"];
}

export async function assertCleanGit(context: { cwd: string; yes: boolean }): Promise<void> {
  const dirtyLines = await gitDirtyLinesOutsideRoark(context.cwd);

  if (dirtyLines.length === 0) return;
  if (context.yes) {
    console.log("! git tree has pre-existing changes; continuing because --yes was provided.");
    return;
  }

  throw new Error(
    `Git working tree has changes outside .roark. Commit/stash them or pass --yes.\n\n${dirtyLines.join("\n")}`,
  );
}

export async function assertCleanAutorunGit(context: { cwd: string }): Promise<void> {
  const dirtyLines = await gitDirtyLinesOutsideRoark(context.cwd);
  if (dirtyLines.length === 0) return;

  throw new Error(
    `Autorun needs a clean git working tree before it can claim issues, switch branches, push, or open PRs. ` +
      `Commit or stash changes outside .roark, or use 'do <issue>' for local/manual mode.\n\n${dirtyLines.join("\n")}`,
  );
}

export async function assertCleanGitTree(context: { cwd: string; yes: boolean }): Promise<void> {
  const dirtyLines = await gitDirtyLines(context.cwd);
  if (dirtyLines.length === 0) return;
  if (context.yes) {
    console.log("! git tree has pre-existing changes; continuing because --yes was provided.");
    return;
  }

  throw new Error(`Git working tree has changes. Commit/stash them or pass --yes.\n\n${dirtyLines.join("\n")}`);
}

export async function gitDirtyLines(cwd: string): Promise<string[]> {
  const stdout = await runProcessOrThrow(["git", "status", "--porcelain"], { cwd, label: "git status" });
  return stdout
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean);
}

export async function capturePreImplementationBaseline(context: { cwd: string; yes: boolean }): Promise<PreImplementationBaseline> {
  await assertCleanGit({ cwd: context.cwd, yes: context.yes });
  const head = (await runProcessOrThrow(["git", "rev-parse", "HEAD"], { cwd: context.cwd, label: "git rev-parse HEAD" })).trim();
  return {
    head,
    capturedAt: new Date().toISOString(),
    excludes: [".roark"],
  };
}

export async function resetWorktreeToPreImplementationBaseline(context: { cwd: string; baseline: PreImplementationBaseline }): Promise<void> {
  const baselineHead = context.baseline.head || "HEAD";
  await runProcessOrThrow(
    ["git", "restore", "--source", baselineHead, "--staged", "--worktree", "--", ".", ":(exclude).roark"],
    { cwd: context.cwd, label: "git restore pre-implementation baseline" },
  );
  await runProcessOrThrow(
    ["git", "clean", "-fd", "--", ".", ":(exclude).roark"],
    { cwd: context.cwd, label: "git clean pre-implementation baseline" },
  );
}

async function gitDirtyLinesOutsideRoark(cwd: string): Promise<string[]> {
  return (await gitDirtyLines(cwd)).filter((line) => !isRoarkOnlyStatusLine(line));
}

function isRoarkOnlyStatusLine(line: string): boolean {
  return statusLinePaths(line).length > 0 && statusLinePaths(line).every(isRoarkPath);
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
