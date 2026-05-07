import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { createWorkflowContext, writeArtifact } from "../workflow/artifacts.ts";
import { finalReviewRef, fixLogRef } from "../workflow/artifacts.ts";
import { planContinuation } from "./continue-plan.ts";

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
  test("reruns only invalid Review B before readiness and publish gate", async () => {
    const context = await tempContext();
    await writeHappyPathThroughReviews(context);
    await writeArtifact(context, "reviewB", "");

    const steps = await planContinuation(context);

    expect(steps).toEqual([
      { type: "run", phase: "review-b", reason: "artifact is empty" },
      { type: "write-readiness", reason: "workflow must recompute readiness" },
      { type: "publish-gate", reason: "publish gate must run after readiness" },
    ]);
  });

  test("treats non-proceed triage as terminal", async () => {
    const context = await tempContext();
    await writeArtifact(context, "issue", issueArtifact());
    await writeArtifact(context, "triage", "# Triage\n\n## Verdict\nneeds-human-decision\n");

    const steps = await planContinuation(context);

    expect(steps).toEqual([
      { type: "write-readiness", reason: 'triage verdict is "needs-human-decision"; readiness records the stop' },
      { type: "noop", reason: "terminal triage outcome; no plan/implementation/publish gate" },
    ]);
  });

  test("does not plan implementation for a valid plan that is not ready", async () => {
    const context = await tempContext();
    await writeArtifact(context, "issue", issueArtifact());
    await writeArtifact(context, "triage", "# Triage\n\n## Verdict\nproceed\n");
    await writeArtifact(context, "implementationPlan", "# Implementation Plan\n\n## Ready For Implementation\nno\n");

    const steps = await planContinuation(context);

    expect(steps).toEqual([
      { type: "write-readiness", reason: "implementation plan is not ready; readiness records the stop" },
      { type: "noop", reason: "terminal planning outcome; no implementation/publish gate" },
    ]);
  });

  test("continues from a missing final review after an existing fix pass", async () => {
    const context = await tempContext();
    await writeHappyPathThroughReviews(context, "fixes-required");
    await writeArtifact(context, fixLogRef(1), "# Fix Log Pass 1\n\n## Summary\nFixed.\n");

    const steps = await planContinuation(context);

    expect(steps[0]).toEqual({
      type: "run",
      phase: "final-review",
      pass: 1,
      reason: "artifact is missing",
    });
  });

  test("writes readiness and runs the gate when final review is ready", async () => {
    const context = await tempContext();
    await writeHappyPathThroughReviews(context, "fixes-required");
    await writeArtifact(context, fixLogRef(1), "# Fix Log Pass 1\n\n## Summary\nFixed.\n");
    await writeArtifact(context, finalReviewRef(1), "# Final Review Pass 1\n\n## Verdict\nready-for-pr\n");

    const steps = await planContinuation(context);

    expect(steps).toEqual([
      { type: "write-readiness", reason: "latest final review decides readiness" },
      { type: "publish-gate", reason: "publish gate must run after readiness" },
    ]);
  });

  test("does not plan a fix for follow-up-only review ledgers", async () => {
    const context = await tempContext();
    await writeHappyPathThroughReviews(context, "approve", reviewWithLedger("approve", finding("FU1", "follow-up")));

    const steps = await planContinuation(context);

    expect(steps).toEqual([
      { type: "write-readiness", reason: "reviews approve; recompute deterministic readiness" },
      { type: "publish-gate", reason: "publish gate must run after readiness" },
    ]);
  });

  test("plans readiness without fix work for external-blocker review ledgers", async () => {
    const context = await tempContext();
    await writeHappyPathThroughReviews(context, "approve", reviewWithLedger("blocked", finding("B1", "external-blocker")));

    const steps = await planContinuation(context);

    expect(steps).toEqual([
      { type: "write-readiness", reason: "a review is blocked; readiness records the stop" },
      { type: "publish-gate", reason: "publish gate records non-publish" },
    ]);
  });
});

async function writeHappyPathThroughReviews(
  context: Awaited<ReturnType<typeof tempContext>>,
  reviewVerdict = "approve",
  reviewAContent?: string,
) {
  await writeArtifact(context, "issue", issueArtifact());
  await writeArtifact(context, "triage", "# Triage\n\n## Verdict\nproceed\n");
  await writeArtifact(context, "implementationPlan", "# Implementation Plan\n\n## Ready For Implementation\nyes\n");
  await writeArtifact(context, "implementationLog", "# Implementation Log\n\n## Summary\nDone.\n");
  await writeArtifact(context, "reviewA", reviewAContent ?? `# Review A\n\n## Verdict\n${reviewVerdict}\n`);
  await writeArtifact(context, "reviewB", `# Review B\n\n## Verdict\n${reviewVerdict}\n`);
}

function issueArtifact(): string {
  return "# GitHub Issue #11\n\n<github_issue_relationships source=\"gh\">\n  <blocking_status active_blockers=\"0\" total_blockers=\"0\" />\n</github_issue_relationships>\n";
}

function reviewWithLedger(verdict: "approve" | "fixes-required" | "blocked", entries: string): string {
  return `# Review A\n\n## Verdict\n${verdict}\n\n## Findings Ledger\n${entries}\n`;
}

function finding(id: string, classification: string): string {
  return `- Identifier: ${id}\n- Classification: ${classification}\n- Title: ${id}\n- Severity: medium\n- Confidence: high\n- Evidence: file.ts:1\n- Current-issue impact: Impact.\n- Recommended handling: Handle.\n`;
}
