import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultWorkspaceConfig } from "../autorun/workspace.ts";
import type { PullRequestFeedback } from "../github/pr.ts";
import type { AgentRunRequest } from "../workflow/agent-runner.ts";
import { noopAsync } from "../utils/async.ts";
import { reviewFinding, reviewResult, submitReview } from "../testing/reviews.ts";
import type { ReviewResult } from "../review/result.ts";
import { runPrReview } from "./workflow.ts";
import { runProcessOrThrow } from "../cli/process.ts";
import { formatPrReviewComment } from "./comments.ts";

describe("runPrReview", () => {
  test("publishes every structured required fix from both reviewers", async () => {
    const control = await mkdtemp(path.join(tmpdir(), "roark-pr-review-control-"));
    const agent = await mkdtemp(path.join(tmpdir(), "roark-pr-review-agent-"));
    await initAgentRepo(agent);
    let publications = 0;
    let publishedComment = "";
    const feedback = reviewFeedback();

    const result = await runPrReview({
      command: "review-pr",
      prNumber: 12,
      cwd: control,
      outDir: ".roark/runs",
      repo: "owner/repo",
      verifyCommand: "bun test",
      verificationSource: "explicit",
      comment: true,
      workspace: defaultWorkspaceConfig,
    }, {
      fetchFeedback: async () => { await noopAsync(); return feedback; },
      prepareWorkspace: async () => { await noopAsync(); return ({
        path: agent,
        metadata: { path: agent, strategy: "clone", cloneRemote: "origin", createdNow: false },
        comparison: {
          baseOid: feedback.pr.baseRefOid,
          headOid: feedback.pr.headRefOid,
          mergeBaseOid: "merge123",
          changedFiles: ["lib/change.ts"],
          diffStat: "lib/change.ts | 1 +",
          inspectionCommand: `git diff merge123..${feedback.pr.headRefOid} --`,
        },
        releaseLock: async () => { await noopAsync(); },
      }); },
      runLifecycleHook: async () => { await noopAsync(); },
      assertWorkspace: async () => { await noopAsync(); },
      verificationRunner: async ({ command }) => {
        await noopAsync();
        return { ok: true, command, exitCode: 0, stdout: "passed", stderr: "" };
      },
      agentRunner: async (request) => {
        await noopAsync();
        return submitReview(request, request.phase?.endsWith("a") === true
          ? reviewResult([
            reviewFinding("must-fix-current", "Malformed IDs"),
            reviewFinding("must-fix-current", "Unseeded auth test"),
          ])
          : reviewResult([
            reviewFinding("must-fix-current", "Self-contained tests"),
            reviewFinding("suggestion", "Avoid wall-clock assertions"),
          ]));
      },
      publishComment: async (input) => {
        await noopAsync();
        publications++;
        publishedComment = formatPrReviewComment(input);
      },
    });

    expect(result.outcome).toBe("changes-requested");
    expect(result.published).toBe(true);
    expect(publications).toBe(1);
    expect(publishedComment).toContain("### Required fixes\n- **Malformed IDs**");
    expect(publishedComment).toContain("- **Unseeded auth test**");
    expect(publishedComment).toContain("- **Self-contained tests**");
    expect(publishedComment).toContain("### Suggestions\n- **Avoid wall-clock assertions**");
    expect(publishedComment).not.toContain("### Required fixes\n- None.");
    await rm(control, { recursive: true, force: true });
    await rm(agent, { recursive: true, force: true });
  });

  test("runs both reviewers read-only against the pinned diff and cleans mirrored artifacts", async () => {
    const control = await mkdtemp(path.join(tmpdir(), "roark-pr-review-control-"));
    const agent = await mkdtemp(path.join(tmpdir(), "roark-pr-review-agent-"));
    await initAgentRepo(agent);
    const feedback = reviewFeedback();
    const agentCalls: AgentRunRequest[] = [];
    let preparedCopyToWorktree: string[] | undefined;
    let preparedRepositoryUrl: string | undefined;

    await runPrReview({
      command: "review-pr",
      prNumber: 12,
      cwd: control,
      outDir: ".roark/runs",
      repo: "owner/repo",
      verifyCommand: "bun test",
      verificationSource: "explicit",
      comment: false,
      workspace: { ...defaultWorkspaceConfig, copyToWorktree: ["local.env"] },
    }, {
      fetchFeedback: async () => (await noopAsync(), feedback),
      prepareWorkspace: async (input) => {
        await noopAsync();
        preparedCopyToWorktree = input.workspace.copyToWorktree;
        preparedRepositoryUrl = input.repositoryUrl;
        return {
          path: agent,
          metadata: { path: agent, strategy: "clone", cloneRemote: "origin", createdNow: false },
          comparison: {
            baseOid: feedback.pr.baseRefOid,
            headOid: feedback.pr.headRefOid,
            mergeBaseOid: "merge123",
            changedFiles: ["lib/change.ts"],
            diffStat: "lib/change.ts | 1 +",
            inspectionCommand: `git diff merge123..${feedback.pr.headRefOid} --`,
          },
          releaseLock: async () => { await noopAsync(); },
        };
      },
      runLifecycleHook: async () => { await noopAsync(); },
      assertWorkspace: async () => { await noopAsync(); },
      verificationRunner: async ({ command }) => (await noopAsync(), { ok: true, command, exitCode: 0, stdout: "passed", stderr: "" }),
      agentRunner: async (request) => {
        agentCalls.push(request);
        return submitReview(request, approvedReview(request.phase ?? "review"));
      },
    });

    expect(preparedCopyToWorktree).toEqual([]);
    expect(preparedRepositoryUrl).toBe("https://github.com/owner/repo");
    expect(agentCalls).toHaveLength(2);
    expect(agentCalls.every((call) => !call.fileEditingToolsEnabled)).toBe(true);
    expect(agentCalls.every((call) => call.prompt.includes(`git diff merge123..${feedback.pr.headRefOid} --`))).toBe(true);
    expect(Bun.file(path.join(agent, ".roark/runs/pr/12/review-1")).exists()).resolves.toBe(false);
    expect(Bun.file(path.join(agent, ".git/roark/pr-review/12/review-1")).exists()).resolves.toBe(false);
    await rm(control, { recursive: true, force: true });
    await rm(agent, { recursive: true, force: true });
  });

  test("filters generated and unrelated feedback from reviewer context", async () => {
    const control = await mkdtemp(path.join(tmpdir(), "roark-pr-review-control-"));
    const agent = await mkdtemp(path.join(tmpdir(), "roark-pr-review-agent-"));
    await initAgentRepo(agent);
    const feedback = reviewFeedback();
    feedback.comments = [
      { author: "reviewer", body: "Human context" },
      { author: "roark", body: "<!-- roark:pr=12 phase=pr-review -->\nStale generated review" },
      { author: "roark", body: "<!-- roark:pr=12 revision=1 phase=revision-summary -->\nStale revision summary" },
    ];
    feedback.reviewThreadsTruncated = true;
    feedback.reviewThreads = [
      {
        id: "resolved-thread",
        isResolved: true,
        isOutdated: true,
        path: "lib/old.ts",
        originalLine: 10,
        comments: [{ author: "reviewer", body: "Historical concern" }],
      },
      {
        id: "active-thread",
        isResolved: false,
        isOutdated: false,
        path: "lib/current.ts",
        line: 20,
        comments: [{ author: "reviewer", body: "Active concern" }],
      },
    ];
    feedback.closingIssues = [
      { number: 126, title: "Shared contract", body: "Extract the contract", state: "OPEN", repository: "owner/repo", comments: [{ author: "maintainer", body: "Preserve backward compatibility" }] },
      { number: 127, title: "Pinned workspace", body: "Prepare the workspace", state: "OPEN", repository: "owner/repo" },
      { number: 9, title: "Unrelated external issue", body: "Ignore this", state: "OPEN", repository: "other/repo" },
    ];

    const result = await runPrReview({
      command: "review-pr",
      prNumber: 12,
      cwd: control,
      outDir: ".roark/runs",
      repo: "owner/repo",
      verificationSource: "unresolved",
      comment: false,
      workspace: defaultWorkspaceConfig,
    }, {
      fetchFeedback: async () => (await noopAsync(), feedback),
      prepareWorkspace: async () => (await noopAsync(), {
        path: agent,
        metadata: { path: agent, strategy: "clone", cloneRemote: "origin", createdNow: false },
        comparison: { baseOid: "base123", headOid: "head123", mergeBaseOid: "merge123", changedFiles: [], diffStat: "", inspectionCommand: "git diff merge123..head123 --" },
        releaseLock: async () => { await noopAsync(); },
      }),
      runLifecycleHook: async () => { await noopAsync(); },
      assertWorkspace: async () => { await noopAsync(); },
      agentRunner: async (request) => submitReview(request, approvedReview(request.phase ?? "review")),
    });

    const reviewContext = await readFile(path.join(result.context.reviewDir, "pr-context.md"), "utf8");
    expect(reviewContext).toContain("Shared contract");
    expect(reviewContext).toContain("Pinned workspace");
    expect(reviewContext).toContain("Preserve backward compatibility");
    expect(reviewContext).toContain("Human context");
    expect(reviewContext).toContain("Context incomplete");
    expect(reviewContext).toContain("[resolved, outdated] lib/old.ts:10 reviewer: Historical concern");
    expect(reviewContext).toContain("[unresolved, current] lib/current.ts:20 reviewer: Active concern");
    expect(reviewContext).not.toContain("Stale generated review");
    expect(reviewContext).not.toContain("Stale revision summary");
    expect(reviewContext).not.toContain("Unrelated external issue");
    await rm(control, { recursive: true, force: true });
    await rm(agent, { recursive: true, force: true });
  });

  test("retains full verification diagnostics outside the truncated reviewer artifact", async () => {
    const control = await mkdtemp(path.join(tmpdir(), "roark-pr-review-control-"));
    const agent = await mkdtemp(path.join(tmpdir(), "roark-pr-review-agent-"));
    await initAgentRepo(agent);
    const feedback = reviewFeedback();

    const result = await runPrReview({
      command: "review-pr",
      prNumber: 12,
      cwd: control,
      outDir: ".roark/runs",
      repo: "owner/repo",
      verifyCommand: "bun test",
      verificationSource: "explicit",
      comment: false,
      workspace: defaultWorkspaceConfig,
    }, {
      fetchFeedback: async () => (await noopAsync(), feedback),
      prepareWorkspace: async () => (await noopAsync(), {
        path: agent,
        metadata: { path: agent, strategy: "clone", cloneRemote: "origin", createdNow: false },
        comparison: { baseOid: "base123", headOid: "head123", mergeBaseOid: "merge123", changedFiles: [], diffStat: "", inspectionCommand: "git diff merge123..head123 --" },
        releaseLock: async () => { await noopAsync(); },
      }),
      runLifecycleHook: async () => { await noopAsync(); },
      assertWorkspace: async () => { await noopAsync(); },
      verificationRunner: async ({ command }) => (await noopAsync(), {
        ok: true,
        command,
        exitCode: 0,
        stdout: `diagnostic-at-start\n${"x".repeat(5_000)}\ndiagnostic-at-end`,
        stderr: "",
      }),
      agentRunner: async (request) => submitReview(request, approvedReview(request.phase ?? "review")),
    });

    const reviewerVerification = await readFile(path.join(result.context.reviewDir, "verification.md"), "utf8");
    const fullVerification = await readFile(path.join(result.context.reviewDir, "verification-full.md"), "utf8");
    expect(reviewerVerification).toContain("(truncated");
    expect(reviewerVerification).not.toContain("diagnostic-at-start");
    expect(fullVerification).toContain("diagnostic-at-start");
    expect(fullVerification).toContain("diagnostic-at-end");
    await rm(control, { recursive: true, force: true });
    await rm(agent, { recursive: true, force: true });
  });

  test("retains a review when PR requirement text changes and does not publish it", async () => {
    const control = await mkdtemp(path.join(tmpdir(), "roark-pr-review-stale-control-"));
    const agent = await mkdtemp(path.join(tmpdir(), "roark-pr-review-stale-agent-"));
    await initAgentRepo(agent);
    const initial = reviewFeedback();
    let fetches = 0;
    let publications = 0;
    const result = await runPrReview({
      command: "review-pr",
      prNumber: 12,
      cwd: control,
      outDir: ".roark/runs",
      repo: "owner/repo",
      verificationSource: "unresolved",
      comment: true,
      workspace: defaultWorkspaceConfig,
    }, {
      fetchFeedback: async () => {
        await noopAsync();
        fetches++;
        return fetches === 1 ? initial : { ...initial, pr: { ...initial.pr, title: "Changed title", body: "Changed requirements" } };
      },
      prepareWorkspace: async () => { await noopAsync(); return ({
        path: agent,
        metadata: { path: agent, strategy: "clone", cloneRemote: "origin", createdNow: false },
        comparison: { baseOid: "base123", headOid: "head123", mergeBaseOid: "merge123", changedFiles: [], diffStat: "", inspectionCommand: "git diff merge123..head123 --" },
        releaseLock: async () => { await noopAsync(); },
      }); },
      runLifecycleHook: async () => { await noopAsync(); },
      assertWorkspace: async () => { await noopAsync(); },
      agentRunner: async (request) => { await noopAsync(); return submitReview(request, approvedReview("R1")); },
      publishComment: async () => { await noopAsync(); publications++; },
    });
    expect(result.outcome).toBe("blocked");
    expect(result.stale).toBe(true);
    expect(result.decision.reasons[0]).toContain("title changed");
    expect(result.decision.reasons[0]).toContain("description changed");
    expect(publications).toBe(0);
    expect(Bun.file(path.join(result.context.reviewDir, "review-a.json")).exists()).resolves.toBe(true);
    await rm(control, { recursive: true, force: true });
    await rm(agent, { recursive: true, force: true });
  });

  test("preserves completed artifacts when comment publishing fails", async () => {
    const control = await mkdtemp(path.join(tmpdir(), "roark-pr-review-publish-control-"));
    const agent = await mkdtemp(path.join(tmpdir(), "roark-pr-review-publish-agent-"));
    await initAgentRepo(agent);
    const feedback = reviewFeedback();
    const run = runPrReview({
      command: "review-pr",
      prNumber: 12,
      cwd: control,
      outDir: ".roark/runs",
      repo: "owner/repo",
      verificationSource: "unresolved",
      comment: true,
      workspace: defaultWorkspaceConfig,
    }, {
      fetchFeedback: async () => { await noopAsync(); return feedback; },
      prepareWorkspace: async () => { await noopAsync(); return {
        path: agent,
        metadata: { path: agent, strategy: "clone", cloneRemote: "origin", createdNow: false },
        comparison: { baseOid: "base123", headOid: "head123", mergeBaseOid: "merge123", changedFiles: [], diffStat: "", inspectionCommand: "git diff merge123..head123 --" },
        releaseLock: async () => { await noopAsync(); },
      }; },
      runLifecycleHook: async () => { await noopAsync(); },
      assertWorkspace: async () => { await noopAsync(); },
      agentRunner: async (request) => { await noopAsync(); return submitReview(request, approvedReview("R1")); },
      publishComment: async () => { await noopAsync(); throw new Error("GitHub unavailable"); },
    });

    expect(run).rejects.toThrow("artifacts were preserved");
    await run.catch(() => undefined);
    const reviewDir = path.join(control, ".roark/runs/pr/12/review-1");
    expect(Bun.file(path.join(reviewDir, "review-a.json")).exists()).resolves.toBe(true);
    expect(await readFile(path.join(reviewDir, "metadata.json"), "utf8")).toContain('"publication": "failed"');
    await rm(control, { recursive: true, force: true });
    await rm(agent, { recursive: true, force: true });
  });

  test("waits for both reviewers before cleaning up after one reviewer fails", async () => {
    const control = await mkdtemp(path.join(tmpdir(), "roark-pr-review-failure-control-"));
    const agent = await mkdtemp(path.join(tmpdir(), "roark-pr-review-failure-agent-"));
    await initAgentRepo(agent);
    const feedback = reviewFeedback();
    let secondReviewerFinished = false;
    let lockReleasedEarly = false;

    const run = runPrReview({
      command: "review-pr",
      prNumber: 12,
      cwd: control,
      outDir: ".roark/runs",
      repo: "owner/repo",
      verificationSource: "unresolved",
      comment: false,
      workspace: defaultWorkspaceConfig,
    }, {
      fetchFeedback: async () => (await noopAsync(), feedback),
      prepareWorkspace: async () => (await noopAsync(), {
        path: agent,
        metadata: { path: agent, strategy: "clone", cloneRemote: "origin", createdNow: false },
        comparison: { baseOid: "base123", headOid: "head123", mergeBaseOid: "merge123", changedFiles: [], diffStat: "", inspectionCommand: "git diff merge123..head123 --" },
        releaseLock: async () => {
          await noopAsync();
          lockReleasedEarly = !secondReviewerFinished;
        },
      }),
      runLifecycleHook: async () => { await noopAsync(); },
      assertWorkspace: async () => { await noopAsync(); },
      agentRunner: async (request) => {
        if (request.phase === "pr-review-a") throw new Error("review A unavailable");
        await new Promise((resolve) => setTimeout(resolve, 20));
        secondReviewerFinished = true;
        return submitReview(request, approvedReview("B1"));
      },
    });

    expect(run).rejects.toThrow("review A unavailable");
    await run.catch(() => undefined);
    expect(secondReviewerFinished).toBe(true);
    expect(lockReleasedEarly).toBe(false);
    expect(Bun.file(path.join(control, ".roark/runs/pr/12/review-1/review-b.json")).exists()).resolves.toBe(true);
    expect(Bun.file(path.join(agent, ".git/roark/pr-review/12/review-1")).exists()).resolves.toBe(false);
    await rm(control, { recursive: true, force: true });
    await rm(agent, { recursive: true, force: true });
  });
});

function reviewFeedback(): PullRequestFeedback {
  return {
    repo: "owner/repo",
    pr: {
      number: 12,
      title: "Change behavior",
      body: "Implement the requested behavior",
      state: "OPEN",
      isDraft: true,
      baseRefName: "main",
      headRefName: "contributor/change",
      baseRefOid: "base123",
      headRefOid: "head123",
      baseRepository: "owner/repo",
      baseRepositoryUrl: "https://github.com/owner/repo",
      headRepository: "someone/fork",
    },
    comments: [],
    reviewThreads: [],
    plannerComments: [],
    excludedRoarkSummaryCommentIds: [],
    fetchedAt: "2026-07-12T00:00:00.000Z",
  };
}

function approvedReview(id: string): ReviewResult {
  return reviewResult([], { summary: "Approved.", evidenceReviewed: [id] });
}

async function initAgentRepo(cwd: string): Promise<void> {
  await runProcessOrThrow(["git", "init", "-b", "main"], { cwd });
}
