import { describe, expect, test } from "bun:test";
import type { WorkflowContext } from "../workflow/artifacts.ts";
import { completeAutorunWorkflow } from "./completion.ts";
import { formatAttemptMetadata } from "./attempts.ts";
import type { AutorunGateOptions } from "./publish-flow.ts";

const options: AutorunGateOptions = {
  cwd: "/repo",
  repo: "owner/repo",
  verifyCommand: "bun test",
  failureLabel: "roark-failed",
  successLabel: "roark-pr-opened",
  inProgressLabel: "roark-in-progress",
  remote: "origin",
  baseBranch: "main",
};

const workflowContext: WorkflowContext = {
  cwd: "/repo",
  outDir: "/repo/.roark/runs",
  runDir: "/repo/.roark/runs/issue/12/attempts/1",
  runDirRelative: ".roark/runs/issue/12/attempts/1",
  issueInput: "12",
  issueNumber: "12",
  attempt: 1,
  force: false,
  yes: false,
  maxFixPasses: 1,
};

const branchPlan = { issueNumber: 12, branchName: "roark/issue-12", baseBranch: "main" };
const issue = { number: 12, title: "Handle no-op" };
const attemptMetadata = formatAttemptMetadata({
  attempt: 1,
  issueNumber: 12,
  branch: "roark/issue-12",
  baseBranch: "main",
  worktreePath: "/repo",
  runArtifactPath: ".roark/runs/issue/12/attempts/1",
  startedAt: "2026-05-06T00:00:00.000Z",
});

describe("completeAutorunWorkflow", () => {
  test("marks triage no-op and does not run the publish gate", async () => {
    let publishCalls = 0;
    const marked: unknown[] = [];

    const outcome = await completeAutorunWorkflow({
      workflowResult: { status: "stopped", phase: "triage", verdict: "blocked" },
      options,
      issue,
      branchPlan,
      workflowContext,
      attemptMetadata,
      attemptMetadataPath: ".roark/runs/issue/12/attempts/1/attempt.json",
    }, {
      publishGate: async () => {
        publishCalls += 1;
        return { outcome: "published", outcomeDetail: null };
      },
      markTriageNoop: async (input) => {
        marked.push(input);
      },
    });

    expect(outcome).toEqual({ outcome: "noop-triage", outcomeDetail: 'triage verdict is "blocked"' });
    expect(publishCalls).toBe(0);
    expect(marked).toHaveLength(1);
    expect(marked[0]).toMatchObject({
      cwd: "/repo",
      repo: "owner/repo",
      verdict: "blocked",
      inProgressLabel: "roark-in-progress",
      failureLabel: "roark-failed",
      triageArtifactPath: ".roark/runs/issue/12/attempts/1/triage.md",
      attemptMetadataPath: ".roark/runs/issue/12/attempts/1/attempt.json",
    });
  });

  test("delegates completed workflow results to the publish gate unchanged", async () => {
    let marked = false;

    const outcome = await completeAutorunWorkflow({
      workflowResult: { status: "completed" },
      options,
      issue,
      branchPlan,
      workflowContext,
      attemptMetadata,
      attemptMetadataPath: ".roark/runs/issue/12/attempts/1/attempt.json",
      recoveryCommand: "bun run roark-coding-agent.ts continue 12 --attempt 1",
    }, {
      publishGate: async (input) => {
        expect(input.issue).toBe(issue);
        expect(input.recoveryCommand).toBe("bun run roark-coding-agent.ts continue 12 --attempt 1");
        return { outcome: "failed-readiness", outcomeDetail: "readiness status is missing" };
      },
      markTriageNoop: async () => {
        marked = true;
      },
    });

    expect(outcome).toEqual({ outcome: "failed-readiness", outcomeDetail: "readiness status is missing" });
    expect(marked).toBe(false);
  });
});
