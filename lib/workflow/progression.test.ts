import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { createWorkflowContext, finalReviewRef, fixLogRef, writeArtifact, type WorkflowContext } from "./artifacts.ts";
import { planWorkflowProgression } from "./progression.ts";

const tempDirs: string[] = [];

async function tempContext(maxFixPasses = 1): Promise<WorkflowContext> {
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
  test("plans the initial missing-artifact workflow order", async () => {
    const context = await tempContext();

    const progression = await planWorkflowProgression(context, { includePublishGate: true });

    expect(progression.terminalStatus).toBeUndefined();
    expect(progression.actions).toEqual([
      { type: "run", phase: "fetch", reason: "artifact is missing" },
      { type: "run", phase: "triage", reason: "triage has not run" },
      { type: "run", phase: "plan", reason: "plan has not run" },
      { type: "run", phase: "implement", reason: "implementation has not run" },
      { type: "run", phase: "review-a", reason: "review A has not run" },
      { type: "run", phase: "review-b", reason: "review B has not run" },
      { type: "write-readiness", reason: "workflow must recompute readiness" },
      { type: "publish-gate", reason: "publish gate must run after readiness" },
    ]);
  });

  test("refetches issue artifacts without a relationship snapshot", async () => {
    const context = await tempContext();
    await writeArtifact(context, "issue", "# Issue\n");

    const progression = await planWorkflowProgression(context, { includePublishGate: true });

    expect(progression.actions[0]).toEqual({
      type: "run",
      phase: "fetch",
      reason: "issue artifact lacks GitHub relationship snapshot",
    });
  });

  test("reruns invalid artifacts before dependent phases", async () => {
    const context = await tempContext();
    await writeArtifact(context, "issue", issueArtifact());
    await writeArtifact(context, "triage", "");

    const progression = await planWorkflowProgression(context, { includePublishGate: true });

    expect(progression.actions[0]).toEqual({ type: "run", phase: "triage", reason: "artifact is empty" });
    expect(progression.actions[1]).toEqual({ type: "run", phase: "plan", reason: "plan depends on triage" });
  });

  test("stops after a non-proceed triage verdict", async () => {
    const context = await tempContext();
    await writeArtifact(context, "issue", issueArtifact());
    await writeArtifact(context, "triage", "# Triage\n\n## Verdict\nblocked\n");

    const progression = await planWorkflowProgression(context, { includePublishGate: true });

    expect(progression.terminalStatus).toEqual({ status: "triage-stopped", triageVerdict: "blocked" });
    expect(progression.actions).toEqual([
      { type: "write-readiness", reason: 'triage verdict is "blocked"; readiness records the stop' },
      { type: "noop", reason: "terminal triage outcome; no plan/implementation/publish gate" },
    ]);
  });

  test("stops after a valid implementation plan that is not ready", async () => {
    const context = await tempContext();
    await writeReadyThroughPlan(context, "no");

    const progression = await planWorkflowProgression(context, { includePublishGate: true });

    expect(progression.terminalStatus).toEqual({ status: "planning-stopped" });
    expect(progression.actions).toEqual([
      { type: "write-readiness", reason: "implementation plan is not ready; readiness records the stop" },
      { type: "noop", reason: "terminal planning outcome; no implementation/publish gate" },
    ]);
  });

  test("stops for blocked reviews", async () => {
    const context = await tempContext();
    await writeHappyPathThroughReviews(context, "blocked", "approve");

    const progression = await planWorkflowProgression(context, { includePublishGate: true });

    expect(progression.terminalStatus).toEqual({ status: "review-blocked" });
    expect(progression.actions).toEqual([
      { type: "write-readiness", reason: "a review is blocked; readiness records the stop" },
      { type: "publish-gate", reason: "publish gate records non-publish" },
    ]);
  });

  test("completes after approved reviews", async () => {
    const context = await tempContext();
    await writeHappyPathThroughReviews(context);

    const progression = await planWorkflowProgression(context, { includePublishGate: true });

    expect(progression.terminalStatus).toEqual({ status: "completed" });
    expect(progression.actions).toEqual([
      { type: "write-readiness", reason: "reviews approve; recompute deterministic readiness" },
      { type: "publish-gate", reason: "publish gate must run after readiness" },
    ]);
  });

  test("runs a required fix pass before final review", async () => {
    const context = await tempContext();
    await writeHappyPathThroughReviews(context, "fixes-required", "approve");

    const progression = await planWorkflowProgression(context, { includePublishGate: true });

    expect(progression.terminalStatus).toBeUndefined();
    expect(progression.actions.slice(0, 2)).toEqual([
      { type: "run", phase: "fix", pass: 1, reason: "artifact is missing" },
      { type: "run", phase: "final-review", pass: 1, reason: "final review depends on fix" },
    ]);
  });

  test("completes when the latest final review is ready", async () => {
    const context = await tempContext();
    await writeHappyPathThroughReviews(context, "fixes-required", "approve");
    await writeArtifact(context, fixLogRef(1), "# Fix Log Pass 1\n\n## Summary\nFixed.\n");
    await writeArtifact(context, finalReviewRef(1), "# Final Review Pass 1\n\n## Verdict\nready-for-pr\n");

    const progression = await planWorkflowProgression(context, { includePublishGate: true });

    expect(progression.terminalStatus).toEqual({ status: "completed" });
    expect(progression.actions).toEqual([
      { type: "write-readiness", reason: "latest final review decides readiness" },
      { type: "publish-gate", reason: "publish gate must run after readiness" },
    ]);
  });

  test("completes after the maximum fix passes are reached", async () => {
    const context = await tempContext(1);
    await writeHappyPathThroughReviews(context, "fixes-required", "approve");
    await writeArtifact(context, fixLogRef(1), "# Fix Log Pass 1\n\n## Summary\nFixed.\n");
    await writeArtifact(context, finalReviewRef(1), "# Final Review Pass 1\n\n## Verdict\nfixes-required\n");

    const progression = await planWorkflowProgression(context, { includePublishGate: true });

    expect(progression.terminalStatus).toEqual({ status: "completed" });
    expect(progression.actions).toEqual([
      { type: "write-readiness", reason: "maximum fix passes reached" },
      { type: "publish-gate", reason: "publish gate records non-publish" },
    ]);
  });
});

async function writeReadyThroughPlan(context: WorkflowContext, ready: "yes" | "no") {
  await writeArtifact(context, "issue", issueArtifact());
  await writeArtifact(context, "triage", "# Triage\n\n## Verdict\nproceed\n");
  await writeArtifact(context, "implementationPlan", `# Implementation Plan\n\n## Ready For Implementation\n${ready}\n`);
}

function issueArtifact(): string {
  return "# Issue\n\n<github_issue_relationships source=\"gh\">\n  <blocking_status active_blockers=\"0\" total_blockers=\"0\" />\n</github_issue_relationships>\n";
}

async function writeHappyPathThroughReviews(
  context: WorkflowContext,
  reviewAVerdict = "approve",
  reviewBVerdict = "approve",
) {
  await writeReadyThroughPlan(context, "yes");
  await writeArtifact(context, "implementationLog", "# Implementation Log\n\n## Summary\nDone.\n");
  await writeArtifact(context, "reviewA", `# Review A\n\n## Verdict\n${reviewAVerdict}\n`);
  await writeArtifact(context, "reviewB", `# Review B\n\n## Verdict\n${reviewBVerdict}\n`);
}
