import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { noopAsync } from "../utils/async.ts";
import { withCheckoutLock } from "./lock.ts";

const tempDirs: string[] = [];
const lockDirs: string[] = [];

afterEach(async () => {
  for (const lockDir of lockDirs.splice(0)) await rm(lockDir, { recursive: true, force: true });
  for (const tempDir of tempDirs.splice(0)) await rm(tempDir, { recursive: true, force: true });
});

describe("withCheckoutLock", () => {
  test("releases the lock after failures", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "roark-lock-release-"));
    tempDirs.push(cwd);
    const lockDir = await testCheckoutLockDir({ checkout: cwd, name: "release-test" });
    lockDirs.push(lockDir);

    const error = await catchError(withCheckoutLock({ cwd, name: "release-test", description: "release test" }, () => {
      throw new Error("boom");
    }));

    expect(error?.message).toContain("boom");

    expect(existsSync(lockDir)).toBe(false);
  });

  test("removes stale ownerless lock directories", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "roark-lock-ownerless-"));
    tempDirs.push(cwd);
    const lockDir = await testCheckoutLockDir({ checkout: cwd, name: "ownerless-test" });
    lockDirs.push(lockDir);
    await mkdir(lockDir, { recursive: true });
    await markOld(lockDir);

    let entered = false;
    await withCheckoutLock({ cwd, name: "ownerless-test", description: "ownerless test" }, () => {
      entered = true;
      return noopAsync();
    });

    expect(entered).toBe(true);
    expect(existsSync(lockDir)).toBe(false);
  });

  test("removes stale corrupt lock directories", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "roark-lock-corrupt-"));
    tempDirs.push(cwd);
    const lockDir = await testCheckoutLockDir({ checkout: cwd, name: "corrupt-test" });
    lockDirs.push(lockDir);
    await mkdir(lockDir, { recursive: true });
    await writeFile(path.join(lockDir, "owner.json"), "not json", "utf8");
    await markOld(lockDir);

    let entered = false;
    await withCheckoutLock({ cwd, name: "corrupt-test", description: "corrupt test" }, () => {
      entered = true;
      return noopAsync();
    });

    expect(entered).toBe(true);
    expect(existsSync(lockDir)).toBe(false);
  });

  test("does not remove fresh ownerless lock directories", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "roark-lock-fresh-ownerless-"));
    tempDirs.push(cwd);
    const lockDir = await testCheckoutLockDir({ checkout: cwd, name: "fresh-ownerless-test" });
    lockDirs.push(lockDir);
    await mkdir(lockDir, { recursive: true });

    const error = await catchError(withCheckoutLock({ cwd, name: "fresh-ownerless-test", description: "fresh ownerless test" }, () => {
      throw new Error("should not enter");
    }));

    expect(error?.message).toContain("fresh ownerless test is already running");

    expect(existsSync(lockDir)).toBe(true);
  });
});

async function markOld(target: string): Promise<void> {
  const old = new Date(Date.now() - 60_000);
  await utimes(target, old, old);
}

async function testCheckoutLockDir(input: { checkout: string; name: string }): Promise<string> {
  const checkout = await realpath(input.checkout);
  const checkoutHash = createHash("sha256").update(checkout).digest("hex").slice(0, 16);
  return path.join(tmpdir(), "roark-coding-agent-locks", `${checkoutHash}-${sanitizeLockName(input.name)}.lock`);
}

async function catchError(promise: Promise<unknown>): Promise<Error | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

function sanitizeLockName(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[.-]+|[.-]+$/g, "") || "lock";
}
