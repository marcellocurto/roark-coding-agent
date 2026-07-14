import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runProcessOrThrow } from "../cli/process.ts";
import type { AgentRunner } from "./agent-runner.ts";
import { artifactExists, createWorkflowContext, readArtifact, refinementLogRef, reviewARef, reviewBRef, writeArtifact } from "./artifacts.ts";
import { issueArtifactHasRelationshipSnapshot, reviewPhase, runFullWorkflow, runSinglePhase } from "./phases.ts";
import { noopAsync } from "../utils/async.ts";
import { reviewFinding, reviewResult, submitReview } from "../testing/reviews.ts";
import { parseReviewResultJson, type ReviewResult } from "../review/result.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
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
  await writeArtifact(
    context,
    "issue",
    "# GitHub Issue #12\n\n<github_issue_relationships source=\"gh\">\n  <blocking_status active_blockers=\"0\" total_blockers=\"0\" />\n</github_issue_relationships>\n",
  );
  return context;
}

describe("issueArtifactHasRelationshipSnapshot", () => {
  test("requires a machine-generated relationship snapshot before reusing issue artifacts", () => {
    expect(issueArtifactHasRelationshipSnapshot("# GitHub Issue #12\n")).toBe(false);
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
    await writeArtifact(context, "triage", proceedTriage());
    await writeArtifact(context, "implementationPlan", readyPlan());
    await seedBaselineAndImplementation(context);
    await writeArtifact(context, refinementLogRef(0), refinementLog());
    await writeArtifact(context, reviewARef(0), "not valid review JSON");
    await writeArtifact(context, reviewBRef(0), JSON.stringify(approveReview()));
    const phases: string[] = [];

    await runSinglePhase(context, "review", async (request) => {
      await noopAsync();
      phases.push(request.phase ?? "unknown");
      return submitReview(request, approveReview());
    });

    expect(phases).toEqual(["reviewA-0"]);
    expect(JSON.parse(await readArtifact(context, reviewARef(0)))).toEqual(approveReview());
    expect(artifactExists(context, reviewARef(1))).toBe(false);
    expect(artifactExists(context, reviewBRef(1))).toBe(false);
  });

  test("starts both reviewers together and retains Review B when Review A fails", async () => {
    const context = await tempContext();
    await writeArtifact(context, "triage", proceedTriage());
    await writeArtifact(context, "implementationPlan", readyPlan());
    await seedBaselineAndImplementation(context);
    await writeArtifact(context, refinementLogRef(0), refinementLog());
    let rejectReviewA: (error: Error) => void = () => undefined;
    const pendingReviewA = new Promise<string>((_resolve, reject) => {
      rejectReviewA = reject;
    });
    const startedPhases = new Set<string>();

    const run = reviewPhase(context, 0, (request) => {
      startedPhases.add(request.phase ?? "unknown");
      if (request.phase === "reviewA-0") return pendingReviewA;
      return submitReview(request, approveReview());
    });
    for (let turn = 0; turn < 50 && !startedPhases.has("reviewB-0"); turn++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const reviewBStartedBeforeReviewAFinished = startedPhases.has("reviewB-0");
    rejectReviewA(new Error("review A unavailable"));
    const error = await run.then(
      () => undefined,
      (reason: unknown) => reason,
    );

    expect(reviewBStartedBeforeReviewAFinished).toBe(true);
    expect(error instanceof Error ? error.message : String(error)).toContain("review A unavailable");
    expect(artifactExists(context, reviewARef(0))).toBe(false);
    expect(artifactExists(context, reviewBRef(0))).toBe(true);
  });
});

describe("runFullWorkflow", () => {
  test("returns triage-stopped and does not run later agents after blocked triage", async () => {
    const context = await tempContext();
    const prompts: string[] = [];
    const runner: AgentRunner = async (request) => {
      await noopAsync();
      prompts.push(request.prompt);
      return "# Triage\n\n## Verdict\nblocked\n\n## Reasoning\nWaiting.\n\n## Evidence\n#7 is open.\n\n## Blocking Questions\nNone.\n\n## Recommended Next Step\nWait.\n";
    };

    const result = await runFullWorkflow(context, runner);

    expect(result).toEqual({ status: "triage-stopped", triageVerdict: "blocked" });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('name="triage"');
    expect(artifactExists(context, "readiness")).toBe(true);
    expect(artifactExists(context, "implementationPlan")).toBe(false);
    expect(artifactExists(context, "implementationLog")).toBe(false);
    expect(await readArtifact(context, "readiness")).toContain("- Triage verdict: blocked");
  });

  test("returns planning-stopped and does not implement when plan is not ready", async () => {
    const context = await tempContext();
    const phases: string[] = [];
    const runner: AgentRunner = async (request) => {
      await noopAsync();
      if (request.prompt.includes('name="triage"')) {
        phases.push("triage");
        return proceedTriage();
      }
      if (request.prompt.includes('name="implementation_plan_draft"')) {
        phases.push("plan-draft");
        return readyPlanDraft();
      }
      if (request.prompt.includes('name="implementation_plan_refinement"')) {
        phases.push("plan");
        return notReadyPlan();
      }
      phases.push("unexpected");
      throw new Error("unexpected prompt");
    };

    expect(runFullWorkflow(context, runner)).resolves.toEqual({ status: "planning-stopped" });
    expect(phases).toEqual(["triage", "plan-draft", "plan"]);
    expect(artifactExists(context, "readiness")).toBe(true);
    expect(artifactExists(context, "implementationLog")).toBe(false);
  });

  test("completed path returns completed", async () => {
    const context = await tempContext();
    await seedBaselineAndImplementation(context);

    const runner: AgentRunner = async (request) => {
      await noopAsync();
      if (request.prompt.includes('name="triage"')) return proceedTriage();
      if (request.prompt.includes('name="implementation_plan_draft"')) return readyPlanDraft();
      if (request.prompt.includes('name="implementation_plan_refinement"')) return readyPlan();
      if (request.prompt.includes('name="code_refinement"')) return refinementLog();
      if (request.prompt.includes('name="review_a"') || request.prompt.includes('name="review_b"')) {
        return submitReview(request, approveReview());
      }
      throw new Error("unexpected prompt");
    };

    expect(runFullWorkflow(context, runner)).resolves.toEqual({ status: "completed" });
  });

  test("persists both reviewers' required findings, fixes them, and becomes ready after approval", async () => {
    const context = await tempContext();
    await runProcessOrThrow(["git", "init", "-b", "main"], { cwd: context.agentCwd });
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

    const runner: AgentRunner = async (request) => {
      await noopAsync();
      const phase = request.phase ?? "unknown";
      phases.push(phase);
      if (request.prompt.includes('name="triage"')) return proceedTriage();
      if (request.prompt.includes('name="implementation_plan_draft"')) return readyPlanDraft();
      if (request.prompt.includes('name="implementation_plan_refinement"')) return readyPlan();
      if (phase === "refinementLog-0") return refinementLog(0);
      if (phase === "reviewA-0") {
        passZeroReviewsStarted.add(phase);
        announcePassZeroReviewStarted();
        await passZeroReviewsMayFinish;
        return submitReview(request, reviewResult(reviewAFindings));
      }
      if (phase === "reviewB-0") {
        passZeroReviewsStarted.add(phase);
        announcePassZeroReviewStarted();
        await passZeroReviewsMayFinish;
        return submitReview(request, reviewResult(reviewBFindings));
      }
      if (phase === "fixLog-1") {
        fixRequest = request.prompt;
        const reviewA = parseReviewResultJson(await readArtifact(context, reviewARef(0)), { allowRestart: true });
        const reviewB = parseReviewResultJson(await readArtifact(context, reviewBRef(0)), { allowRestart: true });
        fixInputFindings = [...reviewA.findings, ...reviewB.findings].map(({ title }) => title);
        return "# Fix Log Pass 1\n\n## Summary\nFixed all required findings.\n";
      }
      if (phase === "refinementLog-1") return refinementLog(1);
      if (phase === "reviewA-1" || phase === "reviewB-1") return submitReview(request, approveReview());
      throw new Error(`unexpected phase: ${phase}`);
    };

    const workflow = runFullWorkflow(context, runner);
    await Promise.race([
      passZeroReviewStarted,
      workflow.then(() => {
        throw new Error("workflow completed before pass-zero reviews started");
      }),
    ]);
    for (let turn = 0; turn < 50 && passZeroReviewsStarted.size < 2; turn++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const reviewsStartedTogether = passZeroReviewsStarted.size === 2;
    releasePassZeroReviews();
    const result = await workflow;
    const persistedReviewA = parseReviewResultJson(await readArtifact(context, reviewARef(0)), { allowRestart: true });
    const persistedReviewB = parseReviewResultJson(await readArtifact(context, reviewBRef(0)), { allowRestart: true });

    expect(persistedReviewA.findings.map(({ title }) => title)).toEqual(reviewAFindings.map(({ title }) => title));
    expect(persistedReviewB.findings.map(({ title }) => title)).toEqual(reviewBFindings.map(({ title }) => title));
    expect(reviewsStartedTogether).toBe(true);
    expect(fixRequest).toContain("review-a-0.json");
    expect(fixRequest).toContain("review-b-0.json");
    expect(fixInputFindings).toEqual([
      "Reject malformed identifiers",
      "Seed authorization state",
      "Isolate the integration fixture",
    ]);
    expect(phases).toContain("fixLog-1");
    expect(artifactExists(context, reviewARef(1))).toBe(true);
    expect(artifactExists(context, reviewBRef(1))).toBe(true);
    expect(result).toEqual({ status: "completed" });
    expect(await readArtifact(context, "readiness")).toContain("## Status\nready-for-pr");
  });

  test("does not run fix for follow-up and suggestion-only ledgers", async () => {
    const context = await tempContext();
    await seedBaselineAndImplementation(context);
    const phases: string[] = [];

    const runner: AgentRunner = async (request) => {
      await noopAsync();
      if (request.prompt.includes('name="triage"')) return proceedTriage();
      if (request.prompt.includes('name="implementation_plan_draft"')) return readyPlanDraft();
      if (request.prompt.includes('name="implementation_plan_refinement"')) return readyPlan();
      if (request.prompt.includes('name="code_refinement"')) return refinementLog();
      if (request.prompt.includes('name="review_a"')) {
        phases.push("review-a");
        return submitReview(request, reviewResult([
          finding("F1", "follow-up"),
          finding("S1", "suggestion"),
        ]));
      }
      if (request.prompt.includes('name="review_b"')) {
        phases.push("review-b");
        return submitReview(request, approveReview());
      }
      if (request.prompt.includes('name="fix"')) phases.push("fix");
      throw new Error("unexpected prompt");
    };

    expect(runFullWorkflow(context, runner)).resolves.toEqual({ status: "completed" });
    expect([...phases].sort()).toEqual(["review-a", "review-b"]);
    expect(await readArtifact(context, "readiness")).toContain("## Status\nready-for-pr");
  });

  test("external-blocker ledgers stop after review without running fix", async () => {
    const context = await tempContext();
    await seedBaselineAndImplementation(context);
    const phases: string[] = [];

    const runner: AgentRunner = async (request) => {
      await noopAsync();
      if (request.prompt.includes('name="triage"')) return proceedTriage();
      if (request.prompt.includes('name="implementation_plan_draft"')) return readyPlanDraft();
      if (request.prompt.includes('name="implementation_plan_refinement"')) return readyPlan();
      if (request.prompt.includes('name="code_refinement"')) return refinementLog();
      if (request.prompt.includes('name="review_a"')) {
        phases.push("review-a");
        return submitReview(request, reviewResult([finding("B1", "external-blocker")]));
      }
      if (request.prompt.includes('name="review_b"')) {
        phases.push("review-b");
        return submitReview(request, approveReview());
      }
      if (request.prompt.includes('name="fix"')) phases.push("fix");
      throw new Error("unexpected prompt");
    };

    expect(runFullWorkflow(context, runner)).resolves.toEqual({ status: "review-blocked" });
    expect([...phases].sort()).toEqual(["review-a", "review-b"]);
    expect(await readArtifact(context, "readiness")).toContain("## External Blockers\n- review-a:A-001");
  });
});

async function seedBaselineAndImplementation(context: Awaited<ReturnType<typeof tempContext>>) {
  await writeArtifact(context, "preImplementationBaseline", JSON.stringify({ head: "abc", capturedAt: "now", excludes: [".roark"] }));
  await writeArtifact(context, "implementationLog", "# Implementation Log\n\n## Summary\nDone.\n");
}

function proceedTriage(): string {
  return "# Triage\n\n## Verdict\nproceed\n\n## Reasoning\nOK.\n\n## Evidence\nRepo inspected.\n\n## Blocking Questions\nNone.\n\n## Recommended Next Step\nPlan.\n";
}

function readyPlanDraft(): string {
  return readyPlan().replace("# Implementation Plan", "# Implementation Plan Draft");
}

function readyPlan(): string {
  return "# Implementation Plan\n\n## Issue\n#12\n\n## Work Classification\nbackend\n\n## Goal\nTest.\n\n## Non-Goals\nNone.\n\n## Current Code Findings\nFound.\n\n## Proposed Changes\nChange.\n\n## Files Likely To Change\nFiles.\n\n## Detailed Steps\nSteps.\n\n## Tests And Validation\nTests.\n\n## Risks\nLow.\n\n## Rollback Plan\nRevert.\n\n## Ready For Implementation\nyes\n";
}

function notReadyPlan(): string {
  return readyPlan().replace("## Ready For Implementation\nyes", "## Ready For Implementation\nno");
}

function refinementLog(pass = 0): string {
  return `# Refinement Log Pass ${pass}\n\n## Summary\nRefined.\n`;
}

function approveReview(): ReviewResult {
  return reviewResult();
}

function finding(id: string, classification: "external-blocker" | "follow-up" | "suggestion") {
  return reviewFinding(classification, id);
}
