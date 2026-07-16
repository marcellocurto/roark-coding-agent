import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultWorkspaceConfig } from "../autorun/workspace.ts";
import type { PullRequestFeedback } from "../github/pr.ts";
import type { AgentRunRequest } from "../workflow/agent-runner.ts";
import { noopAsync } from "../utils/async.ts";
import { runPrReview } from "./workflow.ts";
import { runProcessOrThrow } from "../cli/process.ts";
import { configurePresenter } from "../presentation/presenter.ts";
import type { TerminalStream } from "../presentation/terminal.ts";

describe("runPrReview", () => {
  test("sets the preparation title while workspace preparation is pending", async () => {
    let output = "";
    const stream: TerminalStream = { isTTY: true, columns: 80, write(chunk) { output += chunk; } };
    configurePresenter({ stream, env: { TERM: "xterm" } });
    let preparationStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { preparationStarted = resolve; });
    let rejectPreparation: ((error: Error) => void) | undefined;
    const pendingPreparation = new Promise<never>((_, reject) => { rejectPreparation = reject; });

    const running = runPrReview({
      command: "review-pr",
      prNumber: 12,
      cwd: "/tmp/control",
      outDir: ".roark/runs",
      repo: "owner/repo",
      verifyCommand: "true",
      comment: false,
      workspace: defaultWorkspaceConfig,
    }, {
      fetchFeedback: async () => (await noopAsync(), reviewFeedback()),
      prepareWorkspace: async () => {
        preparationStarted?.();
        return pendingPreparation;
      },
    });

    try {
      await started;
      const outputWhilePending = output;
      rejectPreparation?.(new Error("stop after title assertion"));
      expect(running).rejects.toThrow("stop after title assertion");
      await running.catch(() => undefined);
      expect(outputWhilePending).toContain("PR #12 · Review preparation");
    } finally {
      configurePresenter({});
    }
  });

  test("posts each reviewer's exact Markdown as its own comment", async () => {
    const control = await mkdtemp(path.join(tmpdir(), "roark-pr-review-control-"));
    const agent = await mkdtemp(path.join(tmpdir(), "roark-pr-review-agent-"));
    await initAgentRepo(agent);
    const publishedComments: string[] = [];
    const feedback = reviewFeedback();

    const result = await runPrReview({
      command: "review-pr",
      prNumber: 12,
      cwd: control,
      outDir: ".roark/runs",
      repo: "owner/repo",
      verifyCommand: "bun test",
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
        return request.display.phaseId.endsWith("a")
          ? "## Review A: Spec and Correctness\n\n**Changes requested.**\n\nFix malformed IDs."
          : "## Review B: Standards and Maintainability\n\n**Approved.**";
      },
      postComment: async (input) => {
        await noopAsync();
        publishedComments.push(input.body);
        return { id: publishedComments.length, marker: "" };
      },
    });

    expect(result.outcome).toBe("completed");
    expect(result.published).toBe(true);
    expect(publishedComments).toEqual([
      "<!-- roark:pr=12 phase=pr-review reviewer=a -->\n## Review A: Spec and Correctness\n\n**Changes requested.**\n\nFix malformed IDs.\n",
      "<!-- roark:pr=12 phase=pr-review reviewer=b -->\n## Review B: Standards and Maintainability\n\n**Approved.**\n",
    ]);
    expect(await readFile(path.join(result.context.reviewDir, "review-a.md"), "utf8")).toBe(
      "## Review A: Spec and Correctness\n\n**Changes requested.**\n\nFix malformed IDs.\n",
    );
    expect(Bun.file(path.join(result.context.reviewDir, "review-a.json")).exists()).resolves.toBe(false);
    expect(Bun.file(path.join(result.context.reviewDir, "summary.json")).exists()).resolves.toBe(false);
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
    let preparedBeforeVerifyHook: string | undefined;
    const lifecycleCalls: string[] = [];

    await runPrReview({
      command: "review-pr",
      prNumber: 12,
      cwd: control,
      outDir: ".roark/runs",
      repo: "owner/repo",
      verifyCommand: "bun test",
      comment: false,
      workspace: { ...defaultWorkspaceConfig, copyToWorktree: ["local.env"] },
      hooks: { beforeRun: "bun install", beforeVerify: "bun run setup-tests", afterRun: "echo done", timeoutMs: 1234 },
    }, {
      fetchFeedback: async () => (await noopAsync(), feedback),
      prepareWorkspace: async (input) => {
        await noopAsync();
        preparedCopyToWorktree = input.workspace.copyToWorktree;
        preparedRepositoryUrl = input.repositoryUrl;
        preparedBeforeVerifyHook = input.hooks.beforeVerify;
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
      runLifecycleHook: async (name, hooks) => {
        await noopAsync();
        lifecycleCalls.push(`${name}:${String(hooks?.timeoutMs)}`);
      },
      assertWorkspace: async () => { await noopAsync(); },
      verificationRunner: async ({ command }) => (await noopAsync(), { ok: true, command, exitCode: 0, stdout: "passed", stderr: "" }),
      agentRunner: async (request) => {
        await noopAsync();
        agentCalls.push(request);
        return approvedReview(request.display.phaseId);
      },
    });

    expect(preparedCopyToWorktree).toEqual(["local.env"]);
    expect(preparedRepositoryUrl).toBe("https://github.com/owner/repo");
    expect(preparedBeforeVerifyHook).toBe("bun run setup-tests");
    expect(lifecycleCalls).toEqual(["beforeRun:1234", "beforeVerify:1234", "afterRun:1234"]);
    expect(agentCalls).toHaveLength(2);
    expect(agentCalls.every((call) => !call.fileEditingToolsEnabled)).toBe(true);
    expect(agentCalls.every((call) => call.customTools === undefined)).toBe(true);
    expect(agentCalls.every((call) => call.prompt.includes(`git diff merge123..${feedback.pr.headRefOid} --`))).toBe(true);
    expect(agentCalls.every((call) => call.prompt.includes("Return only the final Markdown review"))).toBe(true);
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
      { author: "roark", body: "<!-- roark:pr=12 phase=pr-review reviewer=a -->\nStale generated review" },
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
      verifyCommand: "true",
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
      agentRunner: async (request) => (await noopAsync(), approvedReview(request.display.phaseId)),
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
      agentRunner: async (request) => (await noopAsync(), approvedReview(request.display.phaseId)),
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
      verifyCommand: "true",
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
      agentRunner: async () => { await noopAsync(); return approvedReview("R1"); },
      postComment: async () => { await noopAsync(); publications++; return { id: publications, marker: "" }; },
    });
    expect(result.outcome).toBe("blocked");
    expect(result.stale).toBe(true);
    expect(publications).toBe(0);
    expect(Bun.file(path.join(result.context.reviewDir, "review-a.md")).exists()).resolves.toBe(true);
    expect(await readFile(path.join(result.context.reviewDir, "metadata.json"), "utf8")).toContain("title changed");
    expect(await readFile(path.join(result.context.reviewDir, "metadata.json"), "utf8")).toContain("description changed");
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
      verifyCommand: "true",
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
      agentRunner: async () => { await noopAsync(); return approvedReview("R1"); },
      postComment: async () => { await noopAsync(); throw new Error("GitHub unavailable"); },
    });

    expect(run).rejects.toThrow("reviewer comment publishing failed");
    await run.catch(() => undefined);
    const reviewDir = path.join(control, ".roark/runs/pr/12/review-1");
    expect(Bun.file(path.join(reviewDir, "review-a.md")).exists()).resolves.toBe(true);
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
      verifyCommand: "true",
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
        if (request.display.phaseId === "pr-review-a") throw new Error("review A unavailable");
        await new Promise((resolve) => setTimeout(resolve, 20));
        secondReviewerFinished = true;
        return approvedReview("B1");
      },
    });

    expect(run).rejects.toThrow("review A unavailable");
    await run.catch(() => undefined);
    expect(secondReviewerFinished).toBe(true);
    expect(lockReleasedEarly).toBe(false);
    expect(Bun.file(path.join(control, ".roark/runs/pr/12/review-1/review-b.md")).exists()).resolves.toBe(true);
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

function approvedReview(id: string): string {
  return `## Review\n\n**Approved.**\n\n${id}`;
}

async function initAgentRepo(cwd: string): Promise<void> {
  await runProcessOrThrow(["git", "init", "-b", "main"], { cwd });
}
