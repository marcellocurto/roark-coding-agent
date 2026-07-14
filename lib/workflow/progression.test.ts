import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  baselineResetLogRef,
  createWorkflowContext,
  fixLogRef,
  implementationRestartLogRef,
  refinementLogRef,
  reviewARef,
  reviewBRef,
  writeArtifact,
  type WorkflowContext,
} from "./artifacts.ts";
import { planWorkflowProgression } from "./progression.ts";
import { reviewFinding, reviewResult } from "../testing/reviews.ts";

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
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("planWorkflowProgression", () => {
  test("plans the initial workflow with plan refinement and code refinement before reviews", async () => {
    const context = await tempContext();

    const progression = await planWorkflowProgression(context, { includePublishGate: true });

    expect(progression.terminalStatus).toBeUndefined();
    expect(progression.actions).toEqual([
      { type: "run", phase: "fetch", pass: undefined, reason: "artifact is missing" },
      { type: "run", phase: "triage", pass: undefined, reason: "triage has not run" },
      { type: "run", phase: "plan-draft", pass: undefined, reason: "plan draft has not run" },
      { type: "run", phase: "plan", pass: undefined, reason: "plan refinement has not run" },
      { type: "run", phase: "capture-baseline", pass: undefined, reason: "baseline has not been captured" },
      { type: "run", phase: "implement", pass: undefined, reason: "implementation has not run" },
      { type: "run", phase: "refine-code", pass: 0, reason: "refinement has not run" },
      { type: "run", phase: "review-a", pass: 0, reason: "review A has not run" },
      { type: "run", phase: "review-b", pass: 0, reason: "review B has not run" },
      { type: "write-readiness", reason: "workflow must recompute readiness" },
      { type: "publish-gate", reason: "publish gate must run after readiness" },
    ]);
  });

  test("stops after a valid refined implementation plan that is not ready", async () => {
    const context = await tempContext();
    await writeReadyThroughPlan(context, "no");

    const progression = await planWorkflowProgression(context, { includePublishGate: true });

    expect(progression.terminalStatus).toEqual({ status: "planning-stopped" });
  });

  test("requires missing code refinement before Review A/B", async () => {
    const context = await tempContext();
    await writeReadyThroughImplementation(context);

    const progression = await planWorkflowProgression(context, { includePublishGate: true });

    expect(progression.actions.slice(0, 3)).toEqual([
      { type: "run", phase: "refine-code", pass: 0, reason: "artifact is missing" },
      { type: "run", phase: "review-a", pass: 0, reason: "review A depends on refinement" },
      { type: "run", phase: "review-b", pass: 0, reason: "review B depends on refinement" },
    ]);
  });

  test("completes after latest numbered post-refinement reviews approve", async () => {
    const context = await tempContext();
    await writeHappyPathThroughReviews(context);

    const progression = await planWorkflowProgression(context, { includePublishGate: true });

    expect(progression.terminalStatus).toEqual({ status: "completed" });
    expect(progression.actions).toEqual([
      { type: "write-readiness", reason: "reviews approve; recompute deterministic readiness" },
      { type: "publish-gate", reason: "publish gate must run after readiness" },
    ]);
  });

  test("fix loop runs fix then refinement then Review A/B", async () => {
    const context = await tempContext();
    await writeHappyPathThroughReviews(context, "fixes-required", "approve");

    const progression = await planWorkflowProgression(context, { includePublishGate: true });

    expect(progression.terminalStatus).toBeUndefined();
    expect(progression.actions.slice(0, 4)).toEqual([
      { type: "run", phase: "fix", pass: 1, reason: "artifact is missing" },
      { type: "run", phase: "refine-code", pass: 1, reason: "refinement depends on fix" },
      { type: "run", phase: "review-a", pass: 1, reason: "review A depends on refinement" },
      { type: "run", phase: "review-b", pass: 1, reason: "review B depends on refinement" },
    ]);
  });

  test("restart-required loop resets baseline then reimplements/refines/reviews", async () => {
    const context = await tempContext();
    await writeHappyPathThroughReviews(context, "restart-required", "approve");

    const progression = await planWorkflowProgression(context, { includePublishGate: true });

    expect(progression.actions.slice(0, 5)).toEqual([
      { type: "run", phase: "reset-baseline", pass: 1, reason: "artifact is missing" },
      { type: "run", phase: "implement", pass: 1, reason: "implementation restart depends on baseline reset" },
      { type: "run", phase: "refine-code", pass: 1, reason: "refinement depends on restarted implementation" },
      { type: "run", phase: "review-a", pass: 1, reason: "review A depends on refinement" },
      { type: "run", phase: "review-b", pass: 1, reason: "review B depends on refinement" },
    ]);
  });

  test("readiness is based on the latest review cycle after a fix", async () => {
    const context = await tempContext();
    await writeHappyPathThroughReviews(context, "fixes-required", "approve");
    await writeArtifact(context, fixLogRef(1), "# Fix Log Pass 1\n\n## Summary\nFixed.\n");
    await writeArtifact(context, refinementLogRef(1), "# Refinement Log Pass 1\n\n## Summary\nRefined.\n");
    await writeArtifact(context, reviewARef(1), structuredReview("approve"));
    await writeArtifact(context, reviewBRef(1), structuredReview("approve"));

    const progression = await planWorkflowProgression(context, { includePublishGate: true });

    expect(progression.terminalStatus).toEqual({ status: "completed" });
    expect(progression.actions[0]).toEqual({ type: "write-readiness", reason: "latest review cycle approves; recompute deterministic readiness" });
  });

  test("continues after an already recorded baseline reset by rerunning implementation", async () => {
    const context = await tempContext();
    await writeHappyPathThroughReviews(context, "restart-required", "approve");
    await writeArtifact(context, baselineResetLogRef(1), "# Baseline Reset Pass 1\n\n## Summary\nReset.\n");

    const progression = await planWorkflowProgression(context);

    expect(progression.actions[0]).toEqual({ type: "run", phase: "implement", pass: 1, reason: "implementation restart depends on baseline reset" });
  });

  test("continues restart refinement after a durable restart implementation marker", async () => {
    const context = await tempContext();
    await writeHappyPathThroughReviews(context, "restart-required", "approve");
    await writeArtifact(context, baselineResetLogRef(1), "# Baseline Reset Pass 1\n\n## Summary\nReset.\n");
    await writeArtifact(context, implementationRestartLogRef(1), "# Implementation Restart Log Pass 1\n\n## Summary\nRestarted.\n");

    const progression = await planWorkflowProgression(context);

    expect(progression.actions.slice(0, 3)).toEqual([
      { type: "run", phase: "refine-code", pass: 1, reason: "artifact is missing" },
      { type: "run", phase: "review-a", pass: 1, reason: "review A depends on refinement" },
      { type: "run", phase: "review-b", pass: 1, reason: "review B depends on refinement" },
    ]);
  });

  test("does not reschedule restart implementation after a later approved cycle exists", async () => {
    const context = await tempContext();
    await writeHappyPathThroughReviews(context, "restart-required", "approve");
    await writeArtifact(context, baselineResetLogRef(1), "# Baseline Reset Pass 1\n\n## Summary\nReset.\n");
    await writeArtifact(context, refinementLogRef(1), "# Refinement Log Pass 1\n\n## Summary\nRefined.\n");
    await writeArtifact(context, reviewARef(1), structuredReview("approve"));
    await writeArtifact(context, reviewBRef(1), structuredReview("approve"));

    const progression = await planWorkflowProgression(context);

    expect(progression.terminalStatus).toEqual({ status: "completed" });
    expect(progression.actions[0]).toEqual({ type: "write-readiness", reason: "latest review cycle approves; recompute deterministic readiness" });
  });
});

