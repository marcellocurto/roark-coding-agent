import { Effect } from "effect";
import { withCheckoutLock } from "./lock.ts";
import { runApplicationPromise } from "../runtime/application.ts";
import { readRunSummary } from "../observability/summary.ts";
import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  readAttemptIndexPromise as readAttemptIndex,
  readAttemptMetadataPromise as readAttemptMetadata,
} from "./attempts-promise.ts";
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  test(`${signal} waits for attempt finalization before releasing the lock and exiting`, async () => {
    const cwd = await mkdtemp(
      path.join(tmpdir(), "roark-attempt-interruption-"),
    );
    const fixture = path.resolve(
      import.meta.dir,
      "../testing/fixtures/attempt-interruption.ts",
    );
    const child = Bun.spawn([process.execPath, fixture], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = new Response(child.stdout).text();
    const stderr = new Response(child.stderr).text();
    const lock = { cwd, name: "shutdown", description: "shutdown fixture" };
    const waitFile = async (filename: string): Promise<string> => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const value = await readFile(path.join(cwd, filename), "utf8").catch(
          () => undefined,
        );
        if (value !== undefined) return value;
        if (child.exitCode !== null)
          throw new Error(`Child exited before ${filename}: ${await stderr}`);
        await Bun.sleep(10);
      }
      throw new Error(`Timed out waiting for ${filename}`);
    };
    try {
      const pid = Number((await waitFile("child.pid")).trim());
      child.kill(signal);
      await waitFile("cleanup-started");
      expect(child.exitCode).toBeNull();
      expect(() => process.kill(pid, 0)).toThrow();
      const busy = await runApplicationPromise(
        withCheckoutLock(
          lock,
          Effect.tryPromise({
            try: () => Promise.resolve(),
            catch: (error) => error,
          }),
        ),
      ).catch((error: unknown) => error);
      expect(busy).toBeInstanceOf(Error);
      if (busy instanceof Error)
        expect(busy.message).toContain("already running");
      await writeFile(path.join(cwd, "allow-cleanup"), "continue");
      expect(await child.exited).toBe(130);
      expect(await waitFile("cleanup-finished")).toBe("finished");
      const issueDir = path.join(cwd, ".roark/runs/issue/1");
      const metadata = await readAttemptMetadata(issueDir, 1);
      expect(metadata.outcome).toBe("errored");
      expect(metadata.outcomeDetail).toBe("Interrupted.");
      expect(typeof metadata.endedAt).toBe("string");
      const summary = await runApplicationPromise(
        readRunSummary(path.join(issueDir, "attempts/1/summary.json")),
      );
      expect(summary?.status).toBe("failed");
      expect(summary?.endedAt ?? null).toBe(metadata.endedAt);
      expect((await readAttemptIndex(issueDir))[0]?.outcome).toBe("errored");
      expect(
        await runApplicationPromise(
          withCheckoutLock(
            lock,
            Effect.tryPromise({
              try: () => Promise.resolve("released"),
              catch: (error) => error,
            }),
          ),
        ),
      ).toBe("released");
    } finally {
      await writeFile(path.join(cwd, "allow-cleanup"), "continue").catch(
        () => undefined,
      );
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
      await Promise.all([stdout, stderr]);
      // Also removes a stale lease if the test had to terminate the fixture.
      await runApplicationPromise(
        withCheckoutLock(
          lock,
          Effect.tryPromise({
            try: () => Promise.resolve(),
            catch: (error) => error,
          }),
        ),
      ).catch(() => undefined);
      await rm(cwd, { recursive: true, force: true });
    }
  }, 10000);
}
