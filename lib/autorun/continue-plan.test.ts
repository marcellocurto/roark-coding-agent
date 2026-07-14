import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { createWorkflowContext, fixLogRef, refinementLogRef, reviewARef, reviewBRef, writeArtifact, writeJsonArtifact } from "../workflow/artifacts.ts";
import { planContinuation } from "./continue-plan.ts";
import { reviewFinding, reviewResult } from "../testing/reviews.ts";
import type { FindingClassification, ReviewFinding } from "../review/result.ts";
import { implementationPlanResult, readinessResult, triageResult } from "../testing/workflow-results.ts";
import { changeReport } from "../testing/change-reports.ts";

const tempDirs: string[] = [];

async function tempContext() {
  const dir = await mkdtemp(path.join(tmpdir(), "roark-continue-plan-"));
  tempDirs.push(dir);
  return createWorkflowContext({
    command: "do",
    issue: "11",
    cwd: dir,
    outDir: ".roark/runs",
    force: false,
    yes: false,
    maxFixPasses: 1,
    attempt: 1,
  });
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("planContinuation", () => {
  test("ignores review Markdown artifacts from earlier runs", async () => {
    const context = await tempContext();
    await writeReadyThroughPlan(context, "yes");
    await writeArtifact(context, "preImplementationBaseline", JSON.stringify({ head: "abc", capturedAt: "now", excludes: [".roark"] }));
    await writeArtifact(context, "implementationLog", JSON.stringify(changeReport()));
    await writeArtifact(context, refinementLogRef(0), JSON.stringify(changeReport({ summary: "Refined." })));
    await Bun.write(path.join(context.runDir, "review-a-0.md"), "# Historical Review A\n\n## Verdict\napprove\n");
    await Bun.write(path.join(context.runDir, "review-b-0.md"), "# Historical Review B\n\n## Verdict\napprove\n");

    const steps = await planContinuation(context);

    expect(steps.slice(0, 2)).toEqual([
      { type: "run", phase: "review-a", pass: 0, reason: "artifact is missing" },
      { type: "run", phase: "review-b", pass: 0, reason: "artifact is missing" },
    ]);
  });

  test("reruns only invalid latest Review B before readiness and publish gate", async () => {
    const context = await tempContext();
    await writeHappyPathThroughReviews(context);
    await writeArtifact(context, reviewBRef(0), "");

    const steps = await planContinuation(context);

    expect(steps).toEqual([
      { type: "run", phase: "review-b", pass: 0, reason: "artifact is empty" },
      { type: "write-readiness", reason: "workflow must recompute readiness" },
      { type: "publish-gate", reason: "publish gate must run after readiness" },
    ]);
  });

  test("treats non-proceed triage as terminal", async () => {
    const context = await tempContext();
    await writeArtifact(context, "issue", issueArtifact());
    await writeJsonArtifact(context, "triage", triageResult("needs-human-decision"));

    const steps = await planContinuation(context);

    expect(steps).toEqual([
      { type: "write-readiness", reason: 'triage verdict is "needs-human-decision"; readiness records the stop' },
      { type: "noop", reason: "terminal triage outcome; no plan/implementation/publish gate" },
    ]);
  });

  test("does not plan implementation for a valid refined plan that is not ready", async () => {
    const context = await tempContext();
    await writeReadyThroughPlan(context, "no");

    const steps = await planContinuation(context);

    expect(steps).toEqual([
      { type: "write-readiness", reason: "implementation plan is not ready; readiness records the stop" },
      { type: "noop", reason: "terminal planning outcome; no implementation/publish gate" },
    ]);
  });

  test("continues from a missing refinement after an existing fix pass", async () => {
    const context = await tempContext();
    await writeHappyPathThroughReviews(context, "fixes-required");
    await writeArtifact(context, fixLogRef(1), JSON.stringify(changeReport({ summary: "Fixed." })));

    const steps = await planContinuation(context);

    expect(steps[0]).toEqual({
      type: "run",
      phase: "refine-code",
      pass: 1,
      reason: "artifact is missing",
    });
  });

  test("writes readiness and runs the gate when latest review cycle is approved", async () => {
    const context = await tempContext();
    await writeHappyPathThroughReviews(context, "fixes-required");
    await writeArtifact(context, fixLogRef(1), JSON.stringify(changeReport({ summary: "Fixed." })));
    await writeArtifact(context, refinementLogRef(1), JSON.stringify(changeReport({ summary: "Refined." })));
    await writeArtifact(context, reviewARef(1), JSON.stringify(reviewResult()));
    await writeArtifact(context, reviewBRef(1), JSON.stringify(reviewResult()));

    const steps = await planContinuation(context);

    expect(steps).toEqual([
      { type: "write-readiness", reason: "latest review cycle approves; recompute deterministic readiness" },
      { type: "publish-gate", reason: "publish gate must run after readiness" },
    ]);
  });

  test("does not plan a fix for follow-up-only structured reviews", async () => {
    const context = await tempContext();
    await writeHappyPathThroughReviews(context, "approve", reviewResultJson([finding("FU1", "follow-up")]));

    const steps = await planContinuation(context);

    expect(steps).toEqual([
      { type: "write-readiness", reason: "reviews approve; recompute deterministic readiness" },
      { type: "publish-gate", reason: "publish gate must run after readiness" },
    ]);
  });

  test("plans readiness without fix work for external-blocker structured reviews", async () => {
    const context = await tempContext();
    await writeHappyPathThroughReviews(context, "approve", reviewResultJson([finding("B1", "external-blocker")]));

    const steps = await planContinuation(context);

    expect(steps).toEqual([
      { type: "write-readiness", reason: "a review is blocked; readiness records the stop" },
      { type: "publish-gate", reason: "publish gate records non-publish" },
    ]);
  });

  test("continues a failed verification attempt into fix/refine/review when budget remains", async () => {
    const context = await tempContext();
    context.maxFixPasses = 2;
    await writeHappyPathThroughReviews(context);
    await writeJsonArtifact(context, "readiness", readinessResult("ready-for-pr"));
    await writeArtifact(context, "verification", "# Verification\n\n## Exit Code\n1\n");

    const steps = await planContinuation(context, { attemptOutcome: "failed-verification" });

    expect(steps).toEqual([
      { type: "run", phase: "fix", pass: 1, reason: "verification failed; repair within remaining fix budget" },
      { type: "run", phase: "refine-code", pass: 1, reason: "refinement depends on verification repair" },
      { type: "run", phase: "review-a", pass: 1, reason: "review A depends on refinement" },
      { type: "run", phase: "review-b", pass: 1, reason: "review B depends on refinement" },
      { type: "write-readiness", reason: "workflow must recompute readiness after verification repair" },
      { type: "publish-gate", reason: "publish gate must rerun after verification repair" },
    ]);
  });

  test("does not auto-repair command-unavailable verification failures", async () => {
    const context = await tempContext();
    context.maxFixPasses = 2;
    await writeHappyPathThroughReviews(context);
    await writeArtifact(context, "verification", "# Verification\n\n## Command\n`bun run typecheck`\n\n## Exit Code\n127\n\n## Stdout (tail)\n```\n\n```\n\n## Stderr (tail)\n```\n/bin/bash: tsc: command not found\n```\n");

    const steps = await planContinuation(context, { attemptOutcome: "failed-verification" });

    expect(steps).toEqual([
      {
        type: "noop",
        reason: "verification command exited 127 because a required command was not found; Install dependencies in the verification workspace or configure hooks.beforeVerify, for example: bun install --frozen-lockfile.",
      },
    ]);
  });
});

async function writeReadyThroughPlan(context: Awaited<ReturnType<typeof tempContext>>, ready: "yes" | "no") {
  await writeArtifact(context, "issue", issueArtifact());
  await writeJsonArtifact(context, "triage", triageResult());
  await writeJsonArtifact(context, "implementationPlanDraft", implementationPlanResult());
  await writeJsonArtifact(context, "implementationPlan", implementationPlanResult(ready === "yes"));
}

async function writeHappyPathThroughReviews(
  context: Awaited<ReturnType<typeof tempContext>>,
  reviewVerdict = "approve",
  reviewAContent?: string,
) {
  await writeReadyThroughPlan(context, "yes");
  await writeArtifact(context, "preImplementationBaseline", JSON.stringify({ head: "abc", capturedAt: "now", excludes: [".roark"] }));
  await writeArtifact(context, "implementationLog", JSON.stringify(changeReport()));
  await writeArtifact(context, refinementLogRef(0), JSON.stringify(changeReport({ summary: "Refined." })));
  const findings = reviewVerdict === "fixes-required" ? [finding("Required fix", "must-fix-current")] : [];
  await writeArtifact(context, reviewARef(0), reviewAContent ?? reviewResultJson(findings));
  await writeArtifact(context, reviewBRef(0), reviewResultJson(findings));
}

function issueArtifact(): string {
  return "# GitHub Issue #11\n\n<github_issue_relationships source=\"gh\">\n  <blocking_status active_blockers=\"0\" total_blockers=\"0\" />\n</github_issue_relationships>\n";
}

function reviewResultJson(findings: ReviewFinding[]): string {
  return JSON.stringify(reviewResult(findings));
}

function finding(title: string, classification: FindingClassification): ReviewFinding {
  return reviewFinding(classification, title);
}
