import { expect, test } from "bun:test";
import { Cause, Deferred, Effect, Exit, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { AgentExecution, Presentation } from "../runtime/services.ts";
import { applicationLayer } from "../runtime/application.ts";
import { AgentExecutionError } from "../pi/agent.ts";
import { Presenter } from "../presentation/presenter.ts";
import {
  createNoopRunObserver,
  RunObservation,
} from "../observability/observer.ts";
import { ArtifactStore } from "./artifact-store.ts";
import { createWorkflowContext } from "./artifacts.ts";
import { runSinglePhase, runFullWorkflow } from "./phases.ts";
import { AgentTaskRunError, runTriageTask } from "./tasks.ts";

const store = ArtifactStore.of({
  ensure: () => Effect.void,
  exists: () => Effect.succeed(true),
  read: () => Effect.succeed("issue content"),
  write: () => Effect.void,
});
const context = () =>
  createWorkflowContext({
    command: "do",
    issue: "1",
    cwd: process.cwd(),
    outDir: "unused",
    force: true,
    yes: true,
    maxFixPasses: 1,
  });
const presentation = new Presenter({
  stream: { isTTY: false, write: () => undefined },
});

test.each(["phase", "workflow"])(
  "native %s orchestration uses the supplied observer and preserves defects",
  async (kind) => {
    const defect = new Error("agent defect");
    const events: string[] = [];
    const current = context();
    const observer = createNoopRunObserver();
    observer.phaseFailed = () =>
      Effect.sync(() => {
        events.push("phase failed");
      });
    observer.runFailed = (error) =>
      Effect.sync(() => {
        expect(error).toBe(defect);
        events.push("run failed");
      });
    const exit = await Effect.runPromiseExit(
      (kind === "phase"
        ? runSinglePhase(current, "triage")
        : runFullWorkflow(current)
      ).pipe(
        Effect.provideService(RunObservation, observer),
        Effect.provideService(AgentExecution, {
          run: () => Effect.die(defect),
        }),
        Effect.provideService(
          ArtifactStore,
          kind === "phase"
            ? store
            : { ...store, exists: () => Effect.die(defect) },
        ),
        Effect.provideService(Presentation, presentation),
        Effect.provide(applicationLayer),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.hasDies(exit.cause)).toBe(true);
      expect(Cause.hasFails(exit.cause)).toBe(false);
    }
    expect(events).toEqual(
      kind === "phase" ? ["phase failed", "run failed"] : ["run failed"],
    );
  },
);

test("native workflow interruption joins agent cleanup before recording final failure", async () => {
  const started = Deferred.makeUnsafe<undefined>();
  const cleaning = Deferred.makeUnsafe<undefined>();
  const release = Deferred.makeUnsafe<undefined>();
  const events: string[] = [];
  const controller = new AbortController();
  const current = context();
  const observer = createNoopRunObserver();
  observer.phaseFailed = () =>
    Effect.sync(() => {
      events.push("phase failed");
    });
  observer.runFailed = () =>
    Effect.sync(() => {
      events.push("run failed");
    });
  let finished = false;
  const running = Effect.runPromiseExit(
    runSinglePhase(current, "triage").pipe(
      Effect.provideService(RunObservation, observer),
      Effect.provideService(AgentExecution, {
        run: () =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(
              Deferred.succeed(cleaning, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(
                  Effect.sync(() => {
                    events.push("agent cleaned");
                  }),
                ),
              ),
            ),
          ),
      }),
      Effect.provideService(ArtifactStore, store),
      Effect.provideService(Presentation, presentation),
      Effect.provide(applicationLayer),
    ),
    { signal: controller.signal },
  ).then((exit) => {
    finished = true;
    return exit;
  });
  try {
    await Effect.runPromise(Deferred.await(started));
    controller.abort();
    await Effect.runPromise(Deferred.await(cleaning));
    expect(finished).toBe(false);
    expect(events).toEqual([]);
  } finally {
    await Effect.runPromise(Deferred.succeed(release, undefined));
  }
  const exit = await running;
  expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(
    true,
  );
  expect(events).toEqual(["agent cleaned", "phase failed", "run failed"]);
});

test("native task retries follow the Effect clock and preserve terminal failure", async () => {
  let attempts = 0;
  const started = Deferred.makeUnsafe<undefined>();
  const failure = new AgentExecutionError({
    operation: "Run agent",
    cause: new Error("fetch failed"),
  });
  await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.forkScoped(
        Effect.exit(runTriageTask(context(), { delaysMs: [1000] })),
      );
      yield* Deferred.await(started);
      yield* TestClock.adjust(999);
      expect(attempts).toBe(1);
      yield* TestClock.adjust(1);
      const exit = yield* Fiber.join(fiber);
      expect(attempts).toBe(2);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit))
        expect(Cause.squash(exit.cause)).toBeInstanceOf(AgentTaskRunError);
    }).pipe(
      Effect.scoped,
      Effect.provideService(AgentExecution, {
        run: () =>
          Effect.sync(() => {
            attempts++;
          }).pipe(
            Effect.andThen(Deferred.succeed(started, undefined)),
            Effect.andThen(Effect.fail(failure)),
          ),
      }),
      Effect.provideService(ArtifactStore, store),
      Effect.provideService(Presentation, presentation),
      Effect.provide(TestClock.layer()),
      Effect.provide(applicationLayer),
    ),
  );
});

test("non-transient task failures neither retry nor announce a retry", async () => {
  let attempts = 0;
  let output = "";
  const stream = {
    isTTY: false,
    write(chunk: string) {
      output += chunk;
    },
  };
  const failure = new AgentExecutionError({
    operation: "Run agent",
    cause: new Error("invalid API key"),
  });
  const exit = await Effect.runPromiseExit(
    runTriageTask(context()).pipe(
      Effect.provideService(AgentExecution, {
        run: () =>
          Effect.sync(() => {
            attempts++;
          }).pipe(Effect.andThen(Effect.fail(failure))),
      }),
      Effect.provideService(ArtifactStore, store),
      Effect.provideService(
        Presentation,
        new Presenter({ stream, errorStream: stream }),
      ),
      Effect.provide(applicationLayer),
    ),
  );
  expect(Exit.isFailure(exit)).toBe(true);
  expect(attempts).toBe(1);
  expect(output).not.toContain("retry");
});
