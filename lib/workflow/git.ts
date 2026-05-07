import { runProcessOrThrow } from "../cli/process.ts";

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
