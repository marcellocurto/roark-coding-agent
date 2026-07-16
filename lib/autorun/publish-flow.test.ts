import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fixLogRef, readArtifact, reviewARef, reviewBRef, writeArtifact, writeJsonArtifact, type WorkflowContext } from "../workflow/artifacts.ts";
import { getWorkflowThinkingConfig } from "../workflow/thinking.ts";
import { createReviewerIssuesAfterPr, planVerificationRepair, runPublishGate } from "./publish-flow.ts";
import { runVerification, type VerificationResult } from "./verification.ts";
import { noopAsync } from "../utils/async.ts";
import { reviewFinding, reviewResult } from "../testing/reviews.ts";
import type { ReviewFinding } from "../review/result.ts";
import { readinessResult } from "../testing/workflow-results.ts";
import { changeReport } from "../testing/change-reports.ts";
import { configurePresenter } from "../presentation/presenter.ts";
import type { TerminalStream } from "../presentation/terminal.ts";
import type { ReviewPrCliOptions } from "../cli/args.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  configurePresenter({});
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("verification repair planning", () => {
  test("archives failed verification and schedules the next shared fix pass", async () => {
    const context = await tempContext(2);
    const repair = await planVerificationRepair(context, failedVerification(1));

    expect(repair).toEqual({ pass: 1 });
    expect(await readArtifact(context, { name: "verificationBeforeFix", pass: 1 })).toContain("## Exit Code\n1");
  });

  test("uses the next pass after reviewer-driven fixes", async () => {
    const context = await tempContext(2);
    await writeArtifact(context, fixLogRef(1), JSON.stringify(changeReport()));

    expect(await planVerificationRepair(context, failedVerification(1))).toEqual({ pass: 2 });
    expect(await readArtifact(context, { name: "verificationBeforeFix", pass: 2 })).toContain("## Exit Code\n1");
  });

  test("does not schedule repair when fix budget is exhausted", async () => {
    const context = await tempContext(1);
    await writeArtifact(context, fixLogRef(1), JSON.stringify(changeReport()));

    expect(await planVerificationRepair(context, failedVerification(1))).toBeUndefined();
  });

  test("does not consume fix budget for command-unavailable verification failures", async () => {
    const context = await tempContext(1);

    expect(await planVerificationRepair(context, failedVerification(127, "sh: missing: command not found"))).toBeUndefined();
  });

  test("canonical readiness JSON drives publication even when rendered Markdown disagrees", async () => {
    const context = await tempContext(1);
    context.model = "provider/reviewer";
    context.thinkingProfile = "deep";
    await writeJsonArtifact(context, "readiness", readinessResult("ready-for-pr"));
    await writeArtifact(context, "readinessMarkdown", "# PR Readiness\n\n## Status\nnot-ready\n");
    const postPrCalls: string[] = [];
    const prBodyUpdates: { pr: string; followUpCount: number }[] = [];
    const postPublicationOrder: string[] = [];
    const reviewCalls: ReviewPrCliOptions[] = [];
    const workspace = { root: "/tmp/roark-workspaces", strategy: "clone" as const, cloneRemote: "origin", clone: {}, copyToWorktree: ["local.env"] };
    const hooks = { beforeRun: "bun install", timeoutMs: 1234 };

    const outcome = await runPublishGate({
      options: {
        cwd: context.controlCwd,
        repo: "owner/repo",
        verifyCommand: "bun run typecheck",
        failureLabel: "failed",
        successLabel: "done",
        inProgressLabel: "in-progress",
        remote: "origin",
        baseBranch: "main",
        workspace,
        hooks,
      },
      issue: { number: 1, title: "Issue", url: "https://github.com/owner/repo/issues/1" },
      branchPlan: { issueNumber: 1, branchName: "roark/issue-1", baseBranch: "main" },
      workflowContext: context,
      attemptMetadata: attemptMetadata(context),
      attemptMetadataPath: ".roark/runs/issue/1/attempts/1/attempt.json",
    }, {
      refreshCopyToWorktree: async () => { await noopAsync(); },
      runLifecycleHook: async () => { await noopAsync(); },
      runVerification: async ({ command }) => (await noopAsync(), ({ ok: true, command, exitCode: 0, stdout: "ok", stderr: "" })),
      writeVerificationArtifact: async () => { await noopAsync(); },
      publishAutorunResult: async () => (await noopAsync(), { url: "https://github.com/owner/repo/pull/10", number: 10 }),
      publishIssueLedgerComment: async () => { await noopAsync(); return undefined; },
      postPrIssueCreation: async ({ prUrl }) => { await noopAsync(); postPrCalls.push(prUrl); return undefined; },
      updatePrBody: async ({ pr, followUpIssues }) => {
        await noopAsync();
        postPublicationOrder.push("body-update");
        prBodyUpdates.push({ pr, followUpCount: followUpIssues?.length ?? 0 });
      },
      runPrReview: async (options) => {
        await noopAsync();
        postPublicationOrder.push("pr-review");
        reviewCalls.push(options);
        return { outcome: "completed", context: { reviewDirRelative: ".roark/runs/pr/10/review-1" } };
      },
    });

    expect(outcome).toEqual({ outcome: "published", outcomeDetail: null });
    expect(postPrCalls).toEqual(["https://github.com/owner/repo/pull/10"]);
    expect(prBodyUpdates).toEqual([{ pr: "https://github.com/owner/repo/pull/10", followUpCount: 0 }]);
    expect(postPublicationOrder).toEqual(["body-update", "pr-review"]);
    expect(reviewCalls).toEqual([{
      command: "review-pr",
      prNumber: 10,
      cwd: context.controlCwd,
      outDir: context.outDir,
      repo: "owner/repo",
      model: "provider/reviewer",
      thinkingLevel: undefined,
      thinkingProfile: "deep",
      verifyCommand: "bun run typecheck",
      comment: true,
      workspace,
      hooks,
    }]);
  });

  test("automatic PR review failures do not turn an opened PR into a failed attempt", async () => {
    const context = await tempContext(1);
    await writeJsonArtifact(context, "readiness", readinessResult("ready-for-pr"));
    let warningOutput = "";
    const stream: TerminalStream = { isTTY: false, columns: 80, write(chunk) { warningOutput += chunk; } };
    configurePresenter({ stream, errorStream: stream, roots: [context.controlCwd] });

    const outcome = await runPublishGate({
      options: publishGateOptions(context),
      issue: { number: 1, title: "Issue", url: "https://github.com/owner/repo/issues/1" },
      branchPlan: { issueNumber: 1, branchName: "roark/issue-1", baseBranch: "main" },
      workflowContext: context,
      attemptMetadata: attemptMetadata(context),
      attemptMetadataPath: ".roark/runs/issue/1/attempts/1/attempt.json",
    }, successfulPublicationDependencies({
      runPrReview: async () => {
        await noopAsync();
        throw new Error("review service unavailable");
      },
    }));

    expect(outcome).toEqual({ outcome: "published", outcomeDetail: null });
    expect(warningOutput).toContain("automatic PR review failed after PR #10 was published");
    expect(warningOutput).toContain("review service unavailable");
  });

  test("a stale automatic PR review preserves the published outcome and review artifact", async () => {
    const context = await tempContext(1);
    await writeJsonArtifact(context, "readiness", readinessResult("ready-for-pr"));
    let warningOutput = "";
    const stream: TerminalStream = { isTTY: false, columns: 80, write(chunk) { warningOutput += chunk; } };
    configurePresenter({ stream, errorStream: stream, roots: [context.controlCwd] });

    const outcome = await runPublishGate({
      options: publishGateOptions(context),
      issue: { number: 1, title: "Issue", url: "https://github.com/owner/repo/issues/1" },
      branchPlan: { issueNumber: 1, branchName: "roark/issue-1", baseBranch: "main" },
      workflowContext: context,
      attemptMetadata: attemptMetadata(context),
      attemptMetadataPath: ".roark/runs/issue/1/attempts/1/attempt.json",
    }, successfulPublicationDependencies({
      runPrReview: async () => {
        await noopAsync();
        return { outcome: "blocked", context: { reviewDirRelative: ".roark/runs/pr/10/review-1" } };
      },
    }));

    expect(outcome).toEqual({ outcome: "published", outcomeDetail: null });
    expect(warningOutput).toContain("automatic PR review for #10 was blocked");
    expect(warningOutput).toContain("artifact: .roark/runs/pr/10/review-1");
  });

  test("failed readiness does not trigger post-PR reviewer issue creation", async () => {
    const context = await tempContext(1);
    await writeJsonArtifact(context, "readiness", readinessResult("not-ready"));
    let postPrCalled = false;
    let reviewPrCalled = false;

    const outcome = await runPublishGate({
      options: {
        cwd: context.controlCwd,
        repo: "owner/repo",
        verifyCommand: "bun run typecheck",
        failureLabel: "failed",
        successLabel: "done",
        inProgressLabel: "in-progress",
        remote: "origin",
        baseBranch: "main",
      },
      issue: { number: 1, title: "Issue", url: "https://github.com/owner/repo/issues/1" },
      branchPlan: { issueNumber: 1, branchName: "roark/issue-1", baseBranch: "main" },
      workflowContext: context,
      attemptMetadata: attemptMetadata(context),
      attemptMetadataPath: ".roark/runs/issue/1/attempts/1/attempt.json",
    }, {
      handleNonPublish: async () => { await noopAsync(); },
      postPrIssueCreation: async () => { await noopAsync(); postPrCalled = true; return undefined; },
      runPrReview: async () => {
        await noopAsync();
        reviewPrCalled = true;
        return { outcome: "completed", context: { reviewDirRelative: ".roark/runs/pr/10/review-1" } };
      },
    });

    expect(outcome.outcome).toBe("failed-readiness");
    expect(postPrCalled).toBe(false);
    expect(reviewPrCalled).toBe(false);
  });

  test("failed verification does not trigger post-PR reviewer issue creation", async () => {
    const context = await tempContext(0);
    await writeJsonArtifact(context, "readiness", readinessResult("ready-for-pr"));
    let postPrCalled = false;
    let reviewPrCalled = false;

    const outcome = await runPublishGate({
      options: {
        cwd: context.controlCwd,
        repo: "owner/repo",
        verifyCommand: "bun run typecheck",
        failureLabel: "failed",
        successLabel: "done",
        inProgressLabel: "in-progress",
        remote: "origin",
        baseBranch: "main",
      },
      issue: { number: 1, title: "Issue", url: "https://github.com/owner/repo/issues/1" },
      branchPlan: { issueNumber: 1, branchName: "roark/issue-1", baseBranch: "main" },
      workflowContext: context,
      attemptMetadata: attemptMetadata(context),
      attemptMetadataPath: ".roark/runs/issue/1/attempts/1/attempt.json",
    }, {
      refreshCopyToWorktree: async () => { await noopAsync(); },
      runLifecycleHook: async () => { await noopAsync(); },
      runVerification: async ({ command }) => (await noopAsync(), ({ ok: false, command, exitCode: 1, stdout: "", stderr: "lint failed" })),
      writeVerificationArtifact: async () => { await noopAsync(); },
      handleNonPublish: async () => { await noopAsync(); },
      postPrIssueCreation: async () => { await noopAsync(); postPrCalled = true; return undefined; },
      runPrReview: async () => {
        await noopAsync();
        reviewPrCalled = true;
        return { outcome: "completed", context: { reviewDirRelative: ".roark/runs/pr/10/review-1" } };
      },
    });

    expect(outcome.outcome).toBe("failed-verification");
    expect(postPrCalled).toBe(false);
    expect(reviewPrCalled).toBe(false);
  });

  test("verification runner exceptions propagate through the publish gate", async () => {
    const context = await tempContext(1);
    await writeJsonArtifact(context, "readiness", readinessResult("ready-for-pr"));
    await writeArtifact(context, "readinessMarkdown", "# PR Readiness\n\n## Status\nready-for-pr\n");
    const failure = new Error("verification runner failed");

    const running = runPublishGate({
      options: {
        cwd: context.controlCwd,
        repo: "owner/repo",
        verifyCommand: "bun run typecheck",
        failureLabel: "failed",
        successLabel: "done",
        inProgressLabel: "in-progress",
        remote: "origin",
        baseBranch: "main",
      },
      issue: { number: 1, title: "Issue", url: "https://github.com/owner/repo/issues/1" },
      branchPlan: { issueNumber: 1, branchName: "roark/issue-1", baseBranch: "main" },
      workflowContext: context,
      attemptMetadata: attemptMetadata(context),
      attemptMetadataPath: ".roark/runs/issue/1/attempts/1/attempt.json",
    }, {
      refreshCopyToWorktree: async () => { await noopAsync(); },
      runLifecycleHook: async () => { await noopAsync(); },
      runVerification: (input) => runVerification({ ...input, runner: () => Promise.reject(failure) }),
    });

    let thrown: unknown;
    try {
      await running;
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBe(failure);
  });

  test("post-PR reviewer issue creation curates numbered autorun review artifacts", async () => {
    const context = await tempContext(1);
    await writeArtifact(context, "issue", `<github_issue number="1">\n  <title>Issue</title>\n  <url>https://github.com/owner/repo/issues/1</url>\n</github_issue>`);
    await writeArtifact(context, reviewARef(0), structuredReview([reviewFinding("follow-up", "Document numbered review curation", {
      severity: "low",
      evidence: ["lib/workflow/issue-curation.ts:116 selects the latest numbered review artifact."],
      currentIssueImpact: "Reviewer findings from normal autorun attempts are promoted after PR publication.",
      recommendedHandling: "Use numbered review artifacts when curating reviewer-generated issues.",
      suggestedIssueTitle: "Document numbered review curation",
    })]));
    await writeArtifact(context, reviewBRef(0), structuredReview());
    await writeArtifact(context, "issueCreationResults", JSON.stringify({
      created: [{ planItemId: "follow-up-1", kind: "follow-up", title: "Document numbered review curation", url: "https://github.com/owner/repo/issues/100" }],
    }));

    await createReviewerIssuesAfterPr({ workflowContext: context, prUrl: "https://github.com/owner/repo/pull/10" });

    const plan = JSON.parse(await readArtifact(context, "issueCurationPlan")) as { run: { prUrl?: string; artifactPaths: string[] }; issuesToCreate: { planItemId: string; sourceFindingIds: string[]; runContext: { prUrl?: string } }[] };
    expect(plan.run.prUrl).toBe("https://github.com/owner/repo/pull/10");
    expect(plan.issuesToCreate).toHaveLength(1);
    expect(plan.issuesToCreate[0]?.planItemId).toBe("follow-up-1");
    expect(plan.issuesToCreate[0]?.sourceFindingIds).toEqual(["review-a:document-numbered-review-curation"]);
    expect(plan.issuesToCreate[0]?.runContext.prUrl).toBe("https://github.com/owner/repo/pull/10");
    expect(plan.run.artifactPaths).toContain(".roark/runs/issue/1/attempts/1/review-a-0.json");
  });

  test("terminal command-unavailable failures include setup guidance", async () => {
  await noopAsync();
    const context = await tempContext(1);
    await writeJsonArtifact(context, "readiness", readinessResult("ready-for-pr"));
    let failureComment = "";
    let output = "";
    const stream: TerminalStream = { isTTY: false, columns: 80, write(chunk) { output += chunk; } };
    configurePresenter({ stream, roots: [context.controlCwd] });

    const outcome = await runPublishGate({
      options: {
        cwd: context.controlCwd,
        repo: "owner/repo",
        verifyCommand: "bun run typecheck",
        failureLabel: "failed",
        successLabel: "done",
        inProgressLabel: "in-progress",
        remote: "origin",
        baseBranch: "main",
        hooks: { timeoutMs: 1000 },
      },
      issue: { number: 1, title: "Issue", url: "https://github.com/owner/repo/issues/1" },
      branchPlan: { issueNumber: 1, branchName: "roark/issue-1", baseBranch: "main" },
      workflowContext: context,
      attemptMetadata: {
        attempt: 1,
        issueNumber: 1,
        branch: "roark/issue-1",
        baseBranch: "main",
        worktreePath: context.agentCwd,
        runArtifactPath: context.runDirRelative,
        startedAt: new Date("2026-05-08T00:00:00.000Z").toISOString(),
        endedAt: null,
        outcome: "in-progress",
        outcomeDetail: null,
      },
      attemptMetadataPath: ".roark/runs/issue/1/attempts/1/attempt.json",
    }, {
      refreshCopyToWorktree: async () => {
        await noopAsync();},
      runLifecycleHook: async () => {
        await noopAsync();},
      runVerification: async ({ command }) => (await noopAsync(), ({
        ok: false,
        command,
        exitCode: 127,
        stdout: "",
        stderr: "/bin/bash: tsc: command not found",
      })),
      handleNonPublish: async ({ decision }) => {
        await noopAsync();
        failureComment = decision.reason;
      },
    });

    expect(outcome).toEqual({
      outcome: "failed-verification",
      outcomeDetail: "verification command exited 127 because a required command was not found. Install dependencies in the verification workspace or configure hooks.beforeVerify, for example: bun install --frozen-lockfile.",
    });
    expect(failureComment).toContain("hooks.beforeVerify");
    expect(output).toContain("artifact: .roark/runs/issue/1/attempts/1/verification.md");
    expect(output).toContain("ACTION user action required:");
  });
});

function attemptMetadata(context: WorkflowContext) {
  return {
    attempt: 1,
    issueNumber: 1,
    branch: "roark/issue-1",
    baseBranch: "main",
    worktreePath: context.agentCwd,
    runArtifactPath: context.runDirRelative,
    startedAt: new Date("2026-05-08T00:00:00.000Z").toISOString(),
    endedAt: null,
    outcome: "in-progress" as const,
    outcomeDetail: null,
  };
}

function publishGateOptions(context: WorkflowContext) {
  return {
    cwd: context.controlCwd,
    repo: "owner/repo",
    verifyCommand: "bun run typecheck",
    failureLabel: "failed",
    successLabel: "done",
    inProgressLabel: "in-progress",
    remote: "origin",
    baseBranch: "main",
  };
}

function successfulPublicationDependencies(overrides: Parameters<typeof runPublishGate>[1] = {}): Parameters<typeof runPublishGate>[1] {
  return {
    refreshCopyToWorktree: async () => { await noopAsync(); },
    runLifecycleHook: async () => { await noopAsync(); },
    runVerification: async ({ command }) => (await noopAsync(), ({ ok: true, command, exitCode: 0, stdout: "ok", stderr: "" })),
    writeVerificationArtifact: async () => { await noopAsync(); },
    publishAutorunResult: async () => (await noopAsync(), ({ url: "https://github.com/owner/repo/pull/10", number: 10 })),
    publishIssueLedgerComment: async () => { await noopAsync(); return undefined; },
    postPrIssueCreation: async () => { await noopAsync(); return undefined; },
    updatePrBody: async () => { await noopAsync(); },
    runPrReview: async () => (await noopAsync(), ({ outcome: "completed", context: { reviewDirRelative: ".roark/runs/pr/10/review-1" } })),
    ...overrides,
  };
}

async function tempContext(maxFixPasses: number): Promise<WorkflowContext> {
  const cwd = await mkdtemp(path.join(tmpdir(), "roark-publish-flow-"));
  tempDirs.push(cwd);
  const runDir = path.join(cwd, ".roark/runs/issue/1/attempts/1");
  await mkdir(runDir, { recursive: true });
  return {
    controlCwd: cwd,
    agentCwd: cwd,
    outDir: path.join(cwd, ".roark/runs"),
    runDir,
    runDirRelative: path.relative(cwd, runDir),
    issueInput: "1",
    issueNumber: "1",
    attempt: 1,
    force: false,
    yes: false,
    maxFixPasses,
    thinkingConfig: getWorkflowThinkingConfig(),
  };
}

function failedVerification(exitCode: number, stderr = "lint failed"): VerificationResult {
  return {
    ok: false,
    command: "bun run check",
    exitCode,
    stdout: "",
    stderr,
  };
}

function structuredReview(findings: ReviewFinding[] = []): string {
  return JSON.stringify(reviewResult(findings));
}
