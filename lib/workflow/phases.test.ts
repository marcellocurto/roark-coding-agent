import { rejects as assertRejects } from "node:assert/strict";
import { Cause, Deferred, Effect, Exit, Fiber } from "effect";
import { runApplicationPromise } from "../runtime/application.ts";
import {
  writeArtifact,
  writeJsonArtifact,
  readArtifact,
  artifactExists,
  createWorkflowContext,
  fixLogMarkdownRef,
  fixLogRef,
  refinementLogRef,
  reviewAMarkdownRef,
  reviewARef,
  reviewBMarkdownRef,
  reviewBRef,
} from "./artifacts.ts";
import * as nativePhases from "./phases.ts";
import { provideTestAgent, type AgentRunner } from "../testing/agents.ts";
import { runProcessOrThrow } from "../cli/process.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { issueArtifactHasRelationshipSnapshot } from "./phases.ts";
import {
  reviewFinding,
  reviewResult,
  submitReview,
} from "../testing/reviews.ts";
import { parseReviewResultJson, type ReviewResult } from "../review/result.ts";
import {
  implementationPlanResult,
  submitImplementationPlan,
  submitTriage,
  triageResult,
} from "../testing/workflow-results.ts";
import { parseImplementationPlanResultJson } from "../implementation-plan/result.ts";
import { parseReadinessResultJson } from "./readiness.ts";
import { changeReport, submitChangeReport } from "../testing/change-reports.ts";
import { parseChangeReportJson } from "../change-report/result.ts";
import { readExecutionStop, recordExecutionStop } from "./execution-stop.ts";
import { planWorkflowProgression } from "./progression.ts";
const tempDirs: string[] = [];
describe("plan adoption and decision gates", () => {
  test("forced reassessment retains a stop through failure and clears it only after replacement implementation succeeds", async () => {
    const context = { ...(await tempContext()), force: true };
    await runApplicationPromise(
      runProcessOrThrow(["git", "init", "-b", "main"], {
        cwd: context.agentCwd,
      }),
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
          "--allow-empty",
          "-m",
          "baseline",
        ],
        { cwd: context.agentCwd },
      ),
    );
    await seedBaselineAndImplementation(context);
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
    await runApplicationPromise(
      writeArtifact(
        context,
        fixLogRef(1),
        JSON.stringify(
          changeReport({
            blockingQuestions: ["Which retention policy applies?"],
          }),
        ),
      ),
    );
    await runApplicationPromise(recordExecutionStop(context, fixLogRef(1)));
    const issueSnapshot = {
      issue: {
        number: 12,
        title: "Migration",
        body: "Approved plan: retain existing data.",
        comments: [
          {
            author: { login: "maintainer" },
            createdAt: "2026-09-09T00:00:00Z",
            body: "Retain existing data; no deletion is authorized.",
          },
        ],
      },
      issueNumber: "12",
      repo: "owner/repo",
      fetchedAt: "2026-09-09T00:00:01Z",
      relationships: {
        fetchedAt: "2026-09-09T00:00:01Z",
        nativeDependenciesAvailable: true,
        blockedBy: [],
        blocking: [],
        bodyDeclaredBlockers: [],
      },
    };
    let failImplementation = true;
    const runner: AgentRunner = Effect.fnUntraced(function* (request) {
      const phase = request.display.phaseId;
      if (phase === "triage") {
        expect(yield* readArtifact(context, "issue")).toContain(
          "no deletion is authorized",
        );
        expect(yield* readExecutionStop(context)).toEqual(fixLogRef(1));
        return yield* Effect.tryPromise(() =>
          submitTriage(
            request,
            triageResult("proceed", {
              planAction: "adopt",
              planSource: "Issue body",
            }),
          ),
        );
      }
      if (phase === "implementationPlan")
        return yield* Effect.tryPromise(() =>
          submitImplementationPlan(
            request,
            implementationPlanResult(true, { source: "Issue body" }),
          ),
        );
      if (phase === "implementationLog") {
        expect(yield* readExecutionStop(context)).toEqual(fixLogRef(1));
        if (failImplementation)
          return yield* Effect.fail(new Error("implementation interrupted"));
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
    await assertRejects(
      runApplicationPromise(
        nativePhases
          .runFullWorkflow(context, { issueSnapshot })
          .pipe(provideTestAgent(runner)),
      ),
      /implementation interrupted/,
    );
    expect(
      (
        await runApplicationPromise(
          planWorkflowProgression({ ...context, force: false }),
        )
      ).terminalStatus,
    ).toEqual({ status: "execution-stopped", artifact: fixLogRef(1) });
    failImplementation = false;
    expect(
      await runApplicationPromise(
        nativePhases
          .runFullWorkflow(context, { issueSnapshot })
          .pipe(provideTestAgent(runner)),
      ),
    ).toEqual({ status: "completed" });
    expect(
      await runApplicationPromise(readExecutionStop(context)),
    ).toBeUndefined();
  });
  test.each(["adopt", "adapt"] as const)(
    "%s reaches implementation without a drafting agent",
    async (planAction) => {
      const context = await tempContext();
      await runApplicationPromise(
        runProcessOrThrow(["git", "init", "-b", "main"], {
          cwd: context.agentCwd,
        }),
      );
      await runApplicationPromise(
        writeJsonArtifact(context, "preImplementationBaseline", {
          head: "abc",
          capturedAt: "now",
          excludes: [".roark"],
        }),
      );
      const source = "Issue body: Approved migration plan";
      const plan = implementationPlanResult(true, {
        source,
        detailedSteps: [
          "Add a nullable column.",
          "Backfill without deleting source data.",
          "Switch reads after backfill.",
        ],
        adaptations:
          planAction === "adapt"
            ? [
                {
                  change: "Use the renamed storage module.",
                  evidence:
                    "Current migration entry point imports lib/storage.ts.",
                },
              ]
            : [],
      });
      const phases: string[] = [];
      const runner: AgentRunner = Effect.fnUntraced(function* (request) {
        phases.push(request.display.phaseId);
        if (
          request.customTools?.some((tool) => tool.name === "submit_triage") ===
          true
        )
          return yield* Effect.tryPromise(() =>
            submitTriage(
              request,
              triageResult("proceed", { planAction, planSource: source }),
            ),
          );
        if (
          request.customTools?.some(
            (tool) => tool.name === "submit_implementation_plan",
          ) === true
        ) {
          expect(request.prompt).not.toContain(
            'artifact kind="implementation_plan_draft"',
          );
          return yield* Effect.tryPromise(() =>
            submitImplementationPlan(request, plan),
          );
        }
        if (request.display.phaseId === "implementationLog") {
          expect(
            yield* parseImplementationPlanResultJson(
              yield* readArtifact(context, "implementationPlan"),
            ),
          ).toEqual(plan);
          return yield* Effect.tryPromise(() =>
            submitChangeReport(
              request,
              changeReport({
                blockingQuestions: ["May existing sessions be invalidated?"],
              }),
            ),
          );
        }
        return yield* Effect.fail(
          new Error(`Unexpected phase after stop: ${request.display.phaseId}`),
        );
      });
      const result = await runApplicationPromise(
        nativePhases.runFullWorkflow(context).pipe(provideTestAgent(runner)),
      );
      expect(phases).toEqual([
        "triage",
        "implementationPlan",
        "implementationLog",
      ]);
      expect(result).toEqual({
        status: "execution-stopped",
        artifact: "implementationLog",
      });
      expect(
        await runApplicationPromise(
          artifactExists(context, "implementationPlanDraft"),
        ),
      ).toBe(false);
      const readiness = Effect.runSync(
        parseReadinessResultJson(
          await runApplicationPromise(readArtifact(context, "readiness")),
        ),
      );
      expect(readiness.decision.executionBlocked).toBe(true);
      expect(readiness.decision.status).toBe("not-ready");
    },
  );
  test("a material question discovered in drafting stops before plan acceptance", async () => {
    const context = await tempContext();
    const phases: string[] = [];
    const runner: AgentRunner = Effect.fnUntraced(function* (request) {
      phases.push(request.display.phaseId);
      if (request.display.phaseId === "triage")
        return yield* Effect.tryPromise(() =>
          submitTriage(request, triageResult()),
        );
      if (request.display.phaseId === "implementationPlanDraft")
        return yield* Effect.tryPromise(() =>
          submitImplementationPlan(request, implementationPlanResult(false)),
        );
      return yield* Effect.fail(
        new Error("A later agent must not resolve a missing human decision."),
      );
    });
    const result = await runApplicationPromise(
      nativePhases.runFullWorkflow(context).pipe(provideTestAgent(runner)),
    );
    expect(result).toEqual({
      status: "planning-stopped",
      planningArtifact: "implementationPlanDraft",
    });
    expect(phases).toEqual(["triage", "implementationPlanDraft"]);
  });
  test.each(["triage", "draft", "plan"] as const)(
    "standalone implementation cannot bypass a stopped %s",
    async (stage) => {
      const context = await tempContext();
      await runApplicationPromise(
        runProcessOrThrow(["git", "init", "-b", "main"], {
          cwd: context.agentCwd,
        }),
      );
      await runApplicationPromise(
        writeJsonArtifact(
          context,
          "triage",
          triageResult(stage === "triage" ? "needs-human-decision" : "proceed"),
        ),
      );
      await runApplicationPromise(
        writeJsonArtifact(
          context,
          "implementationPlanDraft",
          implementationPlanResult(stage !== "draft"),
        ),
      );
      await runApplicationPromise(
        writeJsonArtifact(
          context,
          "implementationPlan",
          implementationPlanResult(stage !== "plan"),
        ),
      );
      let calls = 0;
      const runner: AgentRunner = Effect.fnUntraced(function* () {
        calls++;
        return yield* Effect.fail(new Error("Implementation must not run."));
      });
      await assertRejects(
        runApplicationPromise(
          nativePhases
            .runSinglePhase(context, "implement")
            .pipe(provideTestAgent(runner)),
        ),
      );
      expect(calls).toBe(0);
    },
  );
});
afterEach(async () => {
  for (const dir of tempDirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});
async function tempContext() {
  const dir = await mkdtemp(path.join(tmpdir(), "roark-phases-"));
  tempDirs.push(dir);
  const context = createWorkflowContext({
    command: "do",
    issue: "12",
    cwd: dir,
    outDir: ".roark/runs",
    force: false,
    yes: true,
    maxFixPasses: 1,
    attempt: 1,
  });
  await runApplicationPromise(
    writeArtifact(
      context,
      "issue",
      '# GitHub Issue #12\n\n<github_issue_relationships source="gh">\n  <blocking_status active_blockers="0" total_blockers="0" />\n</github_issue_relationships>\n',
    ),
  );
  return context;
}
describe("issueArtifactHasRelationshipSnapshot", () => {
  test("requires a machine-generated relationship snapshot before reusing issue artifacts", () => {
    expect(issueArtifactHasRelationshipSnapshot("# GitHub Issue #12\n")).toBe(
      false,
    );
    expect(
      issueArtifactHasRelationshipSnapshot(
        '<github_issue_relationships source="gh"><blocking_status active_blockers="0" /></github_issue_relationships>',
      ),
    ).toBe(true);
  });
});
describe("review pass selection", () => {
  test("reruns the first invalid review pair instead of advancing to a later pass", async () => {
    const context = await tempContext();
    await runApplicationPromise(
      writeJsonArtifact(context, "triage", proceedTriage()),
    );
    await runApplicationPromise(
      writeJsonArtifact(context, "implementationPlan", readyPlan()),
    );
    await seedBaselineAndImplementation(context);
    await runApplicationPromise(
      writeArtifact(context, refinementLogRef(0), refinementLog()),
    );
    await runApplicationPromise(
      writeArtifact(context, reviewARef(0), "not valid review JSON"),
    );
    await runApplicationPromise(
      writeArtifact(context, reviewBRef(0), JSON.stringify(approveReview())),
    );
    const phases: string[] = [];
    await runApplicationPromise(
      nativePhases.runSinglePhase(context, "review").pipe(
        provideTestAgent(
          Effect.fnUntraced(function* (request) {
            yield* Effect.void;
            phases.push(request.display.phaseId);
            return yield* Effect.tryPromise({
              try: () => submitReview(request, approveReview()),
              catch: (error) => error,
            });
          }),
        ),
      ),
    );
    expect(phases).toEqual(["reviewA-0"]);
    expect(
      JSON.parse(
        await runApplicationPromise(readArtifact(context, reviewARef(0))),
      ),
    ).toEqual(approveReview());
    expect(
      await runApplicationPromise(artifactExists(context, reviewARef(1))),
    ).toBe(false);
    expect(
      await runApplicationPromise(artifactExists(context, reviewBRef(1))),
    ).toBe(false);
  });
  test("starts both reviewers together and retains Review B when Review A fails", async () => {
    const context = await tempContext();
    await runApplicationPromise(
      writeJsonArtifact(context, "triage", proceedTriage()),
    );
    await runApplicationPromise(
      writeJsonArtifact(context, "implementationPlan", readyPlan()),
    );
    await seedBaselineAndImplementation(context);
    await runApplicationPromise(
      writeArtifact(context, refinementLogRef(0), refinementLog()),
    );
    await runApplicationPromise(
      Effect.gen(function* () {
        const pendingReviewA = yield* Deferred.make<string, Error>();
        const reviewAStarted = yield* Deferred.make<undefined>();
        const reviewBStarted = yield* Deferred.make<undefined>();
        const run = yield* Effect.forkScoped(
          nativePhases.reviewPhase(context, 0).pipe(
            provideTestAgent(
              Effect.fnUntraced(function* (request) {
                if (request.display.phaseId === "reviewA-0") {
                  yield* Deferred.succeed(reviewAStarted, undefined);
                  return yield* Deferred.await(pendingReviewA);
                }
                yield* Deferred.succeed(reviewBStarted, undefined);
                return yield* Effect.tryPromise({
                  try: () => submitReview(request, approveReview()),
                  catch: (error) => error,
                });
              }),
            ),
          ),
        );
        yield* Deferred.await(reviewAStarted);
        yield* Deferred.await(reviewBStarted);
        yield* Deferred.fail(pendingReviewA, new Error("review A unavailable"));
        const exit = yield* Fiber.await(run);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit))
          expect(Cause.pretty(exit.cause)).toContain("review A unavailable");
      }).pipe(Effect.scoped, Effect.timeout("3 seconds")),
    );
    expect(
      await runApplicationPromise(artifactExists(context, reviewARef(0))),
    ).toBe(false);
    expect(
      await runApplicationPromise(artifactExists(context, reviewBRef(0))),
    ).toBe(true);
  });
});
describe("runFullWorkflow", () => {
  test("force consumes a supplied pre-claim snapshot without fetching GitHub again", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "roark-supplied-snapshot-"));
    tempDirs.push(dir);
    const context = createWorkflowContext({
      command: "do",
      issue: "12",
      cwd: dir,
      outDir: ".roark/runs",
      force: true,
      yes: true,
      maxFixPasses: 1,
      attempt: 1,
    });
    const issueSnapshot = {
      issue: {
        number: 12,
        title: "Fresh pre-claim title",
        body: "Fresh pre-claim body",
      },
      issueNumber: "12",
      repo: "owner/repo",
      fetchedAt: "2026-05-07T00:00:01.000Z",
      relationships: {
        fetchedAt: "2026-05-07T00:00:00.000Z",
        repo: "owner/repo",
        nativeDependenciesAvailable: true,
        blockedBy: [],
        blocking: [],
        bodyDeclaredBlockers: [],
      },
    };
    const runner: AgentRunner = Effect.fnUntraced(function* (request) {
      return yield* Effect.tryPromise({
        try: () => submitTriage(request, triageResult("blocked")),
        catch: (error) => error,
      });
    });
    const result = await runApplicationPromise(
      nativePhases
        .runFullWorkflow(context, { issueSnapshot })
        .pipe(provideTestAgent(runner)),
    );
    expect(result).toEqual({
      status: "triage-stopped",
      triageVerdict: "blocked",
    });
    expect(
      await runApplicationPromise(readArtifact(context, "issue")),
    ).toContain("Fresh pre-claim title");
    expect(
      JSON.parse(
        await runApplicationPromise(readArtifact(context, "metadata")),
      ),
    ).toMatchObject({
      issueNumber: "12",
      fetchedAt: "2026-05-07T00:00:01.000Z",
      issue: { title: "Fresh pre-claim title" },
    });
  });
  test("returns triage-stopped and does not run later agents after blocked triage", async () => {
    const context = await tempContext();
    const prompts: string[] = [];
    const runner: AgentRunner = Effect.fnUntraced(function* (request) {
      yield* Effect.void;
      prompts.push(request.prompt);
      return yield* Effect.tryPromise({
        try: () => submitTriage(request, triageResult("blocked")),
        catch: (error) => error,
      });
    });
    const result = await runApplicationPromise(
      nativePhases.runFullWorkflow(context, {}).pipe(provideTestAgent(runner)),
    );
    expect(result).toEqual({
      status: "triage-stopped",
      triageVerdict: "blocked",
    });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('name="triage"');
    expect(
      await runApplicationPromise(artifactExists(context, "readiness")),
    ).toBe(true);
    expect(
      await runApplicationPromise(
        artifactExists(context, "implementationPlan"),
      ),
    ).toBe(false);
    expect(
      await runApplicationPromise(artifactExists(context, "implementationLog")),
    ).toBe(false);
    expect(
      Effect.runSync(
        parseReadinessResultJson(
          await runApplicationPromise(readArtifact(context, "readiness")),
        ),
      ).decision.triageVerdict,
    ).toBe("blocked");
  });
  test("returns planning-stopped and does not implement when plan is not ready", async () => {
    const context = await tempContext();
    const phases: string[] = [];
    const runner: AgentRunner = Effect.fnUntraced(function* (request) {
      yield* Effect.void;
      if (request.prompt.includes('name="triage"')) {
        phases.push("triage");
        return yield* Effect.tryPromise({
          try: () => submitTriage(request, proceedTriage()),
          catch: (error) => error,
        });
      }
      if (request.prompt.includes('name="implementation_plan_draft"')) {
        phases.push("plan-draft");
        return yield* Effect.tryPromise({
          try: () => submitImplementationPlan(request, readyPlanDraft()),
          catch: (error) => error,
        });
      }
      if (request.prompt.includes('name="implementation_plan_refinement"')) {
        phases.push("plan");
        return yield* Effect.tryPromise({
          try: () => submitImplementationPlan(request, notReadyPlan()),
          catch: (error) => error,
        });
      }
      phases.push("unexpected");
      return yield* Effect.fail(new Error("unexpected prompt"));
    });
    expect(
      runApplicationPromise(
        nativePhases
          .runFullWorkflow(context, {})
          .pipe(provideTestAgent(runner)),
      ),
    ).resolves.toEqual({
      status: "planning-stopped",
    });
    expect(phases).toEqual(["triage", "plan-draft", "plan"]);
    expect(
      await runApplicationPromise(artifactExists(context, "readiness")),
    ).toBe(true);
    expect(
      await runApplicationPromise(artifactExists(context, "implementationLog")),
    ).toBe(false);
  });
  test("completed path returns completed", async () => {
    const context = await tempContext();
    await seedBaselineAndImplementation(context);
    const runner: AgentRunner = Effect.fnUntraced(function* (request) {
      yield* Effect.void;
      if (request.prompt.includes('name="triage"'))
        return yield* Effect.tryPromise({
          try: () => submitTriage(request, proceedTriage()),
          catch: (error) => error,
        });
      if (request.prompt.includes('name="implementation_plan_draft"'))
        return yield* Effect.tryPromise({
          try: () => submitImplementationPlan(request, readyPlanDraft()),
          catch: (error) => error,
        });
      if (request.prompt.includes('name="implementation_plan_refinement"'))
        return yield* Effect.tryPromise({
          try: () => submitImplementationPlan(request, readyPlan()),
          catch: (error) => error,
        });
      if (request.prompt.includes('name="code_refinement"'))
        return yield* Effect.tryPromise({
          try: () =>
            submitChangeReport(request, changeReport({ summary: "Refined." })),
          catch: (error) => error,
        });
      if (
        request.prompt.includes('name="review_a"') ||
        request.prompt.includes('name="review_b"')
      ) {
        return yield* Effect.tryPromise({
          try: () => submitReview(request, approveReview()),
          catch: (error) => error,
        });
      }
      return yield* Effect.fail(new Error("unexpected prompt"));
    });
    expect(
      runApplicationPromise(
        nativePhases
          .runFullWorkflow(context, {})
          .pipe(provideTestAgent(runner)),
      ),
    ).resolves.toEqual({
      status: "completed",
    });
  });
  test("preserves novel plan and review sections without letting them change routing", async () => {
    const context = await tempContext();
    await seedBaselineAndImplementation(context);
    const plan = implementationPlanResult(true, {
      additionalSections: [
        {
          heading: "Repository-specific interaction",
          items: [
            "The existing adapter is shared by a command not named in the issue.",
          ],
        },
      ],
    });
    const review = reviewResult([], {
      additionalSections: [
        {
          heading: "Positive architectural signal",
          items: [
            "The change reuses the established adapter seam without new indirection.",
          ],
        },
      ],
    });
    const runner: AgentRunner = Effect.fnUntraced(function* (request) {
      yield* Effect.void;
      if (request.prompt.includes('name="triage"'))
        return yield* Effect.tryPromise({
          try: () => submitTriage(request, proceedTriage()),
          catch: (error) => error,
        });
      if (request.prompt.includes('name="implementation_plan_draft"'))
        return yield* Effect.tryPromise({
          try: () => submitImplementationPlan(request, readyPlanDraft()),
          catch: (error) => error,
        });
      if (request.prompt.includes('name="implementation_plan_refinement"'))
        return yield* Effect.tryPromise({
          try: () => submitImplementationPlan(request, plan),
          catch: (error) => error,
        });
      if (request.prompt.includes('name="code_refinement"'))
        return yield* Effect.tryPromise({
          try: () =>
            submitChangeReport(request, changeReport({ summary: "Refined." })),
          catch: (error) => error,
        });
      if (request.prompt.includes('name="review_a"'))
        return yield* Effect.tryPromise({
          try: () => submitReview(request, review),
          catch: (error) => error,
        });
      if (request.prompt.includes('name="review_b"'))
        return yield* Effect.tryPromise({
          try: () => submitReview(request, approveReview()),
          catch: (error) => error,
        });
      return yield* Effect.fail(new Error("unexpected prompt"));
    });
    expect(
      runApplicationPromise(
        nativePhases
          .runFullWorkflow(context, {})
          .pipe(provideTestAgent(runner)),
      ),
    ).resolves.toEqual({
      status: "completed",
    });
    expect(
      Effect.runSync(
        parseImplementationPlanResultJson(
          await runApplicationPromise(
            readArtifact(context, "implementationPlan"),
          ),
        ),
      ).additionalSections,
    ).toEqual(plan.additionalSections);
    expect(
      await runApplicationPromise(
        readArtifact(context, "implementationPlanMarkdown"),
      ),
    ).toContain("## Repository-specific interaction");
    expect(
      Effect.runSync(
        parseReviewResultJson(
          await runApplicationPromise(readArtifact(context, reviewARef(0))),
          {
            allowRestart: true,
          },
        ),
      ).additionalSections,
    ).toEqual(review.additionalSections);
    expect(
      await runApplicationPromise(readArtifact(context, reviewAMarkdownRef(0))),
    ).toContain("## Positive architectural signal");
    expect(
      Effect.runSync(
        parseReadinessResultJson(
          await runApplicationPromise(readArtifact(context, "readiness")),
        ),
      ).decision.status,
    ).toBe("ready-for-pr");
  });
  test("persists both reviewers' required findings, fixes them, and becomes ready after approval", async () => {
    const context = await tempContext();
    await runApplicationPromise(
      runProcessOrThrow(["git", "init", "-b", "main"], {
        cwd: context.agentCwd,
      }),
    );
    await seedBaselineAndImplementation(context);
    const reviewAFindings = [
      reviewFinding("must-fix-current", "Reject malformed identifiers"),
      reviewFinding("must-fix-current", "Seed authorization state"),
    ];
    const reviewBFindings = [
      reviewFinding("must-fix-current", "Isolate the integration fixture"),
    ];
    const phases: string[] = [];
    let fixRequest = "";
    let fixInputFindings: string[] = [];
    const passZeroReviewsStarted = new Set<string>();
    let announcePassZeroReviewStarted: () => void = () => undefined;
    const passZeroReviewStarted = new Promise<void>((resolve) => {
      announcePassZeroReviewStarted = resolve;
    });
    let releasePassZeroReviews: () => void = () => undefined;
    const passZeroReviewsMayFinish = new Promise<void>((resolve) => {
      releasePassZeroReviews = resolve;
    });
    const runner: AgentRunner = Effect.fnUntraced(function* (request) {
      yield* Effect.void;
      const phase = request.display.phaseId;
      phases.push(phase);
      if (request.prompt.includes('name="triage"'))
        return yield* Effect.tryPromise({
          try: () => submitTriage(request, proceedTriage()),
          catch: (error) => error,
        });
      if (request.prompt.includes('name="implementation_plan_draft"'))
        return yield* Effect.tryPromise({
          try: () => submitImplementationPlan(request, readyPlanDraft()),
          catch: (error) => error,
        });
      if (request.prompt.includes('name="implementation_plan_refinement"'))
        return yield* Effect.tryPromise({
          try: () => submitImplementationPlan(request, readyPlan()),
          catch: (error) => error,
        });
      if (phase === "refinementLog-0")
        return yield* Effect.tryPromise({
          try: () =>
            submitChangeReport(request, changeReport({ summary: "Refined." })),
          catch: (error) => error,
        });
      if (phase === "reviewA-0") {
        passZeroReviewsStarted.add(phase);
        if (passZeroReviewsStarted.size === 2) announcePassZeroReviewStarted();
        yield* Effect.tryPromise({
          try: () => passZeroReviewsMayFinish,
          catch: (error) => error,
        });
        return yield* Effect.tryPromise({
          try: () => submitReview(request, reviewResult(reviewAFindings)),
          catch: (error) => error,
        });
      }
      if (phase === "reviewB-0") {
        passZeroReviewsStarted.add(phase);
        if (passZeroReviewsStarted.size === 2) announcePassZeroReviewStarted();
        yield* Effect.tryPromise({
          try: () => passZeroReviewsMayFinish,
          catch: (error) => error,
        });
        return yield* Effect.tryPromise({
          try: () => submitReview(request, reviewResult(reviewBFindings)),
          catch: (error) => error,
        });
      }
      if (phase === "fixLog-1") {
        fixRequest = request.prompt;
        const reviewA = yield* parseReviewResultJson(
          yield* readArtifact(context, reviewARef(0)),
          {
            allowRestart: true,
          },
        );
        const reviewB = yield* parseReviewResultJson(
          yield* readArtifact(context, reviewBRef(0)),
          {
            allowRestart: true,
          },
        );
        fixInputFindings = [...reviewA.findings, ...reviewB.findings].map(
          ({ title }) => title,
        );
        return yield* Effect.tryPromise({
          try: () =>
            submitChangeReport(
              request,
              changeReport({
                summary: "Fixed all required findings.",
                addressedFindingIds: [
                  "review-a:reject-malformed-identifiers",
                  "review-a:seed-authorization-state",
                  "review-b:isolate-the-integration-fixture",
                ],
              }),
            ),
          catch: (error) => error,
        });
      }
      if (phase === "refinementLog-1")
        return yield* Effect.tryPromise({
          try: () =>
            submitChangeReport(request, changeReport({ summary: "Refined." })),
          catch: (error) => error,
        });
      if (phase === "reviewA-1" || phase === "reviewB-1")
        return yield* Effect.tryPromise({
          try: () => submitReview(request, approveReview()),
          catch: (error) => error,
        });
      return yield* Effect.fail(new Error(`unexpected phase: ${phase}`));
    });
    const workflow = runApplicationPromise(
      nativePhases.runFullWorkflow(context, {}).pipe(provideTestAgent(runner)),
    );
    const reviewsStartedTogether = await Promise.race([
      passZeroReviewStarted.then(() => true),
      Bun.sleep(1000).then(() => false),
    ]);
    releasePassZeroReviews();
    const result = await workflow;
    const persistedReviewA = Effect.runSync(
      parseReviewResultJson(
        await runApplicationPromise(readArtifact(context, reviewARef(0))),
        { allowRestart: true },
      ),
    );
    const persistedReviewB = Effect.runSync(
      parseReviewResultJson(
        await runApplicationPromise(readArtifact(context, reviewBRef(0))),
        { allowRestart: true },
      ),
    );
    const persistedFix = Effect.runSync(
      parseChangeReportJson(
        await runApplicationPromise(readArtifact(context, fixLogRef(1))),
      ),
    );
    expect(persistedReviewA.findings.map(({ title }) => title)).toEqual(
      reviewAFindings.map(({ title }) => title),
    );
    expect(persistedReviewB.findings.map(({ title }) => title)).toEqual(
      reviewBFindings.map(({ title }) => title),
    );
    expect(
      await runApplicationPromise(readArtifact(context, reviewAMarkdownRef(0))),
    ).toContain("seed-authorization-state: Seed authorization state");
    expect(
      await runApplicationPromise(readArtifact(context, reviewBMarkdownRef(0))),
    ).toContain(
      "isolate-the-integration-fixture: Isolate the integration fixture",
    );
    expect(reviewsStartedTogether).toBe(true);
    expect(fixRequest).toContain("review-a-0.json");
    expect(fixRequest).toContain("review-b-0.json");
    expect(fixInputFindings).toEqual([
      "Reject malformed identifiers",
      "Seed authorization state",
      "Isolate the integration fixture",
    ]);
    expect(persistedFix.addressedFindingIds).toEqual([
      "review-a:reject-malformed-identifiers",
      "review-a:seed-authorization-state",
      "review-b:isolate-the-integration-fixture",
    ]);
    expect(
      await runApplicationPromise(readArtifact(context, fixLogMarkdownRef(1))),
    ).toContain("- review-b:isolate-the-integration-fixture");
    expect(phases).toContain("fixLog-1");
    expect(
      await runApplicationPromise(artifactExists(context, reviewARef(1))),
    ).toBe(true);
    expect(
      await runApplicationPromise(artifactExists(context, reviewBRef(1))),
    ).toBe(true);
    expect(result).toEqual({ status: "completed" });
    expect(
      Effect.runSync(
        parseReadinessResultJson(
          await runApplicationPromise(readArtifact(context, "readiness")),
        ),
      ).decision.status,
    ).toBe("ready-for-pr");
  });
  test("does not run fix for follow-up and suggestion-only ledgers", async () => {
    const context = await tempContext();
    await seedBaselineAndImplementation(context);
    const phases: string[] = [];
    const runner: AgentRunner = Effect.fnUntraced(function* (request) {
      yield* Effect.void;
      if (request.prompt.includes('name="triage"'))
        return yield* Effect.tryPromise({
          try: () => submitTriage(request, proceedTriage()),
          catch: (error) => error,
        });
      if (request.prompt.includes('name="implementation_plan_draft"'))
        return yield* Effect.tryPromise({
          try: () => submitImplementationPlan(request, readyPlanDraft()),
          catch: (error) => error,
        });
      if (request.prompt.includes('name="implementation_plan_refinement"'))
        return yield* Effect.tryPromise({
          try: () => submitImplementationPlan(request, readyPlan()),
          catch: (error) => error,
        });
      if (request.prompt.includes('name="code_refinement"'))
        return yield* Effect.tryPromise({
          try: () =>
            submitChangeReport(request, changeReport({ summary: "Refined." })),
          catch: (error) => error,
        });
      if (request.prompt.includes('name="review_a"')) {
        phases.push("review-a");
        return yield* Effect.tryPromise({
          try: () =>
            submitReview(
              request,
              reviewResult([
                finding("F1", "follow-up"),
                finding("S1", "suggestion"),
              ]),
            ),
          catch: (error) => error,
        });
      }
      if (request.prompt.includes('name="review_b"')) {
        phases.push("review-b");
        return yield* Effect.tryPromise({
          try: () => submitReview(request, approveReview()),
          catch: (error) => error,
        });
      }
      if (request.prompt.includes('name="fix"')) phases.push("fix");
      return yield* Effect.fail(new Error("unexpected prompt"));
    });
    expect(
      runApplicationPromise(
        nativePhases
          .runFullWorkflow(context, {})
          .pipe(provideTestAgent(runner)),
      ),
    ).resolves.toEqual({
      status: "completed",
    });
    expect([...phases].sort()).toEqual(["review-a", "review-b"]);
    expect(
      Effect.runSync(
        parseReadinessResultJson(
          await runApplicationPromise(readArtifact(context, "readiness")),
        ),
      ).decision.status,
    ).toBe("ready-for-pr");
  });
  test("external-blocker ledgers stop after review without running fix", async () => {
    const context = await tempContext();
    await seedBaselineAndImplementation(context);
    const phases: string[] = [];
    const runner: AgentRunner = Effect.fnUntraced(function* (request) {
      yield* Effect.void;
      if (request.prompt.includes('name="triage"'))
        return yield* Effect.tryPromise({
          try: () => submitTriage(request, proceedTriage()),
          catch: (error) => error,
        });
      if (request.prompt.includes('name="implementation_plan_draft"'))
        return yield* Effect.tryPromise({
          try: () => submitImplementationPlan(request, readyPlanDraft()),
          catch: (error) => error,
        });
      if (request.prompt.includes('name="implementation_plan_refinement"'))
        return yield* Effect.tryPromise({
          try: () => submitImplementationPlan(request, readyPlan()),
          catch: (error) => error,
        });
      if (request.prompt.includes('name="code_refinement"'))
        return yield* Effect.tryPromise({
          try: () =>
            submitChangeReport(request, changeReport({ summary: "Refined." })),
          catch: (error) => error,
        });
      if (request.prompt.includes('name="review_a"')) {
        phases.push("review-a");
        return yield* Effect.tryPromise({
          try: () =>
            submitReview(
              request,
              reviewResult([finding("B1", "external-blocker")]),
            ),
          catch: (error) => error,
        });
      }
      if (request.prompt.includes('name="review_b"')) {
        phases.push("review-b");
        return yield* Effect.tryPromise({
          try: () => submitReview(request, approveReview()),
          catch: (error) => error,
        });
      }
      if (request.prompt.includes('name="fix"')) phases.push("fix");
      return yield* Effect.fail(new Error("unexpected prompt"));
    });
    const result = await runApplicationPromise(
      nativePhases.runFullWorkflow(context, {}).pipe(provideTestAgent(runner)),
    );
    expect(result).toEqual({ status: "review-blocked" });
    expect([...phases].sort()).toEqual(["review-a", "review-b"]);
    expect(
      await runApplicationPromise(readArtifact(context, "readinessMarkdown")),
    ).toContain("## External Blockers\n- review-a:blocker:b1");
  });
  test("fixes local findings before stopping on an independent external blocker", async () => {
    const context = await tempContext();
    await runApplicationPromise(
      runProcessOrThrow(["git", "init", "-b", "main"], {
        cwd: context.agentCwd,
      }),
    );
    await seedBaselineAndImplementation(context);
    const phases: string[] = [];
    const runner: AgentRunner = Effect.fnUntraced(function* (request) {
      yield* Effect.void;
      const phase = request.display.phaseId;
      if (request.prompt.includes('name="triage"'))
        return yield* Effect.tryPromise({
          try: () => submitTriage(request, proceedTriage()),
          catch: (error) => error,
        });
      if (request.prompt.includes('name="implementation_plan_draft"'))
        return yield* Effect.tryPromise({
          try: () => submitImplementationPlan(request, readyPlanDraft()),
          catch: (error) => error,
        });
      if (request.prompt.includes('name="implementation_plan_refinement"'))
        return yield* Effect.tryPromise({
          try: () => submitImplementationPlan(request, readyPlan()),
          catch: (error) => error,
        });
      if (request.prompt.includes('name="code_refinement"'))
        return yield* Effect.tryPromise({
          try: () =>
            submitChangeReport(request, changeReport({ summary: "Refined." })),
          catch: (error) => error,
        });
      if (phase === "reviewA-0") {
        phases.push("review-a-0");
        return yield* Effect.tryPromise({
          try: () =>
            submitReview(
              request,
              reviewResult([
                finding("LOCAL-FIX", "must-fix-current"),
                finding("ACCESS", "external-blocker"),
              ]),
            ),
          catch: (error) => error,
        });
      }
      if (phase === "reviewA-1") {
        phases.push("review-a-1");
        return yield* Effect.tryPromise({
          try: () =>
            submitReview(
              request,
              reviewResult([finding("ACCESS", "external-blocker")]),
            ),
          catch: (error) => error,
        });
      }
      if (phase === "reviewB-0" || phase === "reviewB-1")
        return yield* Effect.tryPromise({
          try: () => submitReview(request, approveReview()),
          catch: (error) => error,
        });
      if (phase === "fixLog-1") {
        phases.push("fix");
        return yield* Effect.tryPromise({
          try: () =>
            submitChangeReport(
              request,
              changeReport({ addressedFindingIds: ["review-a:local-fix"] }),
            ),
          catch: (error) => error,
        });
      }
      return yield* Effect.fail(new Error(`unexpected phase: ${phase}`));
    });
    const result = await runApplicationPromise(
      nativePhases.runFullWorkflow(context, {}).pipe(provideTestAgent(runner)),
    );
    expect(result).toEqual({ status: "review-blocked" });
    expect(phases).toEqual(["review-a-0", "fix", "review-a-1"]);
    expect(
      Effect.runSync(
        parseChangeReportJson(
          await runApplicationPromise(readArtifact(context, fixLogRef(1))),
        ),
      ).addressedFindingIds,
    ).toEqual(["review-a:local-fix"]);
  });
});
async function seedBaselineAndImplementation(
  context: Awaited<ReturnType<typeof tempContext>>,
) {
  await runApplicationPromise(
    writeArtifact(
      context,
      "preImplementationBaseline",
      JSON.stringify({ head: "abc", capturedAt: "now", excludes: [".roark"] }),
    ),
  );
  await runApplicationPromise(
    writeArtifact(
      context,
      "implementationLog",
      JSON.stringify(changeReport({ summary: "Done." })),
    ),
  );
}
function proceedTriage() {
  return triageResult();
}
function readyPlanDraft() {
  return implementationPlanResult();
}
function readyPlan() {
  return implementationPlanResult();
}
function notReadyPlan() {
  return implementationPlanResult(false);
}
function refinementLog(pass = 0): string {
  return JSON.stringify(changeReport({ summary: `Refined pass ${pass}.` }));
}
function approveReview(): ReviewResult {
  return reviewResult();
}
function finding(
  id: string,
  classification:
    | "must-fix-current"
    | "external-blocker"
    | "follow-up"
    | "suggestion",
) {
  return reviewFinding(classification, id);
}
