import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

interface LocalLockOwner {
  token: string;
  pid: number;
  checkout: string;
  description: string;
  acquiredAt: string;
}

const ownerlessLockGraceMs = 5_000;

export async function withCheckoutLock<T>(
  input: { cwd: string; name: string; description: string },
  run: () => Promise<T>,
): Promise<T> {
  const lock = await acquireCheckoutLock(input);
  try {
    return await run();
  } finally {
    await releaseCheckoutLock(lock);
  }
}

export async function withAutorunIssueLock<T>(
  input: { cwd: string; issueNumber: number | string; description: string },
  run: () => Promise<T>,
): Promise<T> {
  return withCheckoutLock({
    cwd: input.cwd,
    name: `autorun-issue-${input.issueNumber}`,
    description: input.description,
  }, run);
}

async function acquireCheckoutLock(input: { cwd: string; name: string; description: string }): Promise<{ dir: string; token: string }> {
  const checkout = await canonicalCheckoutPath(input.cwd);
  const lockDir = checkoutLockDir({ checkout, name: input.name });
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await mkdir(path.dirname(lockDir), { recursive: true });

  for (let remainingAttempts = 2; remainingAttempts > 0; remainingAttempts--) {
    try {
      await mkdir(lockDir);
      const owner: LocalLockOwner = {
        token,
        pid: process.pid,
        checkout,
        description: input.description,
        acquiredAt: new Date().toISOString(),
      };
      await writeFile(path.join(lockDir, "owner.json"), `${JSON.stringify(owner, null, 2)}\n`, "utf8");
      return { dir: lockDir, token };
    } catch (error) {
      if (!isErrorWithCode(error, "EEXIST")) throw error;
      if (await removeStaleLock(lockDir)) continue;
      throw new Error(`${input.description} is already running for checkout '${checkout}' (lock: ${lockDir}).`);
    }
  }

  throw new Error(`${input.description} is already running for checkout '${checkout}' (lock: ${lockDir}).`);
}

async function releaseCheckoutLock(lock: { dir: string; token: string }): Promise<void> {
  let owner: LocalLockOwner | undefined;
  try {
    owner = JSON.parse(await readFile(path.join(lock.dir, "owner.json"), "utf8")) as LocalLockOwner;
  } catch {
    return;
  }
  if (owner.token !== lock.token) return;
  await rm(lock.dir, { recursive: true, force: true });
}

async function removeStaleLock(lockDir: string): Promise<boolean> {
  let owner: LocalLockOwner;
  try {
    owner = JSON.parse(await readFile(path.join(lockDir, "owner.json"), "utf8")) as LocalLockOwner;
  } catch {
    return removeOwnerlessStaleLock(lockDir);
  }
  if (owner.pid === process.pid || isProcessAlive(owner.pid)) return false;
  await rm(lockDir, { recursive: true, force: true });
  return true;
}

async function removeOwnerlessStaleLock(lockDir: string): Promise<boolean> {
  let ageMs: number;
  try {
    ageMs = Date.now() - (await stat(lockDir)).mtimeMs;
  } catch {
    return false;
  }
  if (ageMs < ownerlessLockGraceMs) return false;
  await rm(lockDir, { recursive: true, force: true });
  return true;
}

async function canonicalCheckoutPath(cwd: string): Promise<string> {
  const resolved = path.resolve(cwd);
  if (!existsSync(resolved)) return resolved;
  try {
    return await realpath(resolved);
  } catch {
    return resolved;
  }
}

function checkoutLockDir(input: { checkout: string; name: string }): string {
  const checkoutHash = createHash("sha256").update(input.checkout).digest("hex").slice(0, 16);
  return path.join(os.tmpdir(), "roark-coding-agent-locks", `${checkoutHash}-${sanitizeLockName(input.name)}.lock`);
}

function sanitizeLockName(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[.-]+|[.-]+$/g, "") || "lock";
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isErrorWithCode(error, "ESRCH");
  }
}

function isErrorWithCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}
