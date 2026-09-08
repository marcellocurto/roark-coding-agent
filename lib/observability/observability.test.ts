import { Schema } from "effect";
import { runApplicationPromise } from "../runtime/application.ts";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { finalizeAttemptObservability } from "../autorun/observability.ts";
import {
  createWorkflowContext,
  type WorkflowContext,
} from "../workflow/artifacts.ts";
import { createEventWriter } from "./events.ts";
import { createFileRunObserver } from "./observer.ts";
import { renderStatus } from "./status.ts";
import { readRunSummary, updateRunSummary } from "./summary.ts";
const tempDirs: string[] = [];
afterEach(async () => {
  for (const dir of tempDirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "roark-observe-"));
  tempDirs.push(dir);
  return dir;
}
function context(cwd: string, attempt?: number): WorkflowContext {
  return createWorkflowContext({
    command: "do",
    issue: "42",
    cwd,
    outDir: ".roark/runs",
    repo: "owner/repo",
    force: false,
    yes: false,
    maxFixPasses: 1,
    attempt,
  });
}
describe("observability event writing", () => {
  test("appends sanitized JSONL events", async () => {
    const cwd = await tempDir();
    const runDir = path.join(cwd, ".roark/runs/issue/42");
    const writer = await runApplicationPromise(
      createEventWriter(runDir, {
        now: () => new Date("2026-01-01T00:00:00.000Z"),
      }),
    );
    await runApplicationPromise(
      writer.write({
        type: "tool_started",
        toolName: "bash",
        args: { command: "secret" },
        result: "hidden",
      }),
    );
    await runApplicationPromise(
      writer.write({ type: "phase_completed", phase: "triage" }),
    );
    const lines = (await readFile(path.join(runDir, "events.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as unknown);
    expect(lines).toEqual([
      {
        type: "tool_started",
        timestamp: "2026-01-01T00:00:00.000Z",
        toolName: "bash",
      },
      {
        type: "phase_completed",
        timestamp: "2026-01-01T00:00:00.000Z",
        phase: "triage",
      },
    ]);
  });
  test("warns instead of throwing when event writes fail", async () => {
    const cwd = await tempDir();
    const runDir = path.join(cwd, "not-a-directory");
    await writeFile(runDir, "file");
    const warnings: string[] = [];
    const writer = await runApplicationPromise(
      createEventWriter(runDir, { warn: (message) => warnings.push(message) }),
    );
    await runApplicationPromise(writer.write({ type: "run_started" }));
    expect(warnings.join("\n")).toContain("observability event write failed");
  });
});
describe("observability summary writing", () => {
  test("records phase status and Pi session totals", async () => {
    const cwd = await tempDir();
    const runContext = context(cwd, 2);
    const observer = await runApplicationPromise(
      createFileRunObserver(runContext),
    );
    await runApplicationPromise(observer.runStarted({ command: "do" }));
    await runApplicationPromise(
      observer.phaseStarted({
        phase: "triage",
        label: "Triage",
        artifact: "triage",
        model: "provider/model",
        thinkingLevel: "max",
      }),
    );
    await runApplicationPromise(
      observer.agentSessionStarted({
        phase: "triage",
        sessionId: "session-1",
        model: "provider/model",
        thinkingLevel: "xhigh",
        requestedThinkingLevel: "max",
        effectiveThinkingLevel: "xhigh",
      }),
    );
    await runApplicationPromise(
      observer.agentSessionStats({
        phase: "triage",
        stats: {
          sessionId: "session-1",
          toolCalls: 3,
          tokens: {
            input: 10,
            output: 20,
            cacheRead: 1,
            cacheWrite: 2,
            total: 33,
          },
          cost: 0.0123,
        },
      }),
    );
    await runApplicationPromise(
      observer.phaseCompleted({
        phase: "triage",
        label: "Triage",
        artifact: "triage",
        thinkingLevel: "max",
      }),
    );
    await runApplicationPromise(observer.runCompleted({ status: "completed" }));
    const summary = Schema.decodeUnknownSync(
      Schema.fromJsonString(
        Schema.Struct({
          status: Schema.String,
          attempt: Schema.Number,
          phases: Schema.Struct({
            triage: Schema.Struct({
              status: Schema.String,
              artifactPath: Schema.String,
              sessionId: Schema.String,
              thinkingLevel: Schema.String,
              requestedThinkingLevel: Schema.String,
              effectiveThinkingLevel: Schema.String,
            }),
          }),
          totals: Schema.Record(Schema.String, Schema.Unknown),
        }),
      ),
    )(await readFile(path.join(runContext.runDir, "summary.json"), "utf8"));
    expect(summary.status).toBe("completed");
    expect(summary.attempt).toBe(2);
    expect(summary.phases.triage.status).toBe("completed");
    expect(summary.phases.triage.artifactPath).toBe(
      ".roark/runs/issue/42/attempts/2/triage.json",
    );
    expect(summary.phases.triage.sessionId).toBe("session-1");
    expect(summary.phases.triage).toMatchObject({
      thinkingLevel: "xhigh",
      requestedThinkingLevel: "max",
      effectiveThinkingLevel: "xhigh",
    });
    expect(summary.totals).toMatchObject({
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 33,
      toolCalls: 3,
      cost: 0.0123,
    });
  });
  test("resets run-scoped summary state when a new run starts", async () => {
    const cwd = await tempDir();
    const runContext = context(cwd);
    const observer = await runApplicationPromise(
      createFileRunObserver(runContext),
    );
    await runApplicationPromise(observer.runStarted({ command: "do" }));
    await runApplicationPromise(
      observer.phaseStarted({
        phase: "triage",
        label: "Triage",
        artifact: "triage",
      }),
    );
    await runApplicationPromise(
      observer.agentSessionStats({
        phase: "triage",
        stats: { toolCalls: 2, tokens: { total: 5 }, cost: 0.02 },
      }),
    );
    await runApplicationPromise(
      observer.phaseCompleted({
        phase: "triage",
        label: "Triage",
        artifact: "triage",
      }),
    );
    await runApplicationPromise(observer.runCompleted({ status: "completed" }));
    await runApplicationPromise(observer.runStarted({ command: "triage" }));
    const summary = Schema.decodeUnknownSync(
      Schema.fromJsonString(
        Schema.Struct({
          status: Schema.String,
          phases: Schema.Record(Schema.String, Schema.Unknown),
          totals: Schema.Record(Schema.String, Schema.Unknown),
        }),
      ),
    )(await readFile(path.join(runContext.runDir, "summary.json"), "utf8"));
    expect(summary.status).toBe("running");
    expect(summary.phases).toEqual({});
    expect(summary.totals).toMatchObject({
      totalTokens: 0,
      toolCalls: 0,
      cost: 0,
    });
    expect(summary).not.toHaveProperty("endedAt");
    expect(summary).not.toHaveProperty("durationMs");
  });
  test("finalizes autorun attempt outcome events and summary timing after gates", async () => {
    const cwd = await tempDir();
    const runContext = context(cwd, 1);
    await runApplicationPromise(
      updateRunSummary(runContext, (summary) => {
        summary.status = "completed";
        summary.startedAt = "2026-05-07T00:00:00.000Z";
        summary.endedAt = "2026-05-07T00:00:01.000Z";
      }),
    );
    await runApplicationPromise(
      finalizeAttemptObservability({
        context: runContext,
        outcome: "failed-verification",
        outcomeDetail: "verification failed",
        endedAt: "2026-05-07T00:00:05.000Z",
      }),
    );
    const events = (
      await readFile(path.join(runContext.runDir, "events.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as unknown);
    expect(events.at(-1)).toMatchObject({
      type: "attempt_failed",
      timestamp: "2026-05-07T00:00:05.000Z",
      outcome: "failed-verification",
      status: "failed",
      outcomeDetail: "verification failed",
    });
    const summary = Schema.decodeUnknownSync(
      Schema.fromJsonString(
        Schema.Struct({
          status: Schema.String,
          endedAt: Schema.String,
          durationMs: Schema.Number,
          lastError: Schema.String,
        }),
      ),
    )(await readFile(path.join(runContext.runDir, "summary.json"), "utf8"));
    expect(summary.status).toBe("failed");
    expect(summary.endedAt).toBe("2026-05-07T00:00:05.000Z");
    expect(summary.durationMs).toBe(5000);
    expect(summary.lastError).toBe("verification failed");
  });
  test("warns instead of throwing when summary writes fail", async () => {
    const cwd = await tempDir();
    const badRunDir = path.join(cwd, "not-a-directory");
    await writeFile(badRunDir, "file");
    const runContext = { ...context(cwd), runDir: badRunDir };
    const warnings: string[] = [];
    await runApplicationPromise(
      updateRunSummary(
        runContext,
        (summary) => {
          summary.status = "running";
        },
        { warn: (message) => warnings.push(message) },
      ),
    );
    expect(warnings.join("\n")).toContain("observability summary write failed");
  });
});
describe("status rendering", () => {
  test("ignores invalid summary data instead of passing it to status rendering", async () => {
    const cwd = await tempDir();
    const summaryPath = path.join(cwd, "summary.json");
    await writeFile(
      summaryPath,
      JSON.stringify({ version: 1, status: "running", phases: null }),
    );
    expect(
      await runApplicationPromise(readRunSummary(summaryPath)),
    ).toBeUndefined();
  });
  test("renders a specific attempt summary", async () => {
    const cwd = await tempDir();
    const summaryDir = path.join(cwd, ".roark/runs/issue/42/attempts/2");
    await mkdir(summaryDir, { recursive: true });
    await writeFile(
      path.join(summaryDir, "summary.json"),
      JSON.stringify(
        {
          version: 1,
          issueNumber: "42",
          attempt: 2,
          runDir: ".roark/runs/issue/42/attempts/2",
          status: "failed",
          startedAt: "2026-01-01T00:00:00.000Z",
          endedAt: "2026-01-01T00:00:02.000Z",
          durationMs: 2000,
          phases: {
            triage: {
              phase: "triage",
              label: "Triage",
              status: "failed",
              errorMessage: "provider unavailable",
              totals: {
                inputTokens: 1,
                outputTokens: 2,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                totalTokens: 3,
                cost: 0.01,
                toolCalls: 1,
              },
            },
          },
          totals: {
            inputTokens: 1,
            outputTokens: 2,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            totalTokens: 3,
            cost: 0.01,
            toolCalls: 1,
          },
          lastError: "provider unavailable",
          recoveryCommand: "roark continue 42 --repo owner/repo --attempt 2",
        },
        null,
        2,
      ),
    );
    const output = await runApplicationPromise(
      renderStatus({
        command: "status",
        issue: "42",
        all: false,
        cwd,
        outDir: ".roark/runs",
        repo: "owner/repo",
        attempt: 2,
      }),
    );
    expect(output).toContain("Issue #42 attempt 2");
    expect(output).toContain("Status: failed");
    expect(output).toContain("Totals: tokens=3");
    expect(output).toContain("Last error: provider unavailable");
    expect(output).toContain(
      "Recovery: roark continue 42 --repo owner/repo --attempt 2",
    );
    expect(output).toContain("- Triage: failed");
  });
  test("renders all known direct and attempt summaries", async () => {
    const cwd = await tempDir();
    const summaryDir = path.join(cwd, ".roark/runs/issue/7");
    const attemptDir = path.join(summaryDir, "attempts/1");
    await mkdir(attemptDir, { recursive: true });
    await writeFile(
      path.join(summaryDir, "summary.json"),
      JSON.stringify({
        version: 1,
        issueNumber: "7",
        runDir: ".roark/runs/issue/7",
        status: "completed",
        durationMs: 50,
        phases: {},
        totals: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 12,
          cost: 0,
          toolCalls: 0,
        },
      }),
    );
    await writeFile(
      path.join(attemptDir, "summary.json"),
      JSON.stringify({
        version: 1,
        issueNumber: "7",
        attempt: 1,
        runDir: ".roark/runs/issue/7/attempts/1",
        status: "failed",
        durationMs: 75,
        phases: {},
        totals: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 21,
          cost: 0,
          toolCalls: 0,
        },
      }),
    );
    const output = await runApplicationPromise(
      renderStatus({
        command: "status",
        all: true,
        cwd,
        outDir: ".roark/runs",
      }),
    );
    expect(output).toContain("Known Roark runs:");
    expect(output).toContain("#7: completed");
    expect(output).toContain("tokens=12");
    expect(output).toContain("#7 attempt 1: failed");
    expect(output).toContain("tokens=21");
  });
});
