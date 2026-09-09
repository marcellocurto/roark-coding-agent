import { Deferred, Effect, Fiber, FileSystem } from "effect";
import { expect, test } from "bun:test";
import {
  removeAgentPrReviewArtifacts,
  writePrReviewInputArtifact,
  type PrReviewContext,
} from "./artifacts.ts";
import { getWorkflowThinkingConfig } from "../workflow/thinking.ts";

test("interruption waits for mirrored review input before cleanup", async () => {
  const context: PrReviewContext = {
    controlCwd: "/control",
    agentCwd: "/agent",
    outDir: "/control/runs",
    repo: "owner/repo",
    prNumber: 1,
    generation: 1,
    reviewDir: "/control/runs/review-1",
    reviewDirRelative: "runs/review-1",
    agentReviewDir: "/agent/.git/review-1",
    agentReviewDirRelative: ".git/review-1",
    thinkingConfig: getWorkflowThinkingConfig(),
    comment: false,
  };
  await Effect.runPromise(
    Effect.gen(function* () {
      const writingMirror = yield* Deferred.make<undefined>();
      const finishMirror = yield* Deferred.make<undefined>();
      const events: string[] = [];
      const fs = FileSystem.makeNoop({
        makeDirectory: () => Effect.void,
        writeFileString: Effect.fnUntraced(function* (path) {
          if (path.startsWith(context.agentReviewDir)) {
            yield* Deferred.succeed(writingMirror, undefined);
            yield* Deferred.await(finishMirror);
            events.push("mirrored");
          } else events.push("retained");
        }),
        remove: () =>
          Effect.sync(() => {
            events.push("cleanup");
          }),
      });
      const writer = yield* Effect.forkScoped(
        writePrReviewInputArtifact(context, "input.md", "input").pipe(
          Effect.ensuring(
            removeAgentPrReviewArtifacts(context).pipe(Effect.orDie),
          ),
          Effect.provideService(FileSystem.FileSystem, fs),
        ),
      );
      yield* Deferred.await(writingMirror);
      const interruption = yield* Effect.forkScoped(Fiber.interrupt(writer));
      yield* Effect.yieldNow;
      yield* Deferred.succeed(finishMirror, undefined);
      yield* Fiber.join(interruption);
      expect(events).toEqual(["retained", "mirrored", "cleanup"]);
    }).pipe(Effect.scoped),
  );
});
