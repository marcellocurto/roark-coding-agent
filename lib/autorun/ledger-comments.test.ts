import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeArtifact, type WorkflowContext } from "../workflow/artifacts.ts";
import { getWorkflowThinkingConfig } from "../workflow/thinking.ts";
import { recordAttemptIssueComment, formatAttemptMetadata } from "./attempts.ts";

import { publishPlanningLedgerComments, publishReviewLedgerComments } from "./ledger-comments.ts";
import { noopAsync } from "../utils/async.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("autorun ledger comment publishing", () => {
  test("publishes existing triage and implementation plan artifacts through the injected ledger publisher", async () => {
    await noopAsync();
    const cwd = await mkdtemp(path.join(tmpdir(), "roark-ledger-planning-"));
    tempDirs.push(cwd);
    const workflowContext: WorkflowContext = {
      controlCwd: cwd,
      agentCwd: cwd,
      outDir: path.join(cwd, ".roark/runs"),
      runDir: path.join(cwd, ".roark/runs/issue/24/attempts/2"),
      runDirRelative: ".roark/runs/issue/24/attempts/2",
      issueInput: "24",
      issueNumber: "24",
      attempt: 2,
      force: false,
      yes: false,
      maxFixPasses: 1,
      thinkingConfig: getWorkflowThinkingConfig(),
    };
    await writeArtifact(workflowContext, "triage", "# Triage\n\n## Verdict\nproceed\n");
    await writeArtifact(workflowContext, "implementationPlan", "# Implementation Plan\n\n## Ready For Implementation\nyes\n");
    const attemptMetadata = formatAttemptMetadata({
      attempt: 2,
      issueNumber: 24,
      branch: "roark/issue-24",
      baseBranch: "main",
      worktreePath: cwd,
      runArtifactPath: workflowContext.runDirRelative,
      startedAt: "2026-05-07T00:00:00.000Z",
    });
    const phases: string[] = [];

    await publishPlanningLedgerComments({
      cwd,
      issue: { number: 24, title: "Ledger comments" },
      workflowContext,
      attemptMetadata,
      attemptMetadataPath: ".roark/runs/issue/24/attempts/2/attempt.json",
    }, {
      publishIssueLedgerComment: async (input) => {
        await noopAsync();
        phases.push(input.phase);
      },
    });

    expect(phases).toEqual(["triage", "implementation-plan"]);
  });

  test("publishes existing Review A/B artifacts through the injected ledger publisher", async () => {
        await noopAsync();
    const cwd = await mkdtemp(path.join(tmpdir(), "roark-ledger-comments-"));
    tempDirs.push(cwd);
    const workflowContext: WorkflowContext = {
      controlCwd: cwd,
      agentCwd: cwd,
      outDir: path.join(cwd, ".roark/runs"),
      runDir: path.join(cwd, ".roark/runs/issue/24/attempts/2"),
      runDirRelative: ".roark/runs/issue/24/attempts/2",
      issueInput: "24",
      issueNumber: "24",
      attempt: 2,
      force: false,
      yes: false,
      maxFixPasses: 1,
      thinkingConfig: getWorkflowThinkingConfig(),
    };
    await writeArtifact(workflowContext, "reviewA", "# Review A\n\n## Verdict\nfixes-required\n");
    await writeArtifact(workflowContext, "reviewB", "# Review B\n\n## Verdict\napprove\n");
    const attemptMetadata = formatAttemptMetadata({
      attempt: 2,
      issueNumber: 24,
      branch: "roark/issue-24",
      baseBranch: "main",
      worktreePath: cwd,
      runArtifactPath: workflowContext.runDirRelative,
      startedAt: "2026-05-07T00:00:00.000Z",
    });
    const phases: string[] = [];

    await publishReviewLedgerComments({
      cwd,
      repo: "owner/repo",
      issue: { number: 24, title: "Ledger comments" },
      workflowContext,
      attemptMetadata,
    }, {
      publishIssueLedgerComment: async (input) => {
        await noopAsync();
        phases.push(input.phase);
        recordAttemptIssueComment(input.attemptMetadata, input.phase, {
          id: input.phase === "review-a" ? 101 : 102,
          marker: `marker:${input.phase}`,
        }, "2026-05-07T00:01:00.000Z");
      },
    });

    expect(phases).toEqual(["review-a", "review-b"]);
    expect(attemptMetadata.githubComments?.issue?.["review-a"]?.id).toBe(101);
    expect(attemptMetadata.githubComments?.issue?.["review-b"]?.id).toBe(102);
  });
});
