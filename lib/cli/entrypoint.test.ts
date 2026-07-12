import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runProcess, runProcessOrThrow } from "./process.ts";

const projectRoot = path.resolve(import.meta.dir, "../..");
const entrypoint = path.join(projectRoot, "roark.ts");
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("roark executable", () => {
  test("prints the package version", async () => {
    const packageJson = await Bun.file(path.join(projectRoot, "package.json")).json() as { version: string };
    const result = await runProcess([entrypoint, "--version"], { cwd: projectRoot });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim()).toBe(packageJson.version);
  });

  test("prints help successfully", async () => {
    const result = await runProcess([entrypoint, "--help"], { cwd: projectRoot });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("roark <command> [issue] [options]");
  });

  test("reports invalid commands on stderr with a nonzero exit", async () => {
    const result = await runProcess([entrypoint, "not-a-command"], { cwd: projectRoot });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Unknown command 'not-a-command'");
  });

  test("dispatches a hydrated status command", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "roark-entrypoint-"));
    tempDirs.push(repo);
    await runProcessOrThrow(["git", "init", repo]);

    const result = await runProcess([
      entrypoint,
      "status",
      "--all",
      "--cwd",
      repo,
      "--repo",
      "owner/repo",
    ], { cwd: projectRoot });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim()).toBe("No observability summaries found.");
  });
});
