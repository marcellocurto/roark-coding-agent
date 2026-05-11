import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { finalReviewRef, fixLogRef, readArtifact, writeArtifact, type WorkflowContext } from "../workflow/artifacts.ts";
import { getWorkflowThinkingConfig } from "../workflow/thinking.ts";
import { planVerificationRepair, runPublishGate } from "./publish-flow.ts";
import type { VerificationResult } from "./verification.ts";

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

  test("terminal command-unavailable failures include setup guidance", async () => {
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
      updateIssueBranchFromBase: async () => {},
      refreshCopyToWorktree: async () => {},
      runLifecycleHook: async () => {},
      runVerification: async ({ command }) => ({
        ok: false,
        command,
        exitCode: 127,
        stdout: "",
        stderr: "/bin/bash: tsc: command not found",
      }),
      handleNonPublish: async ({ decision }) => {
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
