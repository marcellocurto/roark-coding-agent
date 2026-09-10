import { rejects as assertRejects } from "node:assert/strict";
import { runApplicationPromise } from "../runtime/application.ts";
import * as nativeProgression from "./progression.ts";
import {
  writeArtifact,
  writeJsonArtifact,
  baselineResetLogRef,
  createWorkflowContext,
  fixLogRef,
  implementationRestartLogRef,
  refinementLogRef,
  reviewARef,
  reviewBRef,
  type WorkflowContext,
} from "./artifacts.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { reviewFinding, reviewResult } from "../testing/reviews.ts";
import {
  implementationPlanResult,
  triageResult,
} from "../testing/workflow-results.ts";
import { changeReport } from "../testing/change-reports.ts";
const tempDirs: string[] = [];
async function tempContext(maxFixPasses = 2): Promise<WorkflowContext> {
  const dir = await mkdtemp(path.join(tmpdir(), "roark-progression-"));
  tempDirs.push(dir);
  return createWorkflowContext({
    command: "do",
    issue: "43",
    cwd: dir,
    outDir: ".roark/runs",
    force: false,
    yes: false,
    maxFixPasses,
    attempt: 1,
  });
}
afterEach(async () => {
  for (const dir of tempDirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});
describe("planWorkflowProgression", () => {
  test("cached implementation and reviews cannot bypass a changed adopted plan source", async () => {
    const context = await tempContext();
    await writeHappyPathThroughReviews(context);
    await runApplicationPromise(
      writeJsonArtifact(
        context,
        "triage",
        triageResult("proceed", {
          planAction: "adopt",
          planSource: "Issue comment B",
        }),
      ),
    );
    await runApplicationPromise(
      writeJsonArtifact(
        context,
        "implementationPlan",
        implementationPlanResult(true, { source: "Issue comment A" }),
      ),
    );
    await assertRejects(
      runApplicationPromise(nativeProgression.planWorkflowProgression(context)),
      /source does not match/,
    );
  });
  test.each(["adopt", "adapt"] as const)(
    "%s skips drafting and resumes without a draft artifact",
    async (planAction) => {
      const context = await tempContext();
      await runApplicationPromise(
        writeArtifact(context, "issue", issueArtifact()),
      );
      await runApplicationPromise(
        writeJsonArtifact(
          context,
          "triage",
          triageResult("proceed", {
            planAction,
            planSource: "Issue body: Plan",
          }),
        ),
      );
      const pending = await runApplicationPromise(
        nativeProgression.planWorkflowProgression(context),
      );
      expect(pending.actions[0]).toMatchObject({ type: "run", phase: "plan" });
      expect(
        pending.actions.some(
          (action) => action.type === "run" && action.phase === "plan-draft",
        ),
      ).toBe(false);
      await runApplicationPromise(
        writeJsonArtifact(
          context,
          "implementationPlan",
          implementationPlanResult(true, { source: "Issue body: Plan" }),
        ),
      );
      const resumed = await runApplicationPromise(
        nativeProgression.planWorkflowProgression(context),
      );
      expect(resumed.actions[0]).toMatchObject({
        type: "run",
        phase: "capture-baseline",
      });
    },
  );
  test("a non-ready draft stops before acceptance even with an older ready final plan", async () => {
    const context = await tempContext();
    await writeReadyThroughPlan(context, "yes");
    await runApplicationPromise(
      writeJsonArtifact(
        context,
        "implementationPlanDraft",
        implementationPlanResult(false),
      ),
    );
    const result = await runApplicationPromise(
      nativeProgression.planWorkflowProgression(context, {
        includePublishGate: true,
      }),
    );
    expect(result.terminalStatus).toEqual({
      status: "planning-stopped",
      planningArtifact: "implementationPlanDraft",
    });
    expect(result.actions.map((action) => action.type)).toEqual([
      "write-readiness",
      "noop",
    ]);
  });
  test("a discovered decision stops execution before refinement and publication", async () => {
    const context = await tempContext();
    await writeReadyThroughImplementation(context);
    await runApplicationPromise(
      writeJsonArtifact(
        context,
        "implementationLog",
        changeReport({
          blockingQuestions: ["Should existing sessions be invalidated?"],
        }),
      ),
    );
    const result = await runApplicationPromise(
      nativeProgression.planWorkflowProgression(context, {
        includePublishGate: true,
      }),
    );
    expect(result.terminalStatus).toEqual({
      status: "execution-stopped",
      artifact: "implementationLog",
    });
    expect(result.actions.map((action) => action.type)).toEqual([
      "write-readiness",
      "noop",
    ]);
  });
  test("a partial fix with unanswered questions cannot advance to refinement", async () => {
    const context = await tempContext();
    await writeHappyPathThroughReviews(context, "fixes-required");
    await runApplicationPromise(
      writeArtifact(
        context,
        fixLogRef(1),
        JSON.stringify(
          changeReport({
            blockingQuestions: ["Which compatibility policy applies?"],
          }),
        ),
      ),
    );
    const result = await runApplicationPromise(
      nativeProgression.planWorkflowProgression(context),
    );
    expect(result.terminalStatus).toEqual({
      status: "execution-stopped",
      artifact: fixLogRef(1),
    });
  });
  test("requires an explicit rerun when legacy planning artifacts accompany completed code", async () => {
    const context = await tempContext();
    await writeReadyThroughImplementation(context);
    const {
      planAction: _action,
      planSource: _source,
      ...legacy
    } = triageResult();
    await runApplicationPromise(writeJsonArtifact(context, "triage", legacy));
    await assertRejects(
      runApplicationPromise(nativeProgression.planWorkflowProgression(context)),
      /old implementation cannot be reused/,
    );
    const forced = await runApplicationPromise(
      nativeProgression.planWorkflowProgression(context, { force: true }),
    );
    expect(forced.actions[0]).toMatchObject({ type: "run", phase: "fetch" });
  });
  test("plans the initial workflow with plan refinement and code refinement before reviews", async () => {
    const context = await tempContext();
    const progression = await runApplicationPromise(
      nativeProgression.planWorkflowProgression(context, {
        includePublishGate: true,
      }),
    );
    expect(progression.terminalStatus).toBeUndefined();
    expect(progression.actions).toEqual([
      {
        type: "run",
        phase: "fetch",
        pass: undefined,
        reason: "artifact is missing",
      },
      {
        type: "run",
        phase: "triage",
        pass: undefined,
        reason: "triage has not run",
      },
      {
        type: "run",
        phase: "plan-draft",
        pass: undefined,
        reason: "plan draft has not run",
      },
      {
        type: "run",
        phase: "plan",
        pass: undefined,
        reason: "plan refinement has not run",
      },
      {
        type: "run",
        phase: "capture-baseline",
        pass: undefined,
        reason: "baseline has not been captured",
      },
      {
        type: "run",
        phase: "implement",
        pass: undefined,
        reason: "implementation has not run",
      },
      {
        type: "run",
        phase: "refine-code",
        pass: 0,
        reason: "refinement has not run",
      },
      {
        type: "run",
        phase: "review-a",
        pass: 0,
        reason: "review A has not run",
      },
      {
        type: "run",
        phase: "review-b",
        pass: 0,
        reason: "review B has not run",
      },
      { type: "write-readiness", reason: "workflow must recompute readiness" },
      { type: "publish-gate", reason: "publish gate must run after readiness" },
    ]);
  });
  test("stops after a valid refined implementation plan that is not ready", async () => {
    const context = await tempContext();
    await writeReadyThroughPlan(context, "no");
    const progression = await runApplicationPromise(
      nativeProgression.planWorkflowProgression(context, {
        includePublishGate: true,
      }),
    );
    expect(progression.terminalStatus).toEqual({ status: "planning-stopped" });
  });
  test("requires missing code refinement before Review A/B", async () => {
    const context = await tempContext();
    await writeReadyThroughImplementation(context);
    const progression = await runApplicationPromise(
      nativeProgression.planWorkflowProgression(context, {
        includePublishGate: true,
      }),
    );
    expect(progression.actions.slice(0, 3)).toEqual([
      {
        type: "run",
        phase: "refine-code",
        pass: 0,
        reason: "artifact is missing",
      },
      {
        type: "run",
        phase: "review-a",
        pass: 0,
        reason: "review A depends on refinement",
      },
      {
        type: "run",
        phase: "review-b",
        pass: 0,
        reason: "review B depends on refinement",
      },
    ]);
  });
  test("completes after latest numbered post-refinement reviews approve", async () => {
    const context = await tempContext();
    await writeHappyPathThroughReviews(context);
    const progression = await runApplicationPromise(
      nativeProgression.planWorkflowProgression(context, {
        includePublishGate: true,
      }),
    );
    expect(progression.terminalStatus).toEqual({ status: "completed" });
    expect(progression.actions).toEqual([
      {
        type: "write-readiness",
        reason: "reviews approve; recompute deterministic readiness",
      },
      { type: "publish-gate", reason: "publish gate must run after readiness" },
    ]);
  });
  test("fix loop runs fix then refinement then Review A/B", async () => {
    const context = await tempContext();
    await writeHappyPathThroughReviews(context, "fixes-required", "approve");
    const progression = await runApplicationPromise(
      nativeProgression.planWorkflowProgression(context, {
        includePublishGate: true,
      }),
    );
    expect(progression.terminalStatus).toBeUndefined();
    expect(progression.actions.slice(0, 4)).toEqual([
      { type: "run", phase: "fix", pass: 1, reason: "artifact is missing" },
      {
        type: "run",
        phase: "refine-code",
        pass: 1,
        reason: "refinement depends on fix",
      },
      {
        type: "run",
        phase: "review-a",
        pass: 1,
        reason: "review A depends on refinement",
      },
      {
        type: "run",
        phase: "review-b",
        pass: 1,
        reason: "review B depends on refinement",
      },
    ]);
  });
  test("restart-required loop resets baseline then reimplements/refines/reviews", async () => {
    const context = await tempContext();
    await writeHappyPathThroughReviews(context, "restart-required", "approve");
    const progression = await runApplicationPromise(
      nativeProgression.planWorkflowProgression(context, {
        includePublishGate: true,
      }),
    );
    expect(progression.actions.slice(0, 5)).toEqual([
      {
        type: "run",
        phase: "reset-baseline",
        pass: 1,
        reason: "artifact is missing",
      },
      {
        type: "run",
        phase: "implement",
        pass: 1,
        reason: "implementation restart depends on baseline reset",
      },
      {
        type: "run",
        phase: "refine-code",
        pass: 1,
        reason: "refinement depends on restarted implementation",
      },
      {
        type: "run",
        phase: "review-a",
        pass: 1,
        reason: "review A depends on refinement",
      },
      {
        type: "run",
        phase: "review-b",
        pass: 1,
        reason: "review B depends on refinement",
      },
    ]);
  });
  test("readiness is based on the latest review cycle after a fix", async () => {
    const context = await tempContext();
    await writeHappyPathThroughReviews(context, "fixes-required", "approve");
    await runApplicationPromise(
      writeArtifact(
        context,
        fixLogRef(1),
        JSON.stringify(changeReport({ summary: "Fixed." })),
      ),
    );
    await runApplicationPromise(
      writeArtifact(
        context,
        refinementLogRef(1),
        JSON.stringify(changeReport({ summary: "Refined." })),
      ),
    );
    await runApplicationPromise(
      writeArtifact(context, reviewARef(1), structuredReview("approve")),
    );
    await runApplicationPromise(
      writeArtifact(context, reviewBRef(1), structuredReview("approve")),
    );
    const progression = await runApplicationPromise(
      nativeProgression.planWorkflowProgression(context, {
        includePublishGate: true,
      }),
    );
    expect(progression.terminalStatus).toEqual({ status: "completed" });
    expect(progression.actions[0]).toEqual({
      type: "write-readiness",
      reason: "latest review cycle approves; recompute deterministic readiness",
    });
  });
  test("continues after an already recorded baseline reset by rerunning implementation", async () => {
    const context = await tempContext();
    await writeHappyPathThroughReviews(context, "restart-required", "approve");
    await runApplicationPromise(
      writeArtifact(
        context,
        baselineResetLogRef(1),
        "# Baseline Reset Pass 1\n\n## Summary\nReset.\n",
      ),
    );
    const progression = await runApplicationPromise(
      nativeProgression.planWorkflowProgression(context, {}),
    );
    expect(progression.actions[0]).toEqual({
      type: "run",
      phase: "implement",
      pass: 1,
      reason: "implementation restart depends on baseline reset",
    });
  });
  test("continues restart refinement after a durable restart implementation marker", async () => {
    const context = await tempContext();
    await writeHappyPathThroughReviews(context, "restart-required", "approve");
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
    const progression = await runApplicationPromise(
      nativeProgression.planWorkflowProgression(context, {}),
    );
    expect(progression.actions.slice(0, 3)).toEqual([
      {
        type: "run",
        phase: "refine-code",
        pass: 1,
        reason: "artifact is missing",
      },
      {
        type: "run",
        phase: "review-a",
        pass: 1,
        reason: "review A depends on refinement",
      },
      {
        type: "run",
        phase: "review-b",
        pass: 1,
        reason: "review B depends on refinement",
      },
    ]);
  });
  test("does not reschedule restart implementation after a later approved cycle exists", async () => {
    const context = await tempContext();
    await writeHappyPathThroughReviews(context, "restart-required", "approve");
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
        refinementLogRef(1),
        JSON.stringify(changeReport({ summary: "Refined." })),
      ),
    );
    await runApplicationPromise(
      writeArtifact(context, reviewARef(1), structuredReview("approve")),
    );
    await runApplicationPromise(
      writeArtifact(context, reviewBRef(1), structuredReview("approve")),
    );
    const progression = await runApplicationPromise(
      nativeProgression.planWorkflowProgression(context, {}),
    );
    expect(progression.terminalStatus).toEqual({ status: "completed" });
    expect(progression.actions[0]).toEqual({
      type: "write-readiness",
      reason: "latest review cycle approves; recompute deterministic readiness",
    });
  });
});
async function writeReadyThroughPlan(
  context: WorkflowContext,
  ready: "yes" | "no",
) {
  await runApplicationPromise(writeArtifact(context, "issue", issueArtifact()));
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
      implementationPlanResult(ready === "yes"),
    ),
  );
}
async function writeReadyThroughImplementation(context: WorkflowContext) {
  await writeReadyThroughPlan(context, "yes");
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
}
function issueArtifact(): string {
  return '# Issue\n\n<github_issue_relationships source="gh">\n  <blocking_status active_blockers="0" total_blockers="0" />\n</github_issue_relationships>\n';
}
async function writeHappyPathThroughReviews(
  context: WorkflowContext,
  reviewAVerdict = "approve",
  reviewBVerdict = "approve",
) {
  await writeReadyThroughImplementation(context);
  await runApplicationPromise(
    writeArtifact(
      context,
      refinementLogRef(0),
      JSON.stringify(changeReport({ summary: "Refined." })),
    ),
  );
  await runApplicationPromise(
    writeArtifact(context, reviewARef(0), structuredReview(reviewAVerdict)),
  );
  await runApplicationPromise(
    writeArtifact(context, reviewBRef(0), structuredReview(reviewBVerdict)),
  );
}
function structuredReview(disposition: string): string {
  if (disposition === "approve") return JSON.stringify(reviewResult());
  const result = reviewResult([
    reviewFinding("must-fix-current", "Required fix"),
  ]);
  if (disposition === "restart-required") {
    const finding = result.findings[0];
    if (!finding) throw new Error("restart fixture requires a finding");
    return JSON.stringify({
      ...result,
      restartRecommendation: {
        findingIds: [finding.id],
        rationale:
          "The implementation baseline is no longer safe to repair incrementally.",
      },
    });
  }
  return JSON.stringify(result);
}
