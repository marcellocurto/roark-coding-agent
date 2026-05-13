import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { finalReviewRef, fixLogRef, readArtifact, reviewARef, reviewBRef, writeArtifact, type WorkflowContext } from "../workflow/artifacts.ts";
import { getWorkflowThinkingConfig } from "../workflow/thinking.ts";
import { createReviewerIssuesAfterPr, planVerificationRepair, runPublishGate } from "./publish-flow.ts";
import type { VerificationResult } from "./verification.ts";
import { noopAsync } from "../utils/async.ts";

const tempDirs: string[] = [];

afterEach(async () => {
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
    await writeArtifact(context, fixLogRef(1), "# Fix Log Pass 1\n\n## Summary\nDone.\n");
    await writeArtifact(context, finalReviewRef(1), "# Final Review Pass 1\n\n## Verdict\nready-for-pr\n");

    expect(await planVerificationRepair(context, failedVerification(1))).toEqual({ pass: 2 });
    expect(await readArtifact(context, { name: "verificationBeforeFix", pass: 2 })).toContain("## Exit Code\n1");
  });

  test("does not schedule repair when fix budget is exhausted", async () => {
    const context = await tempContext(1);
    await writeArtifact(context, fixLogRef(1), "# Fix Log Pass 1\n\n## Summary\nDone.\n");
    await writeArtifact(context, finalReviewRef(1), "# Final Review Pass 1\n\n## Verdict\nready-for-pr\n");

    expect(await planVerificationRepair(context, failedVerification(1))).toBeUndefined();
  });

  test("does not consume fix budget for command-unavailable verification failures", async () => {
    const context = await tempContext(1);

    expect(await planVerificationRepair(context, failedVerification(127, "sh: missing: command not found"))).toBeUndefined();
  });

  test("successful PR publication triggers post-PR reviewer issue creation", async () => {
    const context = await tempContext(1);
    await writeArtifact(context, "readiness", "# PR Readiness\n\n## Status\nready-for-pr\n");
    const postPrCalls: string[] = [];
    const prBodyUpdates: string[] = [];

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
      runVerification: async ({ command }) => (await noopAsync(), ({ ok: true, command, exitCode: 0, stdout: "ok", stderr: "" })),
      writeVerificationArtifact: async () => { await noopAsync(); },
      publishAutorunResult: async () => (await noopAsync(), "https://github.com/owner/repo/pull/10"),
      publishIssueLedgerComment: async () => { await noopAsync(); return undefined; },
      postPrIssueCreation: async ({ prUrl }) => { await noopAsync(); postPrCalls.push(prUrl); return undefined; },
      updatePrBody: async ({ body }) => { await noopAsync(); prBodyUpdates.push(body); },
    });

    expect(outcome).toEqual({ outcome: "published", outcomeDetail: null });
    expect(postPrCalls).toEqual(["https://github.com/owner/repo/pull/10"]);
    expect(prBodyUpdates).toHaveLength(1);
    expect(prBodyUpdates[0]).toContain("## Before / After");
  });

  test("failed readiness does not trigger post-PR reviewer issue creation", async () => {
    const context = await tempContext(1);
    await writeArtifact(context, "readiness", "# PR Readiness\n\n## Status\nnot-ready\n");
    let postPrCalled = false;

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
    });

    expect(outcome.outcome).toBe("failed-readiness");
    expect(postPrCalled).toBe(false);
  });

  test("failed verification does not trigger post-PR reviewer issue creation", async () => {
    const context = await tempContext(0);
    await writeArtifact(context, "readiness", "# PR Readiness\n\n## Status\nready-for-pr\n");
    let postPrCalled = false;

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
    });

    expect(outcome.outcome).toBe("failed-verification");
    expect(postPrCalled).toBe(false);
  });

  test("post-PR reviewer issue creation curates numbered autorun review artifacts", async () => {
    const context = await tempContext(1);
    await writeArtifact(context, "issue", `<github_issue number="1">\n  <title>Issue</title>\n  <url>https://github.com/owner/repo/issues/1</url>\n</github_issue>`);
    await writeArtifact(context, reviewARef(0), reviewWithLedger(finding("N1", "follow-up")));
    await writeArtifact(context, reviewBRef(0), reviewWithLedger("None"));
    await writeArtifact(context, "issueCreationResults", JSON.stringify({
      created: [{ planItemId: "follow-up-1", kind: "follow-up", title: "Document numbered review curation", url: "https://github.com/owner/repo/issues/100" }],
    }));

    await createReviewerIssuesAfterPr({ workflowContext: context, prUrl: "https://github.com/owner/repo/pull/10" });

    const plan = JSON.parse(await readArtifact(context, "issueCurationPlan")) as { run: { prUrl?: string; artifactPaths: string[] }; issuesToCreate: { planItemId: string; sourceFindingIds: string[]; runContext: { prUrl?: string } }[] };
    expect(plan.run.prUrl).toBe("https://github.com/owner/repo/pull/10");
    expect(plan.issuesToCreate).toHaveLength(1);
    expect(plan.issuesToCreate[0]?.planItemId).toBe("follow-up-1");
    expect(plan.issuesToCreate[0]?.sourceFindingIds).toEqual(["review-a:N1"]);
    expect(plan.issuesToCreate[0]?.runContext.prUrl).toBe("https://github.com/owner/repo/pull/10");
    expect(plan.run.artifactPaths).toContain(".roark/runs/issue/1/attempts/1/review-a-0.md");
  });

  test("terminal command-unavailable failures include setup guidance", async () => {
  await noopAsync();
    const context = await tempContext(1);
    await writeArtifact(context, "readiness", "# PR Readiness\n\n## Status\nready-for-pr\n");
    let failureComment = "";

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

function reviewWithLedger(entries: string): string {
  return `# Review A Pass 0\n\n## Verdict\napprove\n\n## Findings Ledger\n${entries}\n\n## Validation Reviewed\nTests.\n`;
}

function finding(id: string, classification: string): string {
  return `- Identifier: ${id}
- Classification: ${classification}
- Title: Document numbered review curation
- Severity: low
- Confidence: high
- Evidence: lib/workflow/issue-curation.ts:116 selects the latest numbered review artifact.
- Current-issue impact: Reviewer findings from normal autorun attempts are promoted after PR publication.
- Recommended handling: Use numbered review artifacts when curating reviewer-generated issues.
- Suggested issue title (optional): Document numbered review curation
`;
}
