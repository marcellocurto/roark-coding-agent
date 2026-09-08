import { runApplicationPromise } from "../runtime/application.ts";
import { Effect } from "effect";
import { applicationLayer, fromLegacyPromise } from "../runtime/application.ts";
import { describe, expect, test } from "bun:test";
import type { WorkflowContext } from "../workflow/artifacts.ts";
import { getWorkflowThinkingConfig } from "../workflow/thinking.ts";
import { completeAutorunWorkflow } from "./completion.ts";
import { formatAttemptMetadata } from "./attempts.ts";
import type { AutorunGateOptions } from "./publish-flow.ts";
const options: AutorunGateOptions = {
  cwd: "/repo",
  repo: "owner/repo",
  verifyCommand: "bun test",
  readyLabel: "ready-for-agent",
  failureLabel: "agent-failed",
  successLabel: "agent-pr-opened",
  inProgressLabel: "agent-in-progress",
  remote: "origin",
  baseBranch: "main",
};
const workflowContext: WorkflowContext = {
  controlCwd: "/repo",
  agentCwd: "/repo/.roark/worktrees/issue-12",
  outDir: "/repo/.roark/runs",
  runDir: "/repo/.roark/runs/issue/12/attempts/1",
  runDirRelative: ".roark/runs/issue/12/attempts/1",
  issueInput: "12",
  issueNumber: "12",
  attempt: 1,
  force: false,
  yes: false,
  maxFixPasses: 1,
  thinkingConfig: getWorkflowThinkingConfig(),
};
const branchPlan = {
  issueNumber: 12,
  branchName: "roark/issue-12",
  baseBranch: "main",
};
const issue = {
  number: 12,
  title: "Handle no-op",
  url: "https://github.com/owner/repo/issues/12",
  labels: [{ name: "ready-for-agent" }],
};
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
  test("marks triage-stopped and does not run the publish gate", async () => {
    await Promise.resolve();
    let publishCalls = 0;
    const marked: unknown[] = [];
    const outcome = await Effect.runPromise(
      fromLegacyPromise((application) =>
        runApplicationPromise(
          completeAutorunWorkflow(
            {
              workflowResult: {
                status: "triage-stopped",
                triageVerdict: "blocked",
              },
              options,
              issue,
              branchPlan,
              workflowContext,
              attemptMetadata,
              attemptMetadataPath:
                ".roark/runs/issue/12/attempts/1/attempt.json",
            },
            {
              publishGate: Effect.fnUntraced(function* () {
                yield* Effect.void;
                publishCalls += 1;
                return { outcome: "published" as const, outcomeDetail: null };
              }),
              markTriageStopped: Effect.fnUntraced(function* (input) {
                yield* Effect.void;
                marked.push(input);
                return undefined;
              }),
            },
          ),
          application,
        ),
      ).pipe(Effect.provide(applicationLayer)),
    );
    expect(outcome).toEqual({
      outcome: "triage-stopped",
      outcomeDetail: 'triage verdict is "blocked"',
    });
    expect(publishCalls).toBe(0);
    expect(marked).toHaveLength(1);
    expect(marked[0]).toMatchObject({
      cwd: "/repo",
      repo: "owner/repo",
      issueNumber: 12,
      issueUrl: "https://github.com/owner/repo/issues/12",
      triageVerdict: "blocked",
      removeLabels: ["ready-for-agent", "agent-in-progress", "agent-failed"],
    });
  });
  test("delegates completed workflow results to the publish gate unchanged", async () => {
    await Promise.resolve();
    let marked = false;
    const outcome = await runApplicationPromise(
      completeAutorunWorkflow(
        {
          workflowResult: { status: "completed" },
          options,
          issue,
          branchPlan,
          workflowContext,
          attemptMetadata,
          attemptMetadataPath: ".roark/runs/issue/12/attempts/1/attempt.json",
          recoveryCommand: "roark continue 12 --attempt 1",
        },
        {
          publishGate: Effect.fnUntraced(function* (input) {
            yield* Effect.void;
            expect(input.issue).toBe(issue);
            expect(input.recoveryCommand).toBe("roark continue 12 --attempt 1");
            return {
              outcome: "failed-readiness" as const,
              outcomeDetail: "readiness status is missing",
            };
          }),
          markTriageStopped: Effect.fnUntraced(function* () {
            yield* Effect.void;
            marked = true;
            return undefined;
          }),
        },
      ),
    );
    expect(outcome).toEqual({
      outcome: "failed-readiness",
      outcomeDetail: "readiness status is missing",
    });
    expect(marked).toBe(false);
  });
});
