import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type AutorunLock = {
  lockDir: string;
  release: () => Promise<void>;
};

export type AutorunLockMetadata = {
  pid: number;
  hostname: string;
  cwd: string;
  repo?: string;
  acquiredAt: string;
};

export async function acquireRepoAutorunLock(options: { cwd: string; repo?: string }): Promise<AutorunLock> {
  const locksDir = path.resolve(options.cwd, ".roark/locks");
  const lockDir = path.join(locksDir, "autorun.lock");
  await mkdir(locksDir, { recursive: true });

  try {
    await mkdir(lockDir);
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") {
      throw new Error(
        `Another roark auto run appears to hold the local repo lock at ${lockDir}.` +
          `${await formatExistingLockMetadata(lockDir)}` +
          `\nIf no roark auto process is active for this checkout, remove that lock directory and retry.`,
      );
    }
    throw error;
  }

  const metadata: AutorunLockMetadata = {
    pid: process.pid,
    hostname: os.hostname(),
    cwd: path.resolve(options.cwd),
    repo: options.repo,
    acquiredAt: new Date().toISOString(),
  };
  await writeFile(path.join(lockDir, "metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");

  let released = false;
  return {
    lockDir,
    release: async () => {
      if (released) return;
      released = true;
      await rm(lockDir, { recursive: true, force: true });
    },
  };
}

async function formatExistingLockMetadata(lockDir: string): Promise<string> {
  try {
    const content = await readFile(path.join(lockDir, "metadata.json"), "utf8");
    const parsed = JSON.parse(content) as Partial<AutorunLockMetadata>;
    const parts = [
      parsed.pid !== undefined ? `pid=${parsed.pid}` : undefined,
      parsed.hostname ? `host=${parsed.hostname}` : undefined,
      parsed.acquiredAt ? `acquiredAt=${parsed.acquiredAt}` : undefined,
      parsed.repo ? `repo=${parsed.repo}` : undefined,
    ].filter(Boolean);
    return parts.length > 0 ? ` Existing lock: ${parts.join(", ")}.` : "";
  } catch {
    return "";
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}
