import * as nativeTasks from "./tasks.ts";
import { Effect } from "effect";
import { provideTestAgent, type AgentRunner } from "../testing/agents.ts";
import { runApplicationPromise } from "../runtime/application.ts";
import {
  writeArtifact,
  readArtifact,
  artifactExists,
  writeJsonArtifact,
  baselineResetLogRef,
  createWorkflowContext,
  implementationRestartLogRef,
  refinementLogRef,
  reviewARef,
  reviewBRef,
} from "./artifacts.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  AgentTaskRunError,
  codeRefinementTask,
  fixTask,
  implementationTask,
  reviewATask,
  reviewBTask,
} from "./tasks.ts";
import { reviewResult, submitReview } from "../testing/reviews.ts";
import {
  implementationPlanResult,
  submitTriage,
  triageResult,
} from "../testing/workflow-results.ts";
import { changeReport, submitChangeReport } from "../testing/change-reports.ts";
import { parseChangeReportJson } from "../change-report/result.ts";
import { planWorkflowProgression } from "./progression.ts";
import { buildReadinessArtifacts } from "./readiness.ts";
import { readExecutionStop } from "./execution-stop.ts";
const tempDirs: string[] = [];
afterEach(async () => {
  for (const dir of tempDirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});
async function createContext(
  options: {
    agentCwd?: string | undefined;
    model?: string | undefined;
  } = {},
) {
  const dir = await mkdtemp(path.join(tmpdir(), "roark-tasks-"));
  tempDirs.push(dir);
  const context = createWorkflowContext(
    {
      command: "do",
      issue: "12",
      cwd: dir,
      outDir: ".roark/runs",
      model: options.model,
      force: false,
      yes: false,
      maxFixPasses: 1,
    },
    { agentCwd: options.agentCwd },
  );
  await runApplicationPromise(writeArtifact(context, "issue", "# Issue\n"));
  return context;
}
describe("runAgentTask skill loading", () => {
  test("a verification repair stop survives independent progression and readiness recomputation", async () => {
    const context = await createContext();
    await writeReadyThroughPlan(context);
    await runApplicationPromise(
      writeArtifact(
        context,
        "issue",
        "# Issue\n<github_issue_relationships />\n",
      ),
    );
    await runApplicationPromise(
      writeJsonArtifact(context, "preImplementationBaseline", { head: "abc" }),
    );
    await runApplicationPromise(
      writeJsonArtifact(context, "implementationLog", changeReport()),
    );
    await runApplicationPromise(
      writeArtifact(
        context,
        refinementLogRef(0),
        JSON.stringify(changeReport()),
      ),
    );
    await runApplicationPromise(
      writeArtifact(context, reviewARef(0), JSON.stringify(reviewResult())),
    );
    await runApplicationPromise(
      writeArtifact(context, reviewBRef(0), JSON.stringify(reviewResult())),
    );
    const runner: AgentRunner = Effect.fnUntraced(function* (request) {
      return yield* Effect.tryPromise(() =>
        submitChangeReport(
          request,
          changeReport({
            blockingQuestions: ["Which compatibility behavior is authorized?"],
          }),
        ),
      );
    });
    await runApplicationPromise(
      nativeTasks
        .runChangeReportTask(context, fixTask(1))
        .pipe(provideTestAgent(runner)),
    );
    expect(await runApplicationPromise(readExecutionStop(context))).toEqual({
      name: "fixLog",
      pass: 1,
    });
    expect(
      (await runApplicationPromise(planWorkflowProgression(context)))
        .terminalStatus,
    ).toEqual({
      status: "execution-stopped",
      artifact: { name: "fixLog", pass: 1 },
    });
    for (let rebuild = 0; rebuild < 2; rebuild++) {
      const readiness = await runApplicationPromise(
        buildReadinessArtifacts(context),
      );
      expect(readiness.result.decision.executionBlocked).toBe(true);
      expect(readiness.result.decision.status).toBe("not-ready");
      await runApplicationPromise(
        writeJsonArtifact(context, "readiness", readiness.result),
      );
    }
  });
  test("runs agent requests in the explicit agent cwd", async () => {
    const agentCwd = path.join(
      await mkdtemp(path.join(tmpdir(), "roark-agent-cwd-")),
      "worktree",
    );
    tempDirs.push(path.dirname(agentCwd));
    const context = await createContext({ agentCwd });
    const requests: string[] = [];
    const runner: AgentRunner = Effect.fnUntraced(function* (request) {
      yield* Effect.void;
      requests.push(request.cwd);
      return yield* Effect.tryPromise({
        try: () => submitTriage(request, triageResult()),
        catch: (error) => error,
      });
    });
    await runApplicationPromise(
      nativeTasks
        .runTriageTask(context, toNativeRetry({}))
        .pipe(provideTestAgent(runner)),
    );
    expect(requests).toEqual([agentCwd]);
  });
  test("normal workflow tasks do not request any skill paths", async () => {
    const context = await createContext();
    const requests: unknown[] = [];
    const runner: AgentRunner = Effect.fnUntraced(function* (request) {
      yield* Effect.void;
      requests.push(request.skillPaths);
      return yield* Effect.tryPromise({
        try: () => submitTriage(request, triageResult()),
        catch: (error) => error,
      });
    });
    expect(
      runApplicationPromise(
        nativeTasks
          .runTriageTask(context, toNativeRetry({}))
          .pipe(provideTestAgent(runner)),
      ),
    ).resolves.toMatchObject({
      verdict: "proceed",
    });
    expect(requests).toEqual([undefined]);
  });
  test("sends the routed model unless the CLI supplied a global override", async () => {
    const requests: string[] = [];
    const runner: AgentRunner = Effect.fnUntraced(function* (request) {
      yield* Effect.void;
      requests.push(request.model ?? "missing");
      return yield* Effect.tryPromise({
        try: () => submitTriage(request, triageResult()),
        catch: (error) => error,
      });
    });
    await runApplicationPromise(
      nativeTasks
        .runTriageTask(await createContext(), toNativeRetry({}))
        .pipe(provideTestAgent(runner)),
    );
    await runApplicationPromise(
      nativeTasks
        .runTriageTask(
          await createContext({ model: "anthropic/claude-opus-4-7" }),
          toNativeRetry({}),
        )
        .pipe(provideTestAgent(runner)),
    );
    expect(requests).toEqual([
      "openai-codex/gpt-6-astra",
      "anthropic/claude-opus-4-7",
    ]);
  });
});
describe("runAgentTask thinking profiles", () => {
  test("routes task authority and thinking by assigned stage", async () => {
    const context = await createContext();
    context.thinkingConfig.implement = "minimal";
    context.thinkingConfig.codeRefinement = "medium";
    context.thinkingConfig.fix = "low";
    context.thinkingConfig.reviewA = "medium";
    context.thinkingConfig.reviewB = "high";
    await writeReadyThroughPlan(context);
    const requests: string[] = [];
    const runner: AgentRunner = Effect.fnUntraced(function* (request) {
      yield* Effect.void;
      requests.push(
        `${request.fileEditingToolsEnabled ? "write" : "read"}:${request.thinkingLevel}`,
      );
      if (request.display.phaseId === "refinementLog-0")
        return yield* Effect.tryPromise({
          try: () =>
            submitChangeReport(request, changeReport({ summary: "Refined." })),
          catch: (error) => error,
        });
      if (
        request.display.phaseId === "reviewA-0" ||
        request.display.phaseId === "reviewB-0"
      ) {
        return yield* Effect.tryPromise({
          try: () => submitReview(request, reviewResult()),
          catch: (error) => error,
        });
      }
      return yield* Effect.tryPromise({
        try: () => submitChangeReport(request, changeReport()),
        catch: (error) => error,
      });
    });
    await runApplicationPromise(
      nativeTasks
        .runChangeReportTask(context, implementationTask, toNativeRetry({}))
        .pipe(provideTestAgent(runner)),
    );
    await runApplicationPromise(
      nativeTasks
        .runChangeReportTask(context, codeRefinementTask(0), toNativeRetry({}))
        .pipe(provideTestAgent(runner)),
    );
    await runApplicationPromise(
      nativeTasks
        .runReviewTask(context, reviewATask, toNativeRetry({}))
        .pipe(provideTestAgent(runner)),
    );
    await runApplicationPromise(
      nativeTasks
        .runReviewTask(context, reviewBTask, toNativeRetry({}))
        .pipe(provideTestAgent(runner)),
    );
    await runApplicationPromise(
      nativeTasks
        .runChangeReportTask(context, fixTask(1), toNativeRetry({}))
        .pipe(provideTestAgent(runner)),
    );
    expect(requests).toEqual([
      "write:minimal",
      "write:medium",
      "read:medium",
      "read:high",
      "write:low",
    ]);
  });
  test("restart refinement pass uses restart artifacts instead of requiring a fix log", async () => {
    const context = await createContext();
    await writeReadyThroughReviews(context);
    await runApplicationPromise(
      writeArtifact(
        context,
        baselineResetLogRef(1),
        "# Baseline Reset Pass 1\n\n## Summary\nReset.\n",
      ),
    );
    await runApplicationPromise(
      writeArtifact(
        context,
        implementationRestartLogRef(1),
        "# Implementation Restart Log Pass 1\n\n## Summary\nRestarted.\n",
      ),
    );
    const prompts: string[] = [];
    await runApplicationPromise(
      nativeTasks
        .runChangeReportTask(
          context,
          codeRefinementTask(1, "restart"),
          toNativeRetry({}),
        )
        .pipe(
          provideTestAgent(
            Effect.fnUntraced(function* (request) {
              yield* Effect.void;
              prompts.push(request.prompt);
              return yield* Effect.tryPromise({
                try: () =>
                  submitChangeReport(
                    request,
                    changeReport({ summary: "Refined restart." }),
                  ),
                catch: (error) => error,
              });
            }),
          ),
        ),
    );
    expect(
      Effect.runSync(
        parseChangeReportJson(
          await runApplicationPromise(
            readArtifact(context, refinementLogRef(1)),
          ),
        ),
      ).summary,
    ).toBe("Refined restart.");
    expect(prompts[0]).toContain('<artifact kind="implementation_log">');
    expect(prompts[0]).toContain('<artifact kind="baseline_reset">');
    expect(prompts[0]).toContain(
      '<artifact kind="implementation_restart_log">',
    );
    expect(prompts[0]).not.toContain('<artifact kind="fix_log">');
  });
});
describe("structured task failures", () => {
  test("preserves provider failures without creating a triage artifact", async () => {
    const context = await createContext();
    let calls = 0;
    const runner: AgentRunner = Effect.fnUntraced(function* () {
      yield* Effect.void;
      calls++;
      return yield* Effect.fail(
        new Error("openai-codex/gpt-5.5 failed: provider unavailable"),
      );
    });
    let thrown: unknown;
    try {
      await runApplicationPromise(
        nativeTasks
          .runTriageTask(context, toNativeRetry({}))
          .pipe(provideTestAgent(runner)),
      );
    } catch (error) {
      thrown = error;
    }
    expect(calls).toBe(1);
    expect(thrown).toBeInstanceOf(AgentTaskRunError);
    expect(thrown).toMatchObject({ phase: "agent-error" });
    expect(await runApplicationPromise(artifactExists(context, "triage"))).toBe(
      false,
    );
  });
  test("classifies missing structured triage submission without creating an artifact", async () => {
    const context = await createContext();
    let calls = 0;
    const runner: AgentRunner = Effect.fnUntraced(function* () {
      yield* Effect.void;
      calls++;
      return "";
    });
    let thrown: unknown;
    try {
      await runApplicationPromise(
        nativeTasks
          .runTriageTask(context, toNativeRetry({}))
          .pipe(provideTestAgent(runner)),
      );
    } catch (error) {
      thrown = error;
    }
    expect(calls).toBe(1);
    expect(thrown).toBeInstanceOf(AgentTaskRunError);
    expect(thrown).toMatchObject({ phase: "output-contract" });
    expect(await runApplicationPromise(artifactExists(context, "triage"))).toBe(
      false,
    );
  });
  test("rejects implementation prose without creating a canonical report", async () => {
    const context = await createContext();
    await writeReadyThroughPlan(context);
    let thrown: unknown;
    try {
      await runApplicationPromise(
        nativeTasks
          .runChangeReportTask(context, implementationTask, toNativeRetry({}))
          .pipe(
            provideTestAgent(
              Effect.fnUntraced(function* () {
                yield* Effect.void;
                return "# Implementation Log\n\nLooks good.\n";
              }),
            ),
          ),
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AgentTaskRunError);
    expect(thrown).toMatchObject({ phase: "output-contract" });
    expect(
      await runApplicationPromise(artifactExists(context, "implementationLog")),
    ).toBe(false);
    expect(
      await runApplicationPromise(
        artifactExists(context, "implementationLogMarkdown"),
      ),
    ).toBe(false);
  });
});
describe("runReviewTask failures", () => {
  test("preserves provider failures without creating a review artifact", async () => {
    const context = await createContext();
    await writeReadyThroughPlan(context);
    await runApplicationPromise(
      writeArtifact(
        context,
        "implementationLog",
        JSON.stringify(changeReport()),
      ),
    );
    await runApplicationPromise(
      writeArtifact(
        context,
        refinementLogRef(0),
        JSON.stringify(changeReport()),
      ),
    );
    let thrown: unknown;
    try {
      await runApplicationPromise(
        nativeTasks.runReviewTask(context, reviewATask, toNativeRetry({})).pipe(
          provideTestAgent(
            Effect.fnUntraced(function* () {
              yield* Effect.void;
              return yield* Effect.fail(new Error("provider quota exhausted"));
            }),
          ),
        ),
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AgentTaskRunError);
    expect(thrown).toMatchObject({ phase: "agent-error" });
    expect(
      await runApplicationPromise(artifactExists(context, reviewARef(0))),
    ).toBe(false);
  });
  test("classifies a missing structured submission without creating a review artifact", async () => {
    const context = await createContext();
    await writeReadyThroughPlan(context);
    await runApplicationPromise(
      writeArtifact(
        context,
        "implementationLog",
        JSON.stringify(changeReport()),
      ),
    );
    await runApplicationPromise(
      writeArtifact(
        context,
        refinementLogRef(0),
        JSON.stringify(changeReport()),
      ),
    );
    let thrown: unknown;
    try {
      await runApplicationPromise(
        nativeTasks.runReviewTask(context, reviewATask, toNativeRetry({})).pipe(
          provideTestAgent(
            Effect.fnUntraced(function* () {
              yield* Effect.void;
              return "Looks good.";
            }),
          ),
        ),
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AgentTaskRunError);
    expect(thrown).toMatchObject({ phase: "output-contract" });
    expect(
      await runApplicationPromise(artifactExists(context, reviewARef(0))),
    ).toBe(false);
  });
});
async function writeReadyThroughPlan(
  context: Awaited<ReturnType<typeof createContext>>,
) {
  await runApplicationPromise(
    writeJsonArtifact(context, "triage", triageResult()),
  );
  await runApplicationPromise(
    writeJsonArtifact(
      context,
      "implementationPlanDraft",
      implementationPlanResult(),
    ),
  );
  await runApplicationPromise(
    writeJsonArtifact(
      context,
      "implementationPlan",
      implementationPlanResult(),
    ),
  );
  await runApplicationPromise(
    writeArtifact(
      context,
      "preImplementationBaseline",
      JSON.stringify({
        head: "abc123",
        capturedAt: "now",
        excludes: [".roark"],
      }),
    ),
  );
}
async function writeReadyThroughReviews(
  context: Awaited<ReturnType<typeof createContext>>,
) {
  await writeReadyThroughPlan(context);
  await runApplicationPromise(
    writeArtifact(context, "implementationLog", JSON.stringify(changeReport())),
  );
  await runApplicationPromise(
    writeArtifact(context, refinementLogRef(0), JSON.stringify(changeReport())),
  );
  await runApplicationPromise(
    writeArtifact(context, reviewARef(0), JSON.stringify(reviewResult())),
  );
  await runApplicationPromise(
    writeArtifact(context, reviewBRef(0), JSON.stringify(reviewResult())),
  );
}
describe("runAgentTask transient agent retry", () => {
  test("retries transient connection errors before writing the phase artifact", async () => {
    await Promise.resolve();
    const context = await createContext();
    const validTriage = triageResult();
    let calls = 0;
    const sleeps: number[] = [];
    const runner: AgentRunner = Effect.fnUntraced(function* (request) {
      yield* Effect.void;
      calls++;
      if (calls === 1)
        return yield* Effect.fail(
          new Error(
            "openai-codex/gpt-5.5 failed: WebSocket closed 1006 Connection ended",
          ),
        );
      return yield* Effect.tryPromise({
        try: () => submitTriage(request, validTriage),
        catch: (error) => error,
      });
    });
    const result = await runApplicationPromise(
      nativeTasks
        .runTriageTask(
          context,
          toNativeRetry({
            delaysMs: [0, 60000, 180000],
            sleep: async (ms) => {
              await Promise.resolve();
              sleeps.push(ms);
            },
          }),
        )
        .pipe(provideTestAgent(runner)),
    );
    expect(result).toEqual(validTriage);
    expect(calls).toBe(2);
    expect(sleeps).toEqual([]);
    expect(
      JSON.parse(await runApplicationPromise(readArtifact(context, "triage"))),
    ).toEqual(validTriage);
  });
  test("marks retried editing requests after a transient connection failure", async () => {
    const context = await createContext();
    await writeReadyThroughPlan(context);
    await runApplicationPromise(
      writeJsonArtifact(context, "triage", triageResult()),
    );
    await runApplicationPromise(
      writeJsonArtifact(
        context,
        "implementationPlan",
        implementationPlanResult(),
      ),
    );
    const prompts: string[] = [];
    const runner: AgentRunner = Effect.fnUntraced(function* (request) {
      yield* Effect.void;
      prompts.push(request.prompt);
      if (prompts.length === 1)
        return yield* Effect.fail(
          new Error(
            "openai-codex/gpt-5.5 failed: WebSocket closed 1006 Connection ended",
          ),
        );
      return yield* Effect.tryPromise({
        try: () => submitChangeReport(request, changeReport()),
        catch: (error) => error,
      });
    });
    expect(
      runApplicationPromise(
        nativeTasks
          .runChangeReportTask(
            context,
            implementationTask,
            toNativeRetry({
              delaysMs: [0, 60000, 180000],
              sleep: async () => {
                await Promise.resolve();
              },
            }),
          )
          .pipe(provideTestAgent(runner)),
      ),
    ).resolves.toEqual(changeReport());
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).not.toContain("<transient_connection_retry>");
    expect(prompts[1]).toContain("<transient_connection_retry>");
  });
  test("does not write diagnostic artifacts while transient retries remain", async () => {
    const context = await createContext();
    const validTriage = triageResult();
    let calls = 0;
    const runner: AgentRunner = Effect.fnUntraced(function* (request) {
      yield* Effect.void;
      calls++;
      expect(yield* artifactExists(context, "triage")).toBe(false);
      if (calls < 4)
        return yield* Effect.fail(
          new Error(
            "openai-codex/gpt-5.5 failed: WebSocket closed 1006 Connection ended",
          ),
        );
      return yield* Effect.tryPromise({
        try: () => submitTriage(request, validTriage),
        catch: (error) => error,
      });
    });
    expect(
      runApplicationPromise(
        nativeTasks
          .runTriageTask(
            context,
            toNativeRetry({
              delaysMs: [0, 1, 2],
              sleep: async () => {
                await Promise.resolve();
              },
            }),
          )
          .pipe(provideTestAgent(runner)),
      ),
    ).resolves.toEqual(validTriage);
    expect(calls).toBe(4);
    expect(
      JSON.parse(await runApplicationPromise(readArtifact(context, "triage"))),
    ).toEqual(validTriage);
  });
  test("exhausts immediate, one minute, and three minute retries before failing", async () => {
    await Promise.resolve();
    const context = await createContext();
    let calls = 0;
    const sleeps: number[] = [];
    const runner: AgentRunner = Effect.fnUntraced(function* () {
      yield* Effect.void;
      calls++;
      return yield* Effect.fail(
        new Error("openai-codex/gpt-5.5 failed: fetch failed"),
      );
    });
    expect(
      runApplicationPromise(
        nativeTasks
          .runTriageTask(
            context,
            toNativeRetry({
              delaysMs: [0, 60000, 180000],
              sleep: async (ms) => {
                await Promise.resolve();
                sleeps.push(ms);
              },
            }),
          )
          .pipe(provideTestAgent(runner)),
      ),
    ).rejects.toThrow(AgentTaskRunError);
    expect(calls).toBe(4);
    expect(sleeps).toEqual([60000, 180000]);
    expect(await runApplicationPromise(artifactExists(context, "triage"))).toBe(
      false,
    );
  });
});
function toNativeRetry(options: PromiseTaskRetryOptions) {
  const sleep = options.sleep;
  return {
    delaysMs: options.delaysMs,
    sleep: sleep ? (ms: number) => Effect.promise(() => sleep(ms)) : undefined,
  };
}
interface PromiseTaskRetryOptions {
  delaysMs?: readonly number[] | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
}
