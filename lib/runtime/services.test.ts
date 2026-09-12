import * as nativeVerification from "../autorun/verification.ts";
import { applicationLayer } from "./application.ts";
import { reviewATaskForPass } from "../workflow/tasks.ts";
import {
  verificationBeforeFixRef,
  artifactFilename,
} from "../workflow/artifact-catalog.ts";
import * as BunServices from "@effect/platform-bun/BunServices";
import {
  Deferred,
  FileSystem,
  Cause,
  Effect,
  Exit,
  PlatformError,
} from "effect";
import {
  AttemptStore,
  attemptStoreLayer,
  formatAttemptMetadata,
} from "../autorun/attempts.ts";
import { describe, expect, test } from "bun:test";
import { ChildProcessSpawner } from "effect/unstable/process";
import { AgentExecution, Presentation } from "./services.ts";
import { ArtifactStore } from "../workflow/artifact-store.ts";
import {
  createWorkflowContext,
  produceArtifact,
  requireArtifacts,
} from "../workflow/artifacts.ts";
import { Presenter } from "../presentation/presenter.ts";
import { GitHub } from "../github/service.ts";
import { fixedWallClock } from "../testing/clock.ts";
const silentPresenter = () =>
  new Presenter({ stream: { isTTY: false, write: () => undefined } });
