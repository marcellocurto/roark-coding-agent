import { runProcessOrThrow } from "../cli/process.ts";

export async function assertCleanGit(context: { cwd: string; yes: boolean }): Promise<void> {
  const stdout = await runProcessOrThrow(["git", "status", "--short"], { cwd: context.cwd, label: "git status" });
  const dirtyLines = stdout
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .filter((line) => !line.includes(".roark/"));

  if (dirtyLines.length === 0) return;
  if (context.yes) {
    console.log("! git tree has pre-existing changes; continuing because --yes was provided.");
    return;
  }

  throw new Error(
    `Git working tree has changes outside .roark. Commit/stash them or pass --yes.\n\n${dirtyLines.join("\n")}`,
  );
}
