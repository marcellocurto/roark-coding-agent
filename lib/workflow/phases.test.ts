import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runProcessOrThrow } from "../cli/process.ts";
import type { AgentRunner } from "./agent-runner.ts";
import { artifactExists, createWorkflowContext, fixLogMarkdownRef, fixLogRef, readArtifact, refinementLogRef, reviewAMarkdownRef, reviewARef, reviewBMarkdownRef, reviewBRef, writeArtifact, writeJsonArtifact } from "./artifacts.ts";
import { issueArtifactHasRelationshipSnapshot, reviewPhase, runFullWorkflow, runSinglePhase } from "./phases.ts";
import { noopAsync } from "../utils/async.ts";
import { reviewFinding, reviewResult, submitReview } from "../testing/reviews.ts";
import { parseReviewResultJson, type ReviewResult } from "../review/result.ts";
import { implementationPlanResult, submitImplementationPlan, submitTriage, triageResult } from "../testing/workflow-results.ts";
import { parseImplementationPlanResultJson } from "../implementation-plan/result.ts";
import { parseReadinessResultJson } from "./readiness.ts";
import { changeReport, submitChangeReport } from "../testing/change-reports.ts";
import { parseChangeReportJson } from "../change-report/result.ts";

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
    await writeJsonArtifact(context, "triage", proceedTriage());
    await writeJsonArtifact(context, "implementationPlan", readyPlan());
    await seedBaselineAndImplementation(context);
    await writeArtifact(context, refinementLogRef(0), refinementLog());
    await writeArtifact(context, reviewARef(0), "not valid review JSON");
    await writeArtifact(context, reviewBRef(0), JSON.stringify(approveReview()));
    const phases: string[] = [];

    await runSinglePhase(context, "review", async (request) => {
      await noopAsync();
      phases.push(request.display.phaseId);
      return submitReview(request, approveReview());
    });

    expect(phases).toEqual(["reviewA-0"]);
    expect(JSON.parse(await readArtifact(context, reviewARef(0)))).toEqual(approveReview());
    expect(artifactExists(context, reviewARef(1))).toBe(false);
    expect(artifactExists(context, reviewBRef(1))).toBe(false);
  });

  test("starts both reviewers together and retains Review B when Review A fails", async () => {
    const context = await tempContext();
    await writeJsonArtifact(context, "triage", proceedTriage());
    await writeJsonArtifact(context, "implementationPlan", readyPlan());
    await seedBaselineAndImplementation(context);
    await writeArtifact(context, refinementLogRef(0), refinementLog());
    let rejectReviewA: (error: Error) => void = () => undefined;
    const pendingReviewA = new Promise<string>((_resolve, reject) => {
      rejectReviewA = reject;
    });
    const startedPhases = new Set<string>();

    const run = reviewPhase(context, 0, (request) => {
      startedPhases.add(request.display.phaseId);
      if (request.display.phaseId === "reviewA-0") return pendingReviewA;
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
    const runner: AgentRunner = async (request) => submitTriage(request, triageResult("blocked"));

    const result = await runFullWorkflow(context, runner, { issueSnapshot });

    expect(result).toEqual({ status: "triage-stopped", triageVerdict: "blocked" });
    expect(await readArtifact(context, "issue")).toContain("Fresh pre-claim title");
    expect(JSON.parse(await readArtifact(context, "metadata"))).toMatchObject({
      issueNumber: "12",
      fetchedAt: "2026-05-07T00:00:01.000Z",
      issue: { title: "Fresh pre-claim title" },
    });
  });

  test("returns triage-stopped and does not run later agents after blocked triage", async () => {
    const context = await tempContext();
    const prompts: string[] = [];
    const runner: AgentRunner = async (request) => {
      await noopAsync();
      prompts.push(request.prompt);
      return submitTriage(request, triageResult("blocked"));
    };

    const result = await runFullWorkflow(context, runner);

    expect(result).toEqual({ status: "triage-stopped", triageVerdict: "blocked" });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('name="triage"');
    expect(artifactExists(context, "readiness")).toBe(true);
    expect(artifactExists(context, "implementationPlan")).toBe(false);
    expect(artifactExists(context, "implementationLog")).toBe(false);
    expect(parseReadinessResultJson(await readArtifact(context, "readiness")).decision.triageVerdict).toBe("blocked");
  });

  test("returns planning-stopped and does not implement when plan is not ready", async () => {
    const context = await tempContext();
    const phases: string[] = [];
    const runner: AgentRunner = async (request) => {
      await noopAsync();
      if (request.prompt.includes('name="triage"')) {
        phases.push("triage");
        return submitTriage(request, proceedTriage());
      }
      if (request.prompt.includes('name="implementation_plan_draft"')) {
        phases.push("plan-draft");
        return submitImplementationPlan(request, readyPlanDraft());
      }
      if (request.prompt.includes('name="implementation_plan_refinement"')) {
        phases.push("plan");
        return submitImplementationPlan(request, notReadyPlan());
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
      if (request.prompt.includes('name="triage"')) return submitTriage(request, proceedTriage());
      if (request.prompt.includes('name="implementation_plan_draft"')) return submitImplementationPlan(request, readyPlanDraft());
      if (request.prompt.includes('name="implementation_plan_refinement"')) return submitImplementationPlan(request, readyPlan());
      if (request.prompt.includes('name="code_refinement"')) return submitChangeReport(request, changeReport({ summary: "Refined." }));
      if (request.prompt.includes('name="review_a"') || request.prompt.includes('name="review_b"')) {
        return submitReview(request, approveReview());
      }
      throw new Error("unexpected prompt");
    };

    expect(runFullWorkflow(context, runner)).resolves.toEqual({ status: "completed" });
  });

  test("preserves novel plan and review sections without letting them change routing", async () => {
    const context = await tempContext();
    await seedBaselineAndImplementation(context);
    const plan = implementationPlanResult(true, {
      additionalSections: [{
        heading: "Repository-specific interaction",
        items: ["The existing adapter is shared by a command not named in the issue."],
      }],
    });
    const review = reviewResult([], {
      additionalSections: [{
        heading: "Positive architectural signal",
        items: ["The change reuses the established adapter seam without new indirection."],
      }],
    });

    const runner: AgentRunner = async (request) => {
      await noopAsync();
      if (request.prompt.includes('name="triage"')) return submitTriage(request, proceedTriage());
      if (request.prompt.includes('name="implementation_plan_draft"')) return submitImplementationPlan(request, readyPlanDraft());
      if (request.prompt.includes('name="implementation_plan_refinement"')) return submitImplementationPlan(request, plan);
      if (request.prompt.includes('name="code_refinement"')) return submitChangeReport(request, changeReport({ summary: "Refined." }));
      if (request.prompt.includes('name="review_a"')) return submitReview(request, review);
      if (request.prompt.includes('name="review_b"')) return submitReview(request, approveReview());
      throw new Error("unexpected prompt");
    };

    expect(runFullWorkflow(context, runner)).resolves.toEqual({ status: "completed" });
    expect(parseImplementationPlanResultJson(await readArtifact(context, "implementationPlan")).additionalSections)
      .toEqual(plan.additionalSections);
    expect(await readArtifact(context, "implementationPlanMarkdown")).toContain("## Repository-specific interaction");
    expect(parseReviewResultJson(await readArtifact(context, reviewARef(0)), { allowRestart: true }).additionalSections)
      .toEqual(review.additionalSections);
    expect(await readArtifact(context, reviewAMarkdownRef(0))).toContain("## Positive architectural signal");
    expect(parseReadinessResultJson(await readArtifact(context, "readiness")).decision.status).toBe("ready-for-pr");
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
      const phase = request.display.phaseId;
      phases.push(phase);
      if (request.prompt.includes('name="triage"')) return submitTriage(request, proceedTriage());
      if (request.prompt.includes('name="implementation_plan_draft"')) return submitImplementationPlan(request, readyPlanDraft());
      if (request.prompt.includes('name="implementation_plan_refinement"')) return submitImplementationPlan(request, readyPlan());
      if (phase === "refinementLog-0") return submitChangeReport(request, changeReport({ summary: "Refined." }));
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
        return submitChangeReport(request, changeReport({
          summary: "Fixed all required findings.",
          addressedFindingIds: ["review-a:reject-malformed-identifiers", "review-a:seed-authorization-state", "review-b:isolate-the-integration-fixture"],
        }));
      }
      if (phase === "refinementLog-1") return submitChangeReport(request, changeReport({ summary: "Refined." }));
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
    const persistedFix = parseChangeReportJson(await readArtifact(context, fixLogRef(1)));

    expect(persistedReviewA.findings.map(({ title }) => title)).toEqual(reviewAFindings.map(({ title }) => title));
    expect(persistedReviewB.findings.map(({ title }) => title)).toEqual(reviewBFindings.map(({ title }) => title));
    expect(await readArtifact(context, reviewAMarkdownRef(0))).toContain("seed-authorization-state: Seed authorization state");
    expect(await readArtifact(context, reviewBMarkdownRef(0))).toContain("isolate-the-integration-fixture: Isolate the integration fixture");
    expect(reviewsStartedTogether).toBe(true);
    expect(fixRequest).toContain("review-a-0.json");
    expect(fixRequest).toContain("review-b-0.json");
    expect(fixInputFindings).toEqual([
      "Reject malformed identifiers",
      "Seed authorization state",
      "Isolate the integration fixture",
    ]);
    expect(persistedFix.addressedFindingIds).toEqual(["review-a:reject-malformed-identifiers", "review-a:seed-authorization-state", "review-b:isolate-the-integration-fixture"]);
    expect(await readArtifact(context, fixLogMarkdownRef(1))).toContain("- review-b:isolate-the-integration-fixture");
    expect(phases).toContain("fixLog-1");
    expect(artifactExists(context, reviewARef(1))).toBe(true);
    expect(artifactExists(context, reviewBRef(1))).toBe(true);
    expect(result).toEqual({ status: "completed" });
    expect(parseReadinessResultJson(await readArtifact(context, "readiness")).decision.status).toBe("ready-for-pr");
  });

  test("does not run fix for follow-up and suggestion-only ledgers", async () => {
    const context = await tempContext();
    await seedBaselineAndImplementation(context);
    const phases: string[] = [];

    const runner: AgentRunner = async (request) => {
      await noopAsync();
      if (request.prompt.includes('name="triage"')) return submitTriage(request, proceedTriage());
      if (request.prompt.includes('name="implementation_plan_draft"')) return submitImplementationPlan(request, readyPlanDraft());
      if (request.prompt.includes('name="implementation_plan_refinement"')) return submitImplementationPlan(request, readyPlan());
      if (request.prompt.includes('name="code_refinement"')) return submitChangeReport(request, changeReport({ summary: "Refined." }));
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
    expect(parseReadinessResultJson(await readArtifact(context, "readiness")).decision.status).toBe("ready-for-pr");
  });

  test("external-blocker ledgers stop after review without running fix", async () => {
    const context = await tempContext();
    await seedBaselineAndImplementation(context);
    const phases: string[] = [];

    const runner: AgentRunner = async (request) => {
      await noopAsync();
      if (request.prompt.includes('name="triage"')) return submitTriage(request, proceedTriage());
      if (request.prompt.includes('name="implementation_plan_draft"')) return submitImplementationPlan(request, readyPlanDraft());
      if (request.prompt.includes('name="implementation_plan_refinement"')) return submitImplementationPlan(request, readyPlan());
      if (request.prompt.includes('name="code_refinement"')) return submitChangeReport(request, changeReport({ summary: "Refined." }));
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

    const result = await runFullWorkflow(context, runner);
    expect(result).toEqual({ status: "review-blocked" });
    expect([...phases].sort()).toEqual(["review-a", "review-b"]);
    expect(await readArtifact(context, "readinessMarkdown")).toContain("## External Blockers\n- review-a:blocker:b1");
  });

  test("fixes local findings before stopping on an independent external blocker", async () => {
    const context = await tempContext();
    await runProcessOrThrow(["git", "init", "-b", "main"], { cwd: context.agentCwd });
    await seedBaselineAndImplementation(context);
    const phases: string[] = [];

    const runner: AgentRunner = async (request) => {
      await noopAsync();
      const phase = request.display.phaseId;
      if (request.prompt.includes('name="triage"')) return submitTriage(request, proceedTriage());
      if (request.prompt.includes('name="implementation_plan_draft"')) return submitImplementationPlan(request, readyPlanDraft());
      if (request.prompt.includes('name="implementation_plan_refinement"')) return submitImplementationPlan(request, readyPlan());
      if (request.prompt.includes('name="code_refinement"')) return submitChangeReport(request, changeReport({ summary: "Refined." }));
      if (phase === "reviewA-0") {
        phases.push("review-a-0");
        return submitReview(request, reviewResult([
          finding("LOCAL-FIX", "must-fix-current"),
          finding("ACCESS", "external-blocker"),
        ]));
      }
      if (phase === "reviewA-1") {
        phases.push("review-a-1");
        return submitReview(request, reviewResult([finding("ACCESS", "external-blocker")]));
      }
      if (phase === "reviewB-0" || phase === "reviewB-1") return submitReview(request, approveReview());
      if (phase === "fixLog-1") {
        phases.push("fix");
        return submitChangeReport(request, changeReport({ addressedFindingIds: ["review-a:local-fix"] }));
      }
      throw new Error(`unexpected phase: ${phase}`);
    };

    const result = await runFullWorkflow(context, runner);
    expect(result).toEqual({ status: "review-blocked" });
    expect(phases).toEqual(["review-a-0", "fix", "review-a-1"]);
    expect(parseChangeReportJson(await readArtifact(context, fixLogRef(1))).addressedFindingIds)
      .toEqual(["review-a:local-fix"]);
  });
});

async function seedBaselineAndImplementation(context: Awaited<ReturnType<typeof tempContext>>) {
  await writeArtifact(context, "preImplementationBaseline", JSON.stringify({ head: "abc", capturedAt: "now", excludes: [".roark"] }));
  await writeArtifact(context, "implementationLog", JSON.stringify(changeReport({ summary: "Done." })));
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

function finding(id: string, classification: "must-fix-current" | "external-blocker" | "follow-up" | "suggestion") {
  return reviewFinding(classification, id);
}