describe("application service boundaries", () => {
  test("GitHub binds its dependencies without capturing the caller's clock", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const github = yield* GitHub;
        return yield* github
          .fetchGitHubIssueRelationships({
            cwd: "/repo",
            issueNumber: "12",
            body: "",
          })
          .pipe(Effect.provide(fixedWallClock("2001-01-01T00:00:00.000Z")));
      }).pipe(
        Effect.provide(GitHub.layer),
        Effect.provide(fixedWallClock("2000-01-01T00:00:00.000Z")),
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() =>
            Effect.die(new Error("No repository lookup should run.")),
          ),
        ),
        Effect.provideService(Presentation, silentPresenter()),
      ),
    );
    expect(result.fetchedAt).toBe("2001-01-01T00:00:00.000Z");
  });
  test("agent callers use the supplied service without constructing a Pi session", async () => {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* Effect.flatMap(AgentExecution, (agent) =>
          agent.run({
            cwd: process.cwd(),
            thinkingLevel: "low",
            systemPrompt: "",
            prompt: "request",
            fileEditingToolsEnabled: false,
            display: {
              command: "do",
              target: "#1",
              phaseId: "test",
              phaseLabel: "Test",
              operation: "inspect",
            },
          }),
        );
      }).pipe(
        Effect.provideService(AgentExecution, {
          run: (request) => Effect.succeed(request.prompt),
        }),
        Effect.provide(applicationLayer),
      ),
    );
    expect(output).toBe("request");
  });
  test("artifact reuse and writing are owned by the supplied store", async () => {
    const context = createWorkflowContext({
      command: "do",
      issue: "1",
      cwd: process.cwd(),
      outDir: "unused",
      force: false,
      yes: true,
      maxFixPasses: 1,
    });
    const contents = new Map<string, string>([
      [artifactFilename("issue"), "cached"],
    ]);
    let produced = 0;
    const store = ArtifactStore.of({
      ensure: () => Effect.void,
      exists: (_location, artifact) =>
        Effect.succeed(contents.has(artifactFilename(artifact))),
      read: (_location, artifact) =>
        Effect.succeed(contents.get(artifactFilename(artifact)) ?? ""),
      write: (_location, artifact, content) =>
        Effect.sync(() => {
          contents.set(artifactFilename(artifact), content);
        }),
    });
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const generate = Effect.sync(() => {
          produced++;
          return "fresh";
        });
        const reused = yield* produceArtifact(
          context,
          "issue",
          "Issue",
          generate,
        );
        yield* requireArtifacts(context, "issue");
        const written = yield* produceArtifact(
          { ...context, force: true },
          "issue",
          "Issue",
          generate,
        );
        return { reused, written };
      }).pipe(
        Effect.provideService(ArtifactStore, store),
        Effect.provideService(Presentation, silentPresenter()),
      ),
    );
    expect(result).toEqual({ reused: "cached", written: "fresh" });
    expect(produced).toBe(1);
    expect(contents.get(artifactFilename("issue"))).toBe("fresh");
  });
  test("GitHub best-effort lookup recovers expected failures while preserving defects", async () => {
    const defect = new Error("spawner defect");
    const failure = PlatformError.systemError({
      _tag: "PermissionDenied",
      module: "ChildProcess",
      method: "spawn",
    });
    for (const dies of [false, true]) {
      const spawner = ChildProcessSpawner.make(() =>
        dies ? Effect.die(defect) : Effect.fail(failure),
      );
      const exit = await Effect.runPromiseExit(
        Effect.flatMap(GitHub, (github) =>
          github.resolveGitHubIssueRepo({ cwd: process.cwd() }),
        ).pipe(
          Effect.provide(GitHub.layer),
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            spawner,
          ),
          Effect.provideService(Presentation, silentPresenter()),
        ),
      );
      if (dies) {
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Cause.hasDies(exit.cause)).toBe(true);
          expect(Cause.hasFails(exit.cause)).toBe(false);
          expect(Cause.squash(exit.cause)).toBe(defect);
        }
      } else {
        expect(exit).toEqual(Exit.succeed(undefined));
      }
    }
  });
});
test("verification artifact helpers retain the caller's store", async () => {
  const context = createWorkflowContext({
    command: "do",
    issue: "1",
    cwd: process.cwd(),
    outDir: "unused",
    force: false,
    yes: true,
    maxFixPasses: 1,
  });
  const writes: string[] = [];
  await Effect.runPromise(
    Effect.gen(function* () {
      return yield* nativeVerification.writeVerificationArtifact(context, {
        command: "test",
        ok: true,
        exitCode: 0,
        stdout: "done",
        stderr: "",
      });
    }).pipe(
      Effect.provideService(ArtifactStore, {
        ensure: () => Effect.void,
        exists: () => Effect.succeed(false),
        read: () => Effect.succeed(""),
        write: (_location, artifact) =>
          Effect.sync(() => {
            writes.push(artifactFilename(artifact));
          }),
      }),
      Effect.provide(applicationLayer),
    ),
  );
  expect(writes).toEqual([
    artifactFilename("verification"),
    artifactFilename("verificationFull"),
  ]);
});
test("interruption waits for an attempt write before owner finalization", async () => {
  const started = Deferred.makeUnsafe<undefined>();
  const allowWrite = Deferred.makeUnsafe<undefined>();
  const events: string[] = [];
  const controller = new AbortController();
  const fs = await Effect.runPromise(
    FileSystem.FileSystem.pipe(Effect.provide(BunServices.layer)),
  );
  const running = Effect.runPromiseExit(
    Effect.flatMap(AttemptStore, (attempts) =>
      attempts.write(
        "unused",
        formatAttemptMetadata({
          attempt: 1,
          issueNumber: 1,
          branch: "test",
          baseBranch: "main",
          worktreePath: "unused",
          runArtifactPath: "unused",
          startedAt: new Date(),
        }),
      ),
    ).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          events.push("finalized");
        }),
      ),
      Effect.provide(attemptStoreLayer),
      Effect.provideService(FileSystem.FileSystem, {
        ...fs,
        makeDirectory: () => Effect.void,
        writeFileString: () =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(allowWrite)),
            Effect.andThen(
              Effect.sync(() => {
                events.push("written");
              }),
            ),
          ),
      }),
    ),
    { signal: controller.signal },
  );
  try {
    await Effect.runPromise(Deferred.await(started));
    controller.abort();
    await Bun.sleep(10);
    expect(events).toEqual([]);
  } finally {
    await Effect.runPromise(Deferred.succeed(allowWrite, undefined));
    await running;
  }
  expect(events).toEqual(["written", "finalized"]);
});
test("prebuilt task prompts use the storage service from their execution", async () => {
  const task = reviewATaskForPass(1);
  const context = createWorkflowContext({
    command: "do",
    issue: "1",
    cwd: process.cwd(),
    outDir: "unused",
    force: false,
    yes: true,
    maxFixPasses: 1,
  });
  const checked: string[] = [];
  await Effect.runPromise(
    Effect.gen(function* () {
      return yield* task.prompt(context);
    }).pipe(
      Effect.provideService(ArtifactStore, {
        ensure: () => Effect.void,
        exists: (_location, artifact) =>
          Effect.sync(() => {
            checked.push(artifactFilename(artifact));
            return true;
          }),
        read: () => Effect.succeed(""),
        write: () => Effect.void,
      }),
      Effect.provide(applicationLayer),
    ),
  );
  expect(checked).toEqual([artifactFilename(verificationBeforeFixRef(1))]);
});
