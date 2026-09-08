import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import { Cause, Deferred, Effect, Exit, Fiber, FileSystem } from "effect";
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { applicationLayer } from "../runtime/application.ts";
import { AgentExecution, Verification } from "../runtime/services.ts";
import { Workspace } from "../autorun/workspace-service.ts";
import { GitHub } from "../github/service.ts";
import type { PullRequestFeedback } from "../github/pr.ts";
import { RevisionReporting } from "./comments.ts";
import { runPrRevision } from "./workflow.ts";
import { runProcess, runProcessOrThrow } from "../cli/process.ts";
import { AgentExecutionError } from "../pi/agent.ts";
import {
  revisionPlanResult,
  submitRevisionPlan,
} from "../testing/revision-plans.ts";
import {
  revisionExecutionResult,
  submitRevisionExecution,
} from "../testing/revision-executions.ts";
import { reviewResult, submitReview } from "../testing/reviews.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const feedback: PullRequestFeedback = {
  repo: "owner/repo",
  fetchedAt: "2026-09-08T00:00:00.000Z",
  pr: {
    number: 12,
    title: "Revision",
    body: "",
    state: "OPEN",
    baseRefName: "main",
    headRefName: "feature",
    baseRefOid: "base",
    headRefOid: "head",
    baseRepository: "owner/repo",
    headRepository: "owner/repo",
  },
  comments: [],
  plannerComments: [],
  excludedRoarkSummaryCommentIds: [],
  reviewThreads: [],
};

const fixture = Effect.fnUntraced(function* (
  root: string,
  agent: AgentExecution["Service"],
  events: string[],
  afterRun: Effect.Effect<void> = Effect.void,
) {
  const fs = yield* FileSystem.FileSystem;
  const github = yield* GitHub;
  const workspace = yield* Workspace;
  const control = path.join(root, "control");
  const agentCwd = path.join(root, "agent");
  for (const cwd of [control, agentCwd]) {
    yield* fs.makeDirectory(cwd, { recursive: true });
    yield* runProcessOrThrow(["git", "init", "-b", "feature"], { cwd });
    yield* runProcessOrThrow(
      ["git", "config", "user.email", "revision@example.invalid"],
      { cwd },
    );
    yield* runProcessOrThrow(["git", "config", "user.name", "Revision Test"], {
      cwd,
    });
  }
  yield* runProcessOrThrow(
    ["git", "remote", "add", "origin", path.join(root, "missing.git")],
    { cwd: control },
  );
  const metadata = path.join(
    control,
    ".roark/runs/pr/12/revision-1/metadata.json",
  );
  const run = runPrRevision({
    command: "revise-pr",
    prNumber: 12,
    cwd: control,
    repo: "owner/repo",
    outDir: ".roark/runs",
    verifyCommand: "true",
    remote: "origin",
    maxFixPasses: 1,
    yes: false,
    force: false,
    comment: true,
  }).pipe(
    Effect.provideService(GitHub, {
      ...github,
      fetchPullRequestFeedback: () => Effect.succeed(feedback),
    }),
    Effect.provideService(Workspace, {
      ...workspace,
      preparePrRevision: () =>
        Effect.acquireRelease(
          Effect.sync(() => {
            events.push("locked");
            return {
              path: agentCwd,
              metadata: {
                path: agentCwd,
                strategy: "clone" as const,
                cloneRemote: "origin",
                createdNow: false,
              },
            };
          }),
          () =>
            Effect.sync(() => {
              events.push("released");
            }),
        ),
      runHook: (name) => (name === "afterRun" ? afterRun : Effect.void),
    }),
    Effect.provideService(AgentExecution, agent),
    Effect.provideService(Verification, {
      execute: ({ command }) =>
        Effect.succeed({
          command,
          ok: true,
          exitCode: 0,
          stdout: "",
          stderr: "",
        }),
    }),
    Effect.provideService(RevisionReporting, {
      postSummary: () =>
        Effect.sync(() => {
          events.push("summary");
        }),
    }),
  );
  return { run, metadata, agentCwd };
});
async function root() {
  const value = await mkdtemp(path.join(tmpdir(), "roark-native-revision-"));
  roots.push(value);
  return value;
}

test("revision interruption waits for child cleanup and hooks before releasing its workspace", async () => {
  const directory = await root();
  await Effect.runPromise(
    Effect.gen(function* () {
      const started = yield* Deferred.make<undefined>();
      const cleanupStarted = yield* Deferred.make<undefined>();
      const finishCleanup = yield* Deferred.make<undefined>();
      const events: string[] = [];
      const setup = yield* fixture(
        directory,
        {
          run: () =>
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(
                Effect.sync(() => {
                  events.push("agent-finalized");
                }),
              ),
            ),
        },
        events,
        Effect.gen(function* () {
          events.push("cleanup-start");
          yield* Deferred.succeed(cleanupStarted, undefined);
          yield* Deferred.await(finishCleanup);
          events.push("cleanup-end");
        }),
      );
      const running = yield* Effect.forkScoped(setup.run);
      yield* Deferred.await(started);
      const interrupting = yield* Effect.forkScoped(Fiber.interrupt(running));
      yield* Deferred.await(cleanupStarted);
      expect(events).toEqual(["locked", "agent-finalized", "cleanup-start"]);
      const fs = yield* FileSystem.FileSystem;
      expect(yield* fs.readFileString(setup.metadata)).toContain(
        '"outcome": "interrupted"',
      );
      yield* Deferred.succeed(finishCleanup, undefined);
      yield* Fiber.join(interrupting);
      const exit = yield* Fiber.await(running);
      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(
        true,
      );
      expect(events).toEqual([
        "locked",
        "agent-finalized",
        "cleanup-start",
        "cleanup-end",
        "released",
      ]);
    }).pipe(Effect.scoped, Effect.provide(applicationLayer)),
  );
});