async function writeReadyThroughPlan(context: WorkflowContext, ready: "yes" | "no") {
  await writeArtifact(context, "issue", issueArtifact());
  await writeArtifact(context, "triage", "# Triage\n\n## Verdict\nproceed\n");
  await writeArtifact(context, "implementationPlanDraft", "# Implementation Plan Draft\n\n## Ready For Implementation\nyes\n");
  await writeArtifact(context, "implementationPlan", `# Implementation Plan\n\n## Ready For Implementation\n${ready}\n`);
}

async function writeReadyThroughImplementation(context: WorkflowContext) {
  await writeReadyThroughPlan(context, "yes");
  await writeArtifact(context, "preImplementationBaseline", JSON.stringify({ head: "abc", capturedAt: "now", excludes: [".roark"] }));
  await writeArtifact(context, "implementationLog", "# Implementation Log\n\n## Summary\nDone.\n");
}

function issueArtifact(): string {
  return "# Issue\n\n<github_issue_relationships source=\"gh\">\n  <blocking_status active_blockers=\"0\" total_blockers=\"0\" />\n</github_issue_relationships>\n";
}

async function writeHappyPathThroughReviews(
  context: WorkflowContext,
  reviewAVerdict = "approve",
  reviewBVerdict = "approve",
) {
  await writeReadyThroughImplementation(context);
  await writeArtifact(context, refinementLogRef(0), "# Refinement Log Pass 0\n\n## Summary\nRefined.\n");
  await writeArtifact(context, reviewARef(0), structuredReview(reviewAVerdict));
  await writeArtifact(context, reviewBRef(0), structuredReview(reviewBVerdict));
}

function structuredReview(disposition: string): string {
  if (disposition === "approve") return JSON.stringify(reviewResult());
  const result = reviewResult([reviewFinding("must-fix-current", "Required fix")]);
  if (disposition === "restart-required") result.restartRationale = "The implementation baseline is no longer safe to repair incrementally.";
  return JSON.stringify(result);
}
