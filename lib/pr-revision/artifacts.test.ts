import { Effect, Deferred, Fiber, FileSystem } from "effect";
import {
  createPrRevisionContext,
  writePrRevisionArtifact,
  removeAgentPrRevisionArtifacts,
  allocateNextRevision,
  inferIssueFromPrBody,
} from "./artifacts.ts";
import { runApplicationPromise } from "../runtime/application.ts";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
describe("PR revision artifacts", () => {
  test("allocates next revision directory number", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "roark-pr-revision-"));
    const prDir = path.join(root, "pr", "12");
    expect(await runApplicationPromise(allocateNextRevision(prDir))).toBe(1);
    await mkdir(path.join(prDir, "revision-1"), { recursive: true });
    await mkdir(path.join(prDir, "revision-3"), { recursive: true });
    await mkdir(path.join(prDir, "notes"), { recursive: true });
    expect(await runApplicationPromise(allocateNextRevision(prDir))).toBe(4);
  });
  test("infers closing issue from PR body", () => {
    expect(inferIssueFromPrBody("Implements this.\n\nCloses #46")).toBe(46);
    expect(inferIssueFromPrBody("Fixes owner/repo#123")).toBe(123);
    expect(inferIssueFromPrBody("No closing keyword #7")).toBeUndefined();
  });
});
test("revision artifact mirroring finishes before interruption cleanup", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const started = yield* Deferred.make<undefined>();
      const release = yield* Deferred.make<undefined>();
      const events: string[] = [];
      const fs = FileSystem.makeNoop({
        makeDirectory: () => Effect.void,
        writeFileString: Effect.fnUntraced(function* (file) {
          if (file.startsWith("/agent/")) {
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(release);
            events.push("mirror");
          } else events.push("canonical");
        }),
        remove: () =>
          Effect.sync(() => {
            events.push("cleanup");
          }),
      });
      const context = yield* createPrRevisionContext({
        command: "revise-pr",
        prNumber: 12,
        cwd: "/control",
        agentCwd: "/agent",
        outDir: ".roark/runs",
        verifyCommand: "true",
        remote: "origin",
        maxFixPasses: 1,
        yes: false,
        force: false,
        comment: false,
      }).pipe(Effect.provideService(FileSystem.FileSystem, fs));
      const writer = yield* Effect.forkScoped(
        writePrRevisionArtifact(context, "revision-plan.json", "{}").pipe(
          Effect.ensuring(
            removeAgentPrRevisionArtifacts(context).pipe(Effect.orDie),
          ),
          Effect.provideService(FileSystem.FileSystem, fs),
        ),
      );
      yield* Deferred.await(started);
      const interrupted = yield* Effect.forkScoped(Fiber.interrupt(writer));
      yield* Effect.yieldNow;
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(interrupted);
      expect(events).toEqual(["canonical", "mirror", "cleanup"]);
    }).pipe(Effect.scoped),
  );
});
