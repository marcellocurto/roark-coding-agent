import { GitHub } from "../github/service.ts";
import { fixedWallClock } from "../testing/clock.ts";
import { AttemptStore, formatAttemptMetadata } from "./attempts.ts";
import {
  readArtifact,
  writeArtifact,
  writeJsonArtifact,
  refinementLogRef,
  reviewARef,
  reviewBRef,
  verificationBeforeFixRef,
  type WorkflowContext,
} from "../workflow/artifacts.ts";
import { runProcessOrThrow } from "../cli/process.ts";
import { rejects as assertRejects } from "node:assert/strict";
import { GitWorkspaceError } from "../workflow/git.ts";
import { WorkspaceError } from "./workspace.ts";
import * as artifactEffects from "../workflow/artifacts.ts";
import { provideTestAgent } from "../testing/agents.ts";
import { Effect } from "effect";
import { readRunSummary } from "../observability/summary.ts";
import {
  runApplicationPromise,
  applicationLayer,
} from "../runtime/application.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getWorkflowThinkingConfig } from "../workflow/thinking.ts";
import { AgentTaskRunError } from "../workflow/tasks.ts";
import { runAutorunAttemptLifecycle } from "./attempt-lifecycle.ts";
import { type AutorunBranchPlan } from "./branch.ts";
import { type AutorunGateOptions } from "./publish-flow.ts";
import {
  reviewFinding,
  reviewResult,
  submitReview,
} from "../testing/reviews.ts";
import {
  implementationPlanResult,
  triageResult,
} from "../testing/workflow-results.ts";
import { parseReadinessResultJson } from "../workflow/readiness.ts";
import { changeReport, submitChangeReport } from "../testing/change-reports.ts";
const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
describe("runAutorunAttemptLifecycle", () => {
  test("reuses and persists one status across repeated workflow exceptions", async () => {
    const fixture = await createFixture();
    const remote = new Map<number, string>();
    for (let retry = 0; retry < 2; retry++) {
      if (retry > 0)
        fixture.attemptMetadata = await runApplicationPromise(
          Effect.flatMap(AttemptStore, (store) =>
            store.read(fixture.issueDir, 1),
          ),
        );
      await assertRejects(
        runApplicationPromise(
          Effect.gen(function* () {
            const github = yield* GitHub;
            yield* runAutorunAttemptLifecycle(fixture, {
              runFullWorkflow: () =>
                Effect.fail(
                  new AgentTaskRunError({
                    artifact: "implementationLog",
                    label: "Implementation",
                    phase: "agent-error",
                    originalError: new Error("provider overloaded"),
                  }),
                ),
            }).pipe(
              Effect.provideService(GitHub, {
                ...github,
                addIssueLabel: () => Effect.void,
                removeIssueLabel: () => Effect.void,
                postIssueComment: () =>
                  Effect.die("must use marked publishing"),
                postOrUpdateIssueCommentByMarker: (input) =>
                  Effect.sync(() => {
                    expect(input.marker).toContain("phase=attempt-status");
                    expect(input.existingCommentId).toBe(
                      retry === 0 ? undefined : 301,
                    );
                    remote.set(input.existingCommentId ?? 301, input.body);
                    return { id: 301, marker: input.marker };
                  }),
              }),
            );
          }),
        ),
      );
      const saved = await runApplicationPromise(
        Effect.flatMap(AttemptStore, (store) =>
          store.read(fixture.issueDir, 1),
        ),
      );
      expect(saved.githubComments?.issue?.["attempt-status"]?.id).toBe(301);
    }
    expect(remote.size).toBe(1);
    expect(remote.get(301)).toContain("provider overloaded");
    expect(remote.get(301)).toContain("roark continue 44");
  });
  test("marks attempts in-progress before workflow and records terminal completion outcomes", async () => {
    await Promise.resolve();
    const fixture = await createFixture();
    await runApplicationPromise(
      runAutorunAttemptLifecycle(
        {
          ...fixture,
          issue: {
            number: 44,
            title: "Lifecycle",
            url: "https://github.com/owner/repo/issues/44",
          },
        },
        {
          runFullWorkflow: Effect.fnUntraced(function* () {
            yield* Effect.void;
            const duringWorkflow = yield* Effect.promise(() =>
              runApplicationPromise(
                Effect.flatMap(AttemptStore, (store) =>
                  store.read(fixture.issueDir, 1),
                ),
              ),
            );
            expect(duringWorkflow.outcome).toBe("in-progress");
            expect(duringWorkflow.endedAt).toBeNull();
            expect(
              (yield* Effect.promise(() =>
                runApplicationPromise(
                  Effect.flatMap(AttemptStore, (store) =>
                    store.list(fixture.issueDir),
                  ),
                ),
              ))[0]?.outcome,
            ).toBe("in-progress");
            return { status: "completed" as const };
          }),
          completeAutorunWorkflow: Effect.fnUntraced(function* () {
            return (
              yield* Effect.void,
              {
                outcome: "failed-verification" as const,
                outcomeDetail: "verification failed",
              }
            );
          }),
          finalizeAttemptObservability: Effect.fnUntraced(function* () {
            yield* Effect.void;
          }),
        },
      ).pipe(Effect.provide(fixedWallClock("2026-05-07T01:00:00.000Z"))),
    );
    const terminal = await runApplicationPromise(
      Effect.flatMap(AttemptStore, (store) => store.read(fixture.issueDir, 1)),
    );
    expect(terminal.outcome).toBe("failed-verification");
    expect(terminal.outcomeDetail).toBe("verification failed");
    expect(terminal.endedAt).toBe("2026-05-07T01:00:00.000Z");
    expect(
      (
        await runApplicationPromise(
          Effect.flatMap(AttemptStore, (store) => store.list(fixture.issueDir)),
        )
      )[0]?.outcome,
    ).toBe("failed-verification");
  });
  test("runs fix, refinement, reviews, readiness, and completion again for verification repair", async () => {
    await Promise.resolve();
    const fixture = await createFixture();
    await writeCompletedWorkflowArtifacts(fixture.workflowContext);
    const phases: string[] = [];
    let completions = 0;
    await runApplicationPromise(
      runAutorunAttemptLifecycle(
        {
          ...fixture,
          issue: {
            number: 44,
            title: "Lifecycle",
            url: "https://github.com/owner/repo/issues/44",
          },
        },
        {
          runFullWorkflow: Effect.fnUntraced(function* () {
            return (yield* Effect.void, { status: "completed" as const });
          }),
          completeAutorunWorkflow: Effect.fnUntraced(function* () {
            completions += 1;
            if (completions === 1) {
              yield* artifactEffects.writeArtifact(
                fixture.workflowContext,
                verificationBeforeFixRef(1),
                "# Verification\n\n## Exit Code\n1\n",
              );
              return {
                outcome: "verification-needs-fix" as const,
                outcomeDetail: "verify command exited 1",
                pass: 1,
              };
            }
            return { outcome: "published" as const, outcomeDetail: null };
          }),
          finalizeAttemptObservability: Effect.fnUntraced(function* () {
            yield* Effect.void;
          }),
        },
      )
        .pipe(Effect.provide(fixedWallClock("2026-05-07T01:30:00.000Z")))
        .pipe(
          provideTestAgent(
            Effect.fnUntraced(function* (request) {
              yield* Effect.void;
              phases.push(request.display.phaseId);
              expect(request.prompt).toContain("failed_verification");
              if (request.display.phaseId === "fixLog-1") {
                return yield* Effect.tryPromise({
                  try: () =>
                    submitChangeReport(
                      request,
                      changeReport({
                        summary: "Addressed verification failure.",
                      }),
                    ),
                  catch: (error) => error,
                });
              }
              if (request.display.phaseId === "refinementLog-1") {
                return yield* Effect.tryPromise({
                  try: () =>
                    submitChangeReport(
                      request,
                      changeReport({ summary: "Refined." }),
                    ),
                  catch: (error) => error,
                });
              }
              if (request.display.phaseId === "reviewA-1") {
                return yield* Effect.tryPromise({
                  try: () => submitReview(request, reviewResult()),
                  catch: (error) => error,
                });
              }
              if (request.display.phaseId === "reviewB-1") {
                return yield* Effect.tryPromise({
                  try: () => submitReview(request, reviewResult()),
                  catch: (error) => error,
                });
              }
              return yield* Effect.fail(
                new Error(`unexpected phase ${request.display.phaseId}`),
              );
            }),
          ),
        ),
    );
    const summary = await runApplicationPromise(
      readRunSummary(path.join(fixture.workflowContext.runDir, "summary.json")),
    );
    expect(summary?.phases["fixLog-1"]?.status).toBe("completed");
    expect(summary?.phases["reviewA-1"]?.status).toBe("completed");
    expect(summary?.phases["reviewB-1"]?.status).toBe("completed");
    expect(completions).toBe(2);
    expect(phases.slice(0, 2)).toEqual(["fixLog-1", "refinementLog-1"]);
    expect(phases.slice(2).toSorted()).toEqual(["reviewA-1", "reviewB-1"]);
    expect(
      Effect.runSync(
        parseReadinessResultJson(
          await runApplicationPromise(
            readArtifact(fixture.workflowContext, "readiness"),
          ),
        ),
      ).decision.status,
    ).toBe("ready-for-pr");
    const terminal = await runApplicationPromise(
      Effect.flatMap(AttemptStore, (store) => store.read(fixture.issueDir, 1)),
    );
    expect(terminal.outcome).toBe("published");
  });
  test("continues verification repair when the numbered review requests another fix pass", async () => {
    await Promise.resolve();
    const fixture = await createFixture();
    await writeCompletedWorkflowArtifacts(fixture.workflowContext);
    const phases: string[] = [];
    let completions = 0;
    await runApplicationPromise(
      runAutorunAttemptLifecycle(
        {
          ...fixture,
          issue: {
            number: 44,
            title: "Lifecycle",
            url: "https://github.com/owner/repo/issues/44",
          },
        },
        {
          runFullWorkflow: Effect.fnUntraced(function* () {
            return (yield* Effect.void, { status: "completed" as const });
          }),
          completeAutorunWorkflow: Effect.fnUntraced(function* () {
            completions += 1;
            if (completions === 1) {
              yield* artifactEffects.writeArtifact(
                fixture.workflowContext,
                verificationBeforeFixRef(1),
                "# Verification\n\n## Exit Code\n1\n",
              );
              return {
                outcome: "verification-needs-fix" as const,
                outcomeDetail: "verify command exited 1",
                pass: 1,
              };
            }
            return { outcome: "published" as const, outcomeDetail: null };
          }),
          finalizeAttemptObservability: Effect.fnUntraced(function* () {
            yield* Effect.void;
          }),
        },
      )
        .pipe(Effect.provide(fixedWallClock("2026-05-07T01:45:00.000Z")))
        .pipe(
          provideTestAgent(
            Effect.fnUntraced(function* (request) {
              yield* Effect.void;
              phases.push(request.display.phaseId);
              if (request.display.phaseId === "fixLog-1") {
                return yield* Effect.tryPromise({
                  try: () =>
                    submitChangeReport(
                      request,
                      changeReport({
                        summary: "Partially addressed verification failure.",
                        validation: [
                          {
                            command: "bun test",
                            status: "failed",
                            details: "Numbered review requested another fix.",
                          },
                        ],
                        remainingConcerns: [
                          "Numbered review requested another fix.",
                        ],
                      }),
                    ),
                  catch: (error) => error,
                });
              }
              if (request.display.phaseId === "refinementLog-1") {
                return yield* Effect.tryPromise({
                  try: () =>
                    submitChangeReport(
                      request,
                      changeReport({ summary: "Refined." }),
                    ),
                  catch: (error) => error,
                });
              }
              if (request.display.phaseId === "reviewA-1") {
                return yield* Effect.tryPromise({
                  try: () =>
                    submitReview(
                      request,
                      reviewResult([
                        reviewFinding(
                          "must-fix-current",
                          "Numbered review requested another fix.",
                        ),
                      ]),
                    ),
                  catch: (error) => error,
                });
              }
              if (request.display.phaseId === "reviewB-1") {
                return yield* Effect.tryPromise({
                  try: () => submitReview(request, reviewResult()),
                  catch: (error) => error,
                });
              }
              if (request.display.phaseId === "fixLog-2") {
                return yield* Effect.tryPromise({
                  try: () =>
                    submitChangeReport(
                      request,
                      changeReport({
                        summary: "Completed verification repair.",
                        addressedFindingIds: [
                          "review-a:numbered-review-requested-another-fix",
                        ],
                      }),
                    ),
                  catch: (error) => error,
                });
              }
              if (request.display.phaseId === "refinementLog-2") {
                return yield* Effect.tryPromise({
                  try: () =>
                    submitChangeReport(
                      request,
                      changeReport({ summary: "Refined." }),
                    ),
                  catch: (error) => error,
                });
              }
              if (request.display.phaseId === "reviewA-2") {
                return yield* Effect.tryPromise({
                  try: () => submitReview(request, reviewResult()),
                  catch: (error) => error,
                });
              }
              if (request.display.phaseId === "reviewB-2") {
                return yield* Effect.tryPromise({
                  try: () => submitReview(request, reviewResult()),
                  catch: (error) => error,
                });
              }
              return yield* Effect.fail(
                new Error(`unexpected phase ${request.display.phaseId}`),
              );
            }),
          ),
        ),
    );
    expect(completions).toBe(2);
    expect(phases).toHaveLength(8);
    for (const pass of [1, 2]) {
      const start = (pass - 1) * 4;
      expect(phases.slice(start, start + 2)).toEqual([
        `fixLog-${pass}`,
        `refinementLog-${pass}`,
      ]);
      expect(phases.slice(start + 2, start + 4).toSorted()).toEqual([
        `reviewA-${pass}`,
        `reviewB-${pass}`,
      ]);
    }
    expect(
      Effect.runSync(
        parseReadinessResultJson(
          await runApplicationPromise(
            readArtifact(fixture.workflowContext, "readiness"),
          ),
        ),
      ).decision.status,
    ).toBe("ready-for-pr");
    const terminal = await runApplicationPromise(
      Effect.flatMap(AttemptStore, (store) => store.read(fixture.issueDir, 1)),
    );
    expect(terminal.outcome).toBe("published");
  });
  test("classifies output-contract failures and includes failing artifact details in the failure comment", async () => {
    await Promise.resolve();
    const fixture = await createFixture();
    await runApplicationPromise(
      writeArtifact(
        fixture.workflowContext,
        "implementationLog",
        "# Implementation Log\n\ninvalid output\n",
      ),
    );
    const comments: string[] = [];
    const error = new AgentTaskRunError({
      artifact: "implementationLog",
      label: "Implementation",
      phase: "output-contract",
      originalError: new Error("missing Summary section"),
    });
    await assertRejects(
      runApplicationPromise(
        runAutorunAttemptLifecycle(
          {
            ...fixture,
            issue: {
              number: 44,
              title: "Lifecycle",
              url: "https://github.com/owner/repo/issues/44",
            },
          },
          {
            runFullWorkflow: Effect.fnUntraced(function* () {
              yield* Effect.void;
              return yield* Effect.fail(error);
            }),
            publishReviewLedgerComments: Effect.fnUntraced(function* () {
              yield* Effect.void;
            }),
            markIssueFailed: Effect.fnUntraced(function* (options) {
              yield* Effect.void;
              comments.push(options.comment);
              expect(options.removeLabels).toEqual(["busy"]);
              return undefined;
            }),
            finalizeAttemptObservability: Effect.fnUntraced(function* () {
              yield* Effect.void;
            }),
          },
        ).pipe(Effect.provide(fixedWallClock("2026-05-07T02:00:00.000Z"))),
      ),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes(
          "Implementation failed: missing Summary section",
        ),
    );
    const terminal = await runApplicationPromise(
      Effect.flatMap(AttemptStore, (store) => store.read(fixture.issueDir, 1)),
    );
    expect(terminal.outcome).toBe("failed-output-contract");
    expect(terminal.outcomeDetail).toBe(
      "Implementation failed: missing Summary section",
    );
    expect(terminal.endedAt).toBe("2026-05-07T02:00:00.000Z");
    const comment = comments[0] ?? "";
    expect(comment).toContain("phase **output-contract**");
    expect(comment).toContain("Implementation failed: missing Summary section");
    expect(comment).not.toContain(".roark/runs/");
    expect(comment).toContain("invalid output");
    expect(comment).toContain(
      "roark continue 44 --repo owner/repo --attempt 1",
    );
    expect(comment).not.toContain("--cwd");
    expect(comment).not.toContain(fixture.gateOptions.cwd);
  });
  test("runs fatal beforeRun after metadata is persisted and before workflow", async () => {
    await Promise.resolve();
    const fixture = await createFixture();
    const calls: string[] = [];
    await assertRejects(
      runApplicationPromise(
        runAutorunAttemptLifecycle(
          {
            ...fixture,
            issue: { number: 44, title: "Lifecycle" },
            beforeRun: Effect.fnUntraced(function* () {
              yield* Effect.void;
              const persisted = yield* Effect.promise(() =>
                runApplicationPromise(
                  Effect.flatMap(AttemptStore, (store) =>
                    store.read(fixture.issueDir, 1),
                  ),
                ),
              );
              expect(persisted.outcome).toBe("in-progress");
              calls.push("beforeRun");
              return yield* Effect.fail(
                new WorkspaceError({ message: "setup failed" }),
              );
            }),
          },
          {
            runFullWorkflow: Effect.fnUntraced(function* () {
              yield* Effect.void;
              calls.push("workflow");
              return { status: "completed" as const };
            }),
            publishReviewLedgerComments: Effect.fnUntraced(function* () {
              yield* Effect.void;
            }),
            markIssueFailed: Effect.fnUntraced(function* () {
              return (yield* Effect.void, undefined);
            }),
            finalizeAttemptObservability: Effect.fnUntraced(function* () {
              yield* Effect.void;
            }),
          },
        ).pipe(Effect.provide(fixedWallClock("2026-05-07T02:45:00.000Z"))),
      ),
      (error: unknown) =>
        error instanceof Error && error.message.includes("setup failed"),
    );
    expect(calls).toEqual(["beforeRun"]);
    const terminal = await runApplicationPromise(
      Effect.flatMap(AttemptStore, (store) => store.read(fixture.issueDir, 1)),
    );
    expect(terminal.outcome).toBe("errored");
    expect(terminal.outcomeDetail).toBe("setup failed");
    expect(terminal.endedAt).toBe("2026-05-07T02:45:00.000Z");
  });
  test("classifies generic failures as errored and records terminal metadata from finally", async () => {
    await Promise.resolve();
    const fixture = await createFixture();
    const comments: string[] = [];
    await assertRejects(
      runApplicationPromise(
        runAutorunAttemptLifecycle(
          {
            ...fixture,
            issue: { number: 44, title: "Lifecycle" },
          },
          {
            runFullWorkflow: Effect.fnUntraced(function* () {
              yield* Effect.void;
              return yield* Effect.fail(
                new GitWorkspaceError({ message: "workflow exploded" }),
              );
            }),
            publishReviewLedgerComments: Effect.fnUntraced(function* () {
              yield* Effect.void;
            }),
            markIssueFailed: Effect.fnUntraced(function* (options) {
              yield* Effect.void;
              comments.push(options.comment);
              return undefined;
            }),
            finalizeAttemptObservability: Effect.fnUntraced(function* () {
              yield* Effect.void;
            }),
          },
        ).pipe(Effect.provide(fixedWallClock("2026-05-07T03:00:00.000Z"))),
      ),
      (error: unknown) =>
        error instanceof Error && error.message.includes("workflow exploded"),
    );
    const terminal = await runApplicationPromise(
      Effect.flatMap(AttemptStore, (store) => store.read(fixture.issueDir, 1)),
    );
    expect(terminal.outcome).toBe("errored");
    expect(terminal.outcomeDetail).toBe("workflow exploded");
    expect(terminal.endedAt).toBe("2026-05-07T03:00:00.000Z");
    expect(comments[0]).toContain("phase **workflow-error**");
  });
});
async function writeCompletedWorkflowArtifacts(
  context: WorkflowContext,
): Promise<void> {
  await runApplicationPromise(
    writeArtifact(
      context,
      "issue",
      '# GitHub Issue #44\n\n<github_issue_relationships source="gh" />\n',
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
  await runApplicationPromise(
    writeArtifact(
      context,
      "preImplementationBaseline",
      JSON.stringify({ head: "abc", capturedAt: "now", excludes: [".roark"] }),
    ),
  );
  await runApplicationPromise(
    writeArtifact(context, "implementationLog", JSON.stringify(changeReport())),
  );
  await runApplicationPromise(
    writeArtifact(
      context,
      refinementLogRef(0),
      JSON.stringify(changeReport({ summary: "Refined." })),
    ),
  );
  await runApplicationPromise(
    writeArtifact(context, reviewARef(0), JSON.stringify(reviewResult())),
  );
  await runApplicationPromise(
    writeArtifact(context, reviewBRef(0), JSON.stringify(reviewResult())),
  );
}
async function createFixture(): Promise<{
  issueDir: string;
  workflowContext: WorkflowContext;
  branchPlan: AutorunBranchPlan;
  gateOptions: AutorunGateOptions;
  attemptMetadata: ReturnType<typeof formatAttemptMetadata>;
}> {
  const cwd = await mkdtemp(path.join(tmpdir(), "roark-lifecycle-"));
  tempDirs.push(cwd);
  await runApplicationPromise(runProcessOrThrow(["git", "init"], { cwd }));
  const issueDir = path.join(cwd, ".roark/runs/issue/44");
  const runDirRelative = ".roark/runs/issue/44/attempts/1";
  const runDir = path.join(cwd, runDirRelative);
  await mkdir(runDir, { recursive: true });
  const workflowContext: WorkflowContext = {
    controlCwd: cwd,
    agentCwd: cwd,
    outDir: path.join(cwd, ".roark/runs"),
    runDir,
    runDirRelative,
    issueInput: "44",
    issueNumber: "44",
    attempt: 1,
    repo: "owner/repo",
    force: false,
    yes: false,
    maxFixPasses: 3,
    thinkingConfig: getWorkflowThinkingConfig(),
  };
  const branchPlan: AutorunBranchPlan = {
    issueNumber: 44,
    branchName: "roark/issue-44",
    baseBranch: "main",
  };
  const gateOptions: AutorunGateOptions = {
    cwd,
    repo: "owner/repo",
    verifyCommand: "bun test",
    failureLabel: "failed",
    successLabel: "opened",
    inProgressLabel: "busy",
    remote: "origin",
    baseBranch: "main",
  };
  const attemptMetadata = formatAttemptMetadata({
    attempt: 1,
    issueNumber: 44,
    branch: "roark/issue-44",
    baseBranch: "main",
    worktreePath: cwd,
    runArtifactPath: runDirRelative,
    startedAt: "2026-05-07T00:00:00.000Z",
  });
  return {
    issueDir,
    workflowContext,
    branchPlan,
    gateOptions,
    attemptMetadata,
  };
}
test("attempt finalization persists metadata and observability even when afterRun defects", async () => {
  const fixture = await createFixture();
  let finalized = false;
  await Effect.runPromise(
    runAutorunAttemptLifecycle(
      {
        ...fixture,
        issue: {
          number: 44,
          title: "Lifecycle",
          url: "https://github.com/owner/repo/issues/44",
        },
        afterRun: () => Effect.die(new Error("afterRun defect")),
      },
      {
        runFullWorkflow: () => Effect.succeed({ status: "completed" }),
        completeAutorunWorkflow: () =>
          Effect.succeed({
            outcome: "failed-readiness",
            outcomeDetail: "not ready",
          }),
        finalizeAttemptObservability: () => {
          finalized = true;
          return Effect.void;
        },
      },
    ).pipe(Effect.provide(applicationLayer)),
  );
  const metadata = await runApplicationPromise(
    Effect.flatMap(AttemptStore, (store) => store.read(fixture.issueDir, 1)),
  );
  expect(metadata.outcome).toBe("failed-readiness");
  expect(typeof metadata.endedAt).toBe("string");
  expect(finalized).toBe(true);
});
