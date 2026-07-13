import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultLifecycleHooks, defaultWorkspaceConfig } from "../autorun/workspace.ts";
import type { PullRequestFeedback } from "../github/pr.ts";
import type { AgentRunRequest } from "../workflow/agent-runner.ts";
import { noopAsync } from "../utils/async.ts";
import { runPrReview } from "./workflow.ts";
import { runProcessOrThrow } from "../cli/process.ts";

describe("runPrReview", () => {
  test("reviews a PR with two inspection-only agents, bounded context, one verification, and one current comment", async () => {
    const control = await mkdtemp(path.join(tmpdir(), "roark-pr-review-control-"));
    const agent = await mkdtemp(path.join(tmpdir(), "roark-pr-review-agent-"));
    await initAgentRepo(agent);
    const agentCalls: AgentRunRequest[] = [];
    let verificationRuns = 0;
    let publications = 0;
    let preparedCopyToWorktree: string[] | undefined;
    const feedback = reviewFeedback();
    feedback.comments = [
      { author: "reviewer", body: "Human context" },
      { author: "roark", body: "<!-- roark:pr=12 phase=pr-review -->\nStale generated review" },
      { author: "roark", body: "<!-- roark:pr=12 revision=1 phase=revision-summary -->\nStale revision summary" },
    ];
    feedback.reviewThreadsTruncated = true;
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
      verifyCommand: "bun test",
      verificationSource: "explicit",
      comment: true,
      workspace: { ...defaultWorkspaceConfig, copyToWorktree: ["local.env"] },
      hooks: defaultLifecycleHooks,
    }, {
      fetchFeedback: async () => { await noopAsync(); return feedback; },
      prepareWorkspace: async (input) => { await noopAsync(); preparedCopyToWorktree = input.workspace.copyToWorktree; return ({
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
        verificationRuns++;
        return { ok: true, command, exitCode: 0, stdout: `diagnostic-at-start\n${"x".repeat(5_000)}\ndiagnostic-at-end`, stderr: "" };
      },
      agentRunner: async (request) => {
        await noopAsync();
        agentCalls.push(request);
        return approvedReview(request.phase?.endsWith("a") === true ? "A1" : "B1");
      },
      publishComment: async () => { await noopAsync(); publications++; },
    });

    expect(result.outcome).toBe("no-blocking-findings");
    expect(result.published).toBe(true);
    expect(verificationRuns).toBe(1);
    expect(publications).toBe(1);
    expect(preparedCopyToWorktree).toEqual([]);
    expect(agentCalls).toHaveLength(2);
    expect(agentCalls.every((call) => !call.fileEditingToolsEnabled)).toBe(true);
    expect(agentCalls.every((call) => call.prompt.includes(`git diff merge123..${feedback.pr.headRefOid} --`))).toBe(true);
    expect(agentCalls[1]?.prompt).not.toContain("review-a.md");
    expect(await readFile(path.join(result.context.reviewDir, "summary.json"), "utf8")).toContain("no-blocking-findings");
    const reviewerVerification = await readFile(path.join(result.context.reviewDir, "verification.md"), "utf8");
    const fullVerification = await readFile(path.join(result.context.reviewDir, "verification-full.md"), "utf8");
    expect(reviewerVerification).toContain("(truncated");
    expect(reviewerVerification).not.toContain("diagnostic-at-start");
    expect(fullVerification).toContain("diagnostic-at-start");
    expect(fullVerification).toContain("diagnostic-at-end");
    const reviewContext = await readFile(path.join(result.context.reviewDir, "pr-context.md"), "utf8");
    expect(reviewContext).toContain("Shared contract");
    expect(reviewContext).toContain("Pinned workspace");
    expect(reviewContext).toContain("Preserve backward compatibility");
    expect(reviewContext).toContain("Human context");
    expect(reviewContext).toContain("Context incomplete");
    expect(reviewContext).not.toContain("Stale generated review");
    expect(reviewContext).not.toContain("Stale revision summary");
    expect(reviewContext).not.toContain("Unrelated external issue");
    expect(Bun.file(path.join(agent, ".roark/runs/pr/12/review-1")).exists()).resolves.toBe(false);
    expect(Bun.file(path.join(agent, ".git/roark/pr-review/12/review-1")).exists()).resolves.toBe(false);
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
      hooks: defaultLifecycleHooks,
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
      publishComment: async () => { await noopAsync(); publications++; },
    });
    expect(result.outcome).toBe("blocked");
    expect(result.stale).toBe(true);
    expect(result.decision.reasons[0]).toContain("title changed");
    expect(result.decision.reasons[0]).toContain("description changed");
    expect(publications).toBe(0);
    expect(Bun.file(path.join(result.context.reviewDir, "review-a.md")).exists()).resolves.toBe(true);
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
      hooks: defaultLifecycleHooks,
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
      publishComment: async () => { await noopAsync(); throw new Error("GitHub unavailable"); },
    });

    expect(run).rejects.toThrow("artifacts were preserved");
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
      verificationSource: "unresolved",
      comment: false,
      workspace: defaultWorkspaceConfig,
      hooks: defaultLifecycleHooks,
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
  return `# Review\n\n## Verdict\napprove\n\n## Findings Ledger\nNone\n\n## Evidence Reviewed\n- ${id}\n`;
}

async function initAgentRepo(cwd: string): Promise<void> {
  await runProcessOrThrow(["git", "init", "-b", "main"], { cwd });
}
