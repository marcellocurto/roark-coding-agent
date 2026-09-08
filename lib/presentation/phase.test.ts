import { Cause, Effect, Exit } from "effect";
import { Presentation } from "../runtime/services.ts";
import { runPresentedPhase as nativeRunPresentedPhase } from "./phase.ts";
import { Presenter } from "./presenter.ts";
import { describe, expect, spyOn, test } from "bun:test";
import { type AgentDisplayContext } from "./presenter.ts";
import { runPresentedPhasePromise as runPresentedPhase } from "./phase-promise.ts";

const display: AgentDisplayContext = {
  command: "do",
  target: "#1",
  phaseId: "test",
  phaseLabel: "Test phase",
  operation: "verify",
};

describe("runPresentedPhase", () => {
  test("presents successful and failed completion consistently", async () => {
    let output = "";
    const presentation = new Presenter({
      stream: {
        isTTY: false,
        write(chunk) {
          output += chunk;
        },
      },
    });
    await Effect.runPromise(
      nativeRunPresentedPhase(
        display,
        () =>
          Effect.sync(() => {
            expect(output).toContain("PHASE #1 · Test phase");
            return "done";
          }),
        (outcome) => ({ outcome, artifact: "result.md" }),
      ).pipe(Effect.provideService(Presentation, presentation)),
    );
    const failure = new Error("broken");
    const exit = await Effect.runPromiseExit(
      nativeRunPresentedPhase(
        display,
        () => Effect.fail(failure),
        () => ({}),
      ).pipe(Effect.provideService(Presentation, presentation)),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBe(failure);
    expect(output).toContain("DONE #1 · Test phase · done");
    expect(output).toContain("artifact: result.md");
    expect(output).toContain("FAILED #1 · Test phase · broken");
  });
});

test("standalone phases share one presenter per execution and isolate concurrent runs", async () => {
  const starts: Presenter[] = [];
  const completions: Presenter[] = [];
  const start = spyOn(Presenter.prototype, "phaseStarted").mockImplementation(
    function (this: Presenter) {
      starts.push(this);
    },
  );
  const complete = spyOn(
    Presenter.prototype,
    "phaseCompleted",
  ).mockImplementation(function (this: Presenter) {
    completions.push(this);
  });
  try {
    await Promise.all([
      runPresentedPhase(
        display,
        () => Promise.resolve("first"),
        (outcome) => ({ outcome }),
      ),
      runPresentedPhase(
        display,
        () => Promise.resolve("second"),
        (outcome) => ({ outcome }),
      ),
    ]);
    expect(starts).toHaveLength(2);
    expect(starts[0]).not.toBe(starts[1]);
    expect(new Set(completions)).toEqual(new Set(starts));
  } finally {
    start.mockRestore();
    complete.mockRestore();
  }
});
