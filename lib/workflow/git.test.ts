import { runApplicationPromise } from "../runtime/application.ts";
import * as nativeGit from "./git.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
const tempDirs: string[] = [];
afterEach(async () => {
  for (const dir of tempDirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});
describe("git workspace safety", () => {
  test("ignores dirty files under .roark", async () => {
    const cwd = await initGitRepo();
    await mkdir(path.join(cwd, ".roark/runs"), { recursive: true });
    await writeFile(
      path.join(cwd, ".roark/runs/note.md"),
      "artifact\n",
      "utf8",
    );
    expect(
      runApplicationPromise(nativeGit.assertCleanGit({ cwd, yes: false })),
    ).resolves.toBeUndefined();
  });
  test("local workflow refuses dirty files outside .roark without --yes", async () => {
    const cwd = await initGitRepo();
    await writeFile(path.join(cwd, "dirty.txt"), "dirty\n", "utf8");
    expect(
      runApplicationPromise(nativeGit.assertCleanGit({ cwd, yes: false })),
    ).rejects.toThrow("Git working tree has changes outside .roark");
  });
  test("baseline reset restores worktree changes while preserving .roark artifacts", async () => {
    const cwd = await initGitRepo();
    const baseline = await runApplicationPromise(
      nativeGit.capturePreImplementationBaseline({
        cwd,
        yes: false,
      }),
    );
    await mkdir(path.join(cwd, ".roark/runs"), { recursive: true });
    await writeFile(
      path.join(cwd, ".roark/runs/refinement-log-0.md"),
      "keep\n",
      "utf8",
    );
    await writeFile(path.join(cwd, "README.md"), "changed\n", "utf8");
    await writeFile(path.join(cwd, "new-file.txt"), "remove\n", "utf8");
    await runApplicationPromise(
      nativeGit.resetWorktreeToPreImplementationBaseline({ cwd, baseline }),
    );
    expect(await readFile(path.join(cwd, "README.md"), "utf8")).toBe("test\n");
    expect(
      await readFile(path.join(cwd, ".roark/runs/refinement-log-0.md"), "utf8"),
    ).toBe("keep\n");
    expect(readFile(path.join(cwd, "new-file.txt"), "utf8")).rejects.toThrow();
  });
});
async function initGitRepo(): Promise<string> {
  const cwd = await mkdtemp(path.join(tmpdir(), "roark-git-"));
  tempDirs.push(cwd);
  await run(cwd, ["git", "init", "-b", "main"]);
  await run(cwd, ["git", "config", "user.email", "roark@example.com"]);
  await run(cwd, ["git", "config", "user.name", "Roark Test"]);
  await writeFile(path.join(cwd, "README.md"), "test\n", "utf8");
  await run(cwd, ["git", "add", "README.md"]);
  await run(cwd, ["git", "commit", "-m", "initial"]);
  return cwd;
}
async function run(cwd: string, args: string[]): Promise<void> {
  const child = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0)
    throw new Error(
      `${args.join(" ")} failed with ${exitCode}: ${stderr || stdout}`,
    );
}
