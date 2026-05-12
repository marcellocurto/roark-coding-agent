import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { acquireRepoAutorunLock } from "./lock.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("acquireRepoAutorunLock", () => {
  test("creates metadata and releases the autorun lock directory", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "roark-lock-"));
    tempDirs.push(cwd);

    const lock = await acquireRepoAutorunLock({ cwd, repo: "owner/repo" });
    const metadataPath = path.join(lock.lockDir, "metadata.json");

    expect(existsSync(lock.lockDir)).toBe(true);
    const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as { pid: number; repo?: string | undefined; cwd: string };
    expect(metadata.pid).toBe(process.pid);
    expect(metadata.repo).toBe("owner/repo");
    expect(metadata.cwd).toBe(cwd);

    await lock.release();
    expect(existsSync(lock.lockDir)).toBe(false);
  });

  test("refuses a second same-checkout lock while held", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "roark-lock-"));
    tempDirs.push(cwd);
    const lock = await acquireRepoAutorunLock({ cwd });

    expect(acquireRepoAutorunLock({ cwd })).rejects.toThrow("Another roark auto run appears to hold the local repo lock");

    await lock.release();
  });
});
