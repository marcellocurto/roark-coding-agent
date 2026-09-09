import { afterEach, expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { mkdtemp, readFile, writeFile, rm, readdir } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { rejects as assertRejects } from "node:assert/strict";
import { runApplicationPromise } from "../runtime/application.ts";
import { runProcessOrThrow } from "../cli/process.ts";
import {
  createWorkflowContext,
  writeJsonArtifact,
  writeArtifact,
  readArtifact,
  artifactExists,
  fixLogRef,
  refinementLogRef,
  reviewARef,
  reviewBRef,
  verificationBeforeFixRef,
} from "../workflow/artifacts.ts";
import { runFullWorkflow } from "../workflow/phases.ts";
import { planWorkflowProgression } from "../workflow/progression.ts";
import { buildReadinessArtifacts } from "../workflow/readiness.ts";
import { capturePreImplementationBaseline } from "../workflow/git.ts";
import { recordExecutionStop } from "../workflow/execution-stop.ts";
import { provideTestAgent, type AgentRunner } from "../testing/agents.ts";
import {
  implementationPlanResult,
  triageResult,
} from "../testing/workflow-results.ts";
import { changeReport, submitChangeReport } from "../testing/change-reports.ts";
import { reviewResult, submitReview } from "../testing/reviews.ts";
import {
  continuationResult,
  submitContinuation,
} from "../testing/continuations.ts";
import { prepareIssueContinuation } from "./workflow.ts";
import {
  readContinuationState,
  writeContinuationState,
  applyContinuation,
  continuationHistoryDir,
} from "./checkpoint.ts";
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
const decodeQuestions = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      questions: Schema.Array(
        Schema.Struct({ id: Schema.String, question: Schema.String }),
      ),
    }),
  ),
);
const snapshot = {
  issueNumber: "12",
  repo: "owner/repo",
  fetchedAt: "2026-09-09T01:00:00Z",
  issue: {
    number: 12,
    title: "Session expiry",
    body: "Keep existing sessions. Update expiry for new sessions.",
    comments: [
      {
        id: "42",
        author: { login: "maintainer" },
        authorAssociation: "OWNER",
        body: "Keep existing sessions valid.",
        createdAt: "2026-09-09T01:00:00Z",
        updatedAt: "2026-09-09T01:01:00Z",
      },
    ],
  },
  relationships: {
    fetchedAt: "2026-09-09T01:00:00Z",
    nativeDependenciesAvailable: true,
    blockedBy: [],
    blocking: [],
    bodyDeclaredBlockers: [],
  },
};
async function fixture() {
  const cwd = await mkdtemp(path.join(tmpdir(), "roark-issue-continue-"));
  directories.push(cwd);
  await runApplicationPromise(
    runProcessOrThrow(["git", "init", "-b", "main"], { cwd }),
  );
  await writeFile(path.join(cwd, "session.txt"), "original\n");
  await runApplicationPromise(
    runProcessOrThrow(["git", "add", "session.txt"], { cwd }),
  );
  await runApplicationPromise(
    runProcessOrThrow(
      [
        "git",
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "-m",
        "baseline",
      ],
      { cwd },
    ),
  );
  const context = {
    ...createWorkflowContext({
      command: "do",
      cwd,
      issue: "12",
      outDir: ".roark/runs",
      force: false,
      yes: false,
      maxFixPasses: 2,
      attempt: 1,
    }),
    continuing: true,
  };
  const baseline = await runApplicationPromise(
    capturePreImplementationBaseline({ cwd, yes: false }),
  );
  await runApplicationPromise(
    writeJsonArtifact(context, "preImplementationBaseline", baseline),
  );
  await runApplicationPromise(
    writeArtifact(
      context,
      "issue",
      "# Original issue\n<github_issue_relationships />",
    ),
  );
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
  return { context, baseline };
}
test("continues partial implementation from a comment and discards outdated review results", async () => {
  const { context, baseline } = await fixture();
  await writeFile(path.join(context.agentCwd, "session.txt"), "partial work\n");
  await runApplicationPromise(
    writeJsonArtifact(
      context,
      "implementationLog",
      changeReport({
        blockingQuestions: ["Should existing sessions remain valid?"],
      }),
    ),
  );
  await runApplicationPromise(
    recordExecutionStop(context, "implementationLog"),
  );
  await runApplicationPromise(
    writeArtifact(context, reviewARef(0), JSON.stringify(reviewResult())),
  );
  await runApplicationPromise(
    writeArtifact(context, reviewBRef(0), JSON.stringify(reviewResult())),
  );
  const phases: string[] = [];
  const runner: AgentRunner = Effect.fnUntraced(function* (request) {
    const phase = request.display.phaseId;
    phases.push(phase);
    if (phase === "continuation-review") {
      const input = yield* readArtifact(context, "continuationInput");
      expect(input).toContain("Keep existing sessions valid.");
      const questions = decodeQuestions(input).questions;
      return yield* Effect.tryPromise(() =>
        submitContinuation(
          request,
          continuationResult({
            resumeFrom: "implement",
            resolutions: questions.map((item) => ({
              questionId: item.id,
              status: "resolved",
              answer: "Keep existing sessions valid.",
              sources: ["comment:42"],
            })),
          }),
        ),
      );
    }
    if (phase === "implementationLog") {
      expect(
        yield* Effect.promise(() =>
          readFile(path.join(context.agentCwd, "session.txt"), "utf8"),
        ),
      ).toBe("partial work\n");
      expect(yield* artifactExists(context, reviewARef(0))).toBe(false);
      expect(yield* readArtifact(context, "implementationPlan")).toContain(
        "Keep existing sessions valid.",
      );
      return yield* Effect.tryPromise(() =>
        submitChangeReport(request, changeReport()),
      );
    }
    if (phase === "refinementLog-0")
      return yield* Effect.tryPromise(() =>
        submitChangeReport(request, changeReport()),
      );
    if (phase === "reviewA-0" || phase === "reviewB-0")
      return yield* Effect.tryPromise(() =>
        submitReview(request, reviewResult()),
      );
    return yield* Effect.fail(new Error(`Unexpected phase ${phase}`));
  });
  expect(
    await runApplicationPromise(
      runFullWorkflow(context, {
        continuation: { restart: false },
        issueSnapshot: snapshot,
      }).pipe(provideTestAgent(runner)),
    ),
  ).toEqual({ status: "completed" });
  expect(phases.slice(0, 3)).toEqual([
    "continuation-review",
    "implementationLog",
    "refinementLog-0",
  ]);
  expect(phases.slice(3).sort()).toEqual(["reviewA-0", "reviewB-0"]);
  expect(
    JSON.parse(
      await runApplicationPromise(
        readArtifact(context, "preImplementationBaseline"),
      ),
    ),
  ).toEqual(baseline);
});
test("a comment that does not answer the question keeps the run stopped", async () => {
  const { context } = await fixture();
  await runApplicationPromise(
    writeJsonArtifact(
      context,
      "implementationPlan",
      implementationPlanResult(false),
    ),
  );
  let calls = 0;
  const runner: AgentRunner = Effect.fnUntraced(function* (request) {
    calls++;
    const questions = decodeQuestions(
      yield* readArtifact(context, "continuationInput"),
    ).questions;
    return yield* Effect.tryPromise(() =>
      submitContinuation(
        request,
        continuationResult({
          status: "blocked",
          resumeFrom: "plan",
          resolutions: questions.map((item) => ({
            questionId: item.id,
            status: "unresolved",
            answer: null,
            sources: [],
          })),
        }),
      ),
    );
  });
  const result = await runApplicationPromise(
    runFullWorkflow(context, {
      continuation: { restart: false },
      issueSnapshot: snapshot,
    }).pipe(provideTestAgent(runner)),
  );
  expect(result).toEqual({ status: "continuation-stopped" });
  expect(calls).toBe(1);
  expect(
    (await runApplicationPromise(planWorkflowProgression(context)))
      .terminalStatus,
  ).toEqual(result);
});
test("resumes the stopped verification fix pass after an earlier approved review", async () => {
  const { context } = await fixture();
  await runApplicationPromise(
    writeJsonArtifact(context, "implementationLog", changeReport()),
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
  await runApplicationPromise(
    writeArtifact(
      context,
      fixLogRef(1),
      JSON.stringify(
        changeReport({ blockingQuestions: ["Which expiry rule applies?"] }),
      ),
    ),
  );
  await runApplicationPromise(
    writeArtifact(
      context,
      verificationBeforeFixRef(1),
      "# Verification\nOriginal failed command",
    ),
  );
  await runApplicationPromise(recordExecutionStop(context, fixLogRef(1)));
  const runner: AgentRunner = Effect.fnUntraced(function* (request) {
    const questions = decodeQuestions(
      yield* readArtifact(context, "continuationInput"),
    ).questions;
    return yield* Effect.tryPromise(() =>
      submitContinuation(
        request,
        continuationResult({
          resumeFrom: "fix",
          pass: 1,
          resolutions: questions.map((item) => ({
            questionId: item.id,
            status: "resolved",
            answer: "The issue defines the rule.",
            sources: ["comment:42"],
          })),
        }),
      ),
    );
  });
  await runApplicationPromise(
    prepareIssueContinuation(context, { restart: false }, snapshot).pipe(
      provideTestAgent(runner),
    ),
  );
  expect(
    (await runApplicationPromise(planWorkflowProgression(context))).actions[0],
  ).toMatchObject({ type: "run", phase: "fix", pass: 1 });
  expect(
    await runApplicationPromise(
      artifactExists(context, verificationBeforeFixRef(1)),
    ),
  ).toBe(true);
  expect(
    await runApplicationPromise(artifactExists(context, reviewARef(0))),
  ).toBe(true);
  // The fix finished, but its refinement was interrupted. An unchanged issue
  // must resume pass 1 instead of falling back to the old approved pass 0.
  await runApplicationPromise(
    writeArtifact(context, fixLogRef(1), JSON.stringify(changeReport())),
  );
  const unchanged: AgentRunner = Effect.fnUntraced(function* (request) {
    expect(yield* readArtifact(context, "continuationInput")).toContain(
      '"previousContinuation"',
    );
    return yield* Effect.tryPromise(() =>
      submitContinuation(request, continuationResult()),
    );
  });
  await runApplicationPromise(
    prepareIssueContinuation(
      context,
      { restart: false, priorOutcome: "errored" },
      snapshot,
    ).pipe(provideTestAgent(unchanged)),
  );
  expect(
    (await runApplicationPromise(planWorkflowProgression(context))).actions[0],
  ).toMatchObject({ type: "run", phase: "refine-code", pass: 1 });
  const readiness = await runApplicationPromise(
    buildReadinessArtifacts(context),
  );
  expect(readiness.result.decision.status).toBe("not-ready");
  expect(readiness.result.decision.pendingWork).toBe(true);
  const blocked: AgentRunner = Effect.fnUntraced(function* (request) {
    return yield* Effect.tryPromise(() =>
      submitContinuation(
        request,
        continuationResult({
          status: "blocked",
          blockingQuestions: ["Which documented compatibility rule applies?"],
        }),
      ),
    );
  });
  await runApplicationPromise(
    prepareIssueContinuation(context, { restart: false }, snapshot).pipe(
      provideTestAgent(blocked),
    ),
  );
  expect(
    await runApplicationPromise(readContinuationState(context)),
  ).toMatchObject({ status: "blocked", resumeFrom: "fix", pass: 1 });
  const resolved: AgentRunner = Effect.fnUntraced(function* (request) {
    const questions = decodeQuestions(
      yield* readArtifact(context, "continuationInput"),
    ).questions;
    return yield* Effect.tryPromise(() =>
      submitContinuation(
        request,
        continuationResult({
          resumeFrom: "refine-code",
          pass: 1,
          resolutions: questions.map((item) => ({
            questionId: item.id,
            status: "resolved",
            answer: "The existing compatibility rule applies.",
            sources: ["comment:42"],
          })),
        }),
      ),
    );
  });
  await runApplicationPromise(
    prepareIssueContinuation(context, { restart: false }, snapshot).pipe(
      provideTestAgent(resolved),
    ),
  );
  expect(
    await runApplicationPromise(artifactExists(context, fixLogRef(1))),
  ).toBe(true);
  expect(
    (await runApplicationPromise(planWorkflowProgression(context))).actions[0],
  ).toMatchObject({ type: "run", phase: "refine-code", pass: 1 });
});
test("restart backs up work, restores the original baseline, and reads the current discussion", async () => {
  const { context, baseline } = await fixture();
  await writeFile(
    path.join(context.agentCwd, "session.txt"),
    "discard this implementation\n",
  );
  await writeFile(
    path.join(context.agentCwd, "new.txt"),
    "recoverable untracked work\n",
  );
  await runApplicationPromise(
    writeJsonArtifact(context, "implementationLog", changeReport()),
  );
  await runApplicationPromise(
    writeArtifact(
      context,
      "continuationReviewMarkdown",
      "Old decision that must not guide a restart",
    ),
  );
  await runApplicationPromise(
    prepareIssueContinuation(context, { restart: true }, snapshot),
  );
  expect(
    await readFile(path.join(context.agentCwd, "session.txt"), "utf8"),
  ).toBe("original\n");
  expect(await readdir(context.agentCwd)).not.toContain("new.txt");
  expect(
    await readFile(
      path.join(
        continuationHistoryDir(context, 1),
        "workspace",
        "untracked",
        "new.txt",
      ),
      "utf8",
    ),
  ).toBe("recoverable untracked work\n");
  expect(
    await runApplicationPromise(artifactExists(context, "implementationPlan")),
  ).toBe(false);
  expect(
    await runApplicationPromise(
      artifactExists(context, "continuationReviewMarkdown"),
    ),
  ).toBe(false);
  expect(await runApplicationPromise(readArtifact(context, "issue"))).toContain(
    "Keep existing sessions valid.",
  );
  expect(
    JSON.parse(
      await runApplicationPromise(
        readArtifact(context, "preImplementationBaseline"),
      ),
    ),
  ).toEqual(baseline);
});
test("an interrupted checkpoint blocks old approvals until invalidation is complete", async () => {
  const { context } = await fixture();
  await runApplicationPromise(
    writeJsonArtifact(context, "implementationLog", changeReport()),
  );
  await runApplicationPromise(
    writeArtifact(context, reviewARef(0), JSON.stringify(reviewResult())),
  );
  const state = {
    version: 1 as const,
    id: 1,
    status: "applying" as const,
    mode: "continue" as const,
    resumeFrom: "implement" as const,
    pass: null,
    invalidated: ["implementation-log.json", "review-a-0.json"],
    replacements: {},
    restartBaseline: null,
  };
  await runApplicationPromise(writeContinuationState(context, state));
  expect(
    (await runApplicationPromise(planWorkflowProgression(context)))
      .terminalStatus,
  ).toEqual({ status: "continuation-stopped" });
  await runApplicationPromise(applyContinuation(context, state));
  expect(
    await runApplicationPromise(artifactExists(context, reviewARef(0))),
  ).toBe(false);
  expect(
    (await runApplicationPromise(readContinuationState(context)))?.status,
  ).toBe("ready");
});
test("lowering the fix limit cannot make unfinished continuation work ready", async () => {
  const { context } = await fixture();
  await runApplicationPromise(
    writeJsonArtifact(context, "implementationLog", changeReport()),
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
  await runApplicationPromise(
    writeContinuationState(context, {
      version: 1,
      id: 1,
      status: "ready",
      mode: "continue",
      resumeFrom: "fix",
      pass: 2,
      invalidated: [],
      replacements: {},
      restartBaseline: null,
    }),
  );
  await assertRejects(
    runApplicationPromise(
      buildReadinessArtifacts({ ...context, maxFixPasses: 1 }),
    ),
    /Saved work is at pass 2/,
  );
});