test("revision defects remain defects and retain diagnostic metadata", async () => {
  const directory = await root();
  const defect = new Error("revision defect");
  await Effect.runPromise(
    Effect.gen(function* () {
      const events: string[] = [];
      const setup = yield* fixture(
        directory,
        { run: () => Effect.die(defect) },
        events,
      );
      const exit = yield* Effect.exit(setup.run);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.hasDies(exit.cause)).toBe(true);
        expect(Cause.hasFails(exit.cause)).toBe(false);
      }
      const fs = yield* FileSystem.FileSystem;
      expect(yield* fs.readFileString(setup.metadata)).toContain(
        "revision defect",
      );
      expect(events).toEqual(["locked", "released"]);
    }).pipe(Effect.provide(applicationLayer)),
  );
});

test("a failed push cannot persist a published revision or post its summary", async () => {
  const directory = await root();
  await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const events: string[] = [];
      const setup = yield* fixture(
        directory,
        {
          run: Effect.fnUntraced(function* (request) {
            const phase = request.display.phaseId;
            if (phase === "pr-revision-revision-implementation")
              yield* fs
                .writeFileString(path.join(request.cwd, "fixed.txt"), "fixed")
                .pipe(Effect.orDie);
            return yield* Effect.tryPromise({
              try: () =>
                phase === "pr-revision-revision-plan"
                  ? submitRevisionPlan(request, revisionPlanResult("revise"))
                  : phase === "pr-revision-revision-implementation"
                    ? submitRevisionExecution(
                        request,
                        revisionExecutionResult(),
                      )
                    : submitReview(request, reviewResult()),
              catch: (cause) =>
                new AgentExecutionError({ operation: "test agent", cause }),
            });
          }),
        },
        events,
      );
      const exit = yield* Effect.exit(setup.run);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.hasFails(exit.cause)).toBe(true);
        expect(Cause.pretty(exit.cause)).toContain("git push origin");
      }
      const saved = yield* fs.readFileString(setup.metadata);
      expect(saved).toContain('"outcome": "errored"');
      expect(saved).not.toContain('"outcome": "published"');
      expect(events).toEqual(["locked", "released"]);
    }).pipe(Effect.provide(applicationLayer)),
  );
});

test("cancellation after an acknowledged push preserves published metadata", async () => {
  const directory = await root();
  await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const spawner = yield* ChildProcessSpawner;
      const events: string[] = [];
      const remote = path.join(directory, "missing.git");
      const setup = yield* fixture(
        directory,
        {
          run: Effect.fnUntraced(function* (request) {
            const phase = request.display.phaseId;
            if (phase === "pr-revision-revision-implementation")
              yield* fs
                .writeFileString(path.join(request.cwd, "fixed.txt"), "fixed")
                .pipe(Effect.orDie);
            return yield* Effect.tryPromise({
              try: () =>
                phase === "pr-revision-revision-plan"
                  ? submitRevisionPlan(request, revisionPlanResult("revise"))
                  : phase === "pr-revision-revision-implementation"
                    ? submitRevisionExecution(
                        request,
                        revisionExecutionResult(),
                      )
                    : submitReview(request, reviewResult()),
              catch: (cause) =>
                new AgentExecutionError({ operation: "test agent", cause }),
            });
          }),
        },
        events,
      );
      yield* runProcessOrThrow(["git", "init", "--bare", remote], {
        cwd: directory,
      });
      const publicationStarted = yield* Deferred.make<undefined>();
      const finishPublication = yield* Deferred.make<undefined>();
      let gated = false;
      const delayed = FileSystem.FileSystem.of({
        ...fs,
        readDirectory: Effect.fnUntraced(function* (dir, options) {
          if (
            !gated &&
            dir === path.join(directory, "control/.roark/runs/issue")
          ) {
            const published = yield* runProcess(
              [
                "git",
                "--git-dir",
                remote,
                "show-ref",
                "--verify",
                "refs/heads/feature",
              ],
              { cwd: directory },
            ).pipe(
              Effect.provideService(ChildProcessSpawner, spawner),
              Effect.orDie,
            );
            if (published.exitCode === 0) {
              gated = true;
              yield* Deferred.succeed(publicationStarted, undefined);
              yield* Deferred.await(finishPublication);
            }
          }
          return yield* fs.readDirectory(dir, options);
        }),
      });
      const running = yield* Effect.forkScoped(
        setup.run.pipe(Effect.provideService(FileSystem.FileSystem, delayed)),
      );
      yield* Deferred.await(publicationStarted);
      const interrupting = yield* Effect.forkScoped(Fiber.interrupt(running));
      yield* Effect.yieldNow;
      yield* Deferred.succeed(finishPublication, undefined);
      yield* Fiber.join(interrupting);
      const exit = yield* Fiber.await(running);
      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(
        true,
      );
      expect(yield* fs.readFileString(setup.metadata)).toContain(
        '"outcome": "published"',
      );
      expect(events).toEqual(["locked", "released"]);
    }).pipe(Effect.scoped, Effect.provide(applicationLayer)),
  );
});
