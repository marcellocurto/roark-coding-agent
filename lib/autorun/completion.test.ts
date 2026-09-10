import { presentAutorunOutcome } from "../../roark.ts";
import { Presenter } from "../presentation/presenter.ts";
import { runWithPresenter } from "../testing/presentation.ts";
import type { MarkIssueWorkflowStoppedOptions } from "./workflow-stop.ts";
import { runApplicationPromise } from "../runtime/application.ts";
import { Effect } from "effect";
import { applicationLayer } from "../runtime/application.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeJsonArtifact } from "../workflow/artifacts.ts";
import { implementationPlanResult } from "../testing/workflow-results.ts";
import { changeReport } from "../testing/change-reports.ts";
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
  const directories: string[] = [];
  afterEach(async () => {
    for (const directory of directories.splice(0))
      await rm(directory, { recursive: true, force: true });
  });
  test.each(["draft-question", "final-blocker", "execution-question"] as const)(
    "publishes actionable %s stops without invoking the publish gate",
    async (scenario) => {
      const runDir = await mkdtemp(
        path.join(tmpdir(), "roark-completion-stop-"),
      );
      directories.push(runDir);
      const context = { ...workflowContext, runDir };
      const questions = ["Should existing customer data be retained?"];
      const artifact =
        scenario === "draft-question"
          ? "implementationPlanDraft"
          : scenario === "final-blocker"
            ? "implementationPlan"
            : "implementationLog";
      await runApplicationPromise(
        writeJsonArtifact(
          context,
          artifact,
          scenario === "execution-question"
            ? changeReport({ blockingQuestions: questions })
            : implementationPlanResult(
                false,
                scenario === "final-blocker"
                  ? {
                      blockingQuestions: [],
                      externalBlockers: [
                        "Issue #5 is open; verified dependency must ship first.",
                      ],
                    }
                  : { blockingQuestions: questions },
              ),
        ),
      );
      let publishCalls = 0;
      const marked: MarkIssueWorkflowStoppedOptions[] = [];
      const metadata = { ...attemptMetadata };
      const outcome = await runApplicationPromise(
        completeAutorunWorkflow(
          {
            workflowResult:
              scenario === "execution-question"
                ? { status: "execution-stopped", artifact: "implementationLog" }
                : {
                    status: "planning-stopped",
                    planningArtifact:
                      scenario === "draft-question"
                        ? "implementationPlanDraft"
                        : "implementationPlan",
                  },
            options,
            issue,
            branchPlan,
            workflowContext: context,
            attemptMetadata: metadata,
            attemptMetadataPath: "attempt.json",
            recoveryCommand: "roark continue 12 --attempt 1",
          },
          {
            publishGate: Effect.fnUntraced(function* () {
              publishCalls++;
              yield* Effect.void;
              return { outcome: "published" as const, outcomeDetail: null };
            }),
            markWorkflowStopped: Effect.fnUntraced(function* (input) {
              marked.push(input);
              yield* Effect.void;
              return {
                id: 45,
                url: "https://github.com/owner/repo/issues/12#issuecomment-45",
                marker: input.marker ?? "",
              };
            }),
          },
        ),
      );
      if (outcome.outcome === "verification-needs-fix")
        throw new Error("Stop scheduled repair");
      let output = "";
      await runWithPresenter(
        new Presenter({
          stream: {
            isTTY: true,
            columns: 40,
            write(chunk) {
              output += chunk;
            },
          },
          env: { TERM: "xterm" },
          titleEnabled: false,
        }),
        presentAutorunOutcome({ issueNumber: 12, ...outcome }),
      );
      expect(output).toContain(
        "https://github.com/owner/repo/issues/12#issuecomment-45\n",
      );
      expect(output).toContain(
        scenario === "final-blocker"
          ? "Issue #5 is open; verified dependency must ship first."
          : "Should existing customer data be retained?",
      );
      expect(output).toContain(context.runDirRelative);
      expect(publishCalls).toBe(0);
      expect(outcome.outcome).toBe(
        scenario === "execution-question"
          ? "execution-stopped"
          : "planning-stopped",
      );
      expect(marked).toHaveLength(1);
      expect(marked[0]).toMatchObject({
        verdict:
          scenario === "final-blocker" ? "blocked" : "needs-human-decision",
        recoveryCommand: "roark continue 12 --attempt 1",
      });
      expect(Object.values(metadata.githubComments?.issue ?? {})).toHaveLength(
        1,
      );
    },
  );
  test("marks triage-stopped and does not run the publish gate", async () => {
    await Promise.resolve();
    let publishCalls = 0;
    const marked: MarkIssueWorkflowStoppedOptions[] = [];
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* completeAutorunWorkflow(
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
            attemptMetadataPath: ".roark/runs/issue/12/attempts/1/attempt.json",
          },
          {
            publishGate: Effect.fnUntraced(function* () {
              yield* Effect.void;
              publishCalls += 1;
              return { outcome: "published" as const, outcomeDetail: null };
            }),
            markWorkflowStopped: Effect.fnUntraced(function* (input) {
              yield* Effect.void;
              marked.push(input);
              return undefined;
            }),
          },
        );
      }).pipe(Effect.provide(applicationLayer)),
    );
    expect(outcome).toMatchObject({
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
      verdict: "blocked",
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
              report: {
                published: false,
                issueUrl: issue.url,
                commentUrl: undefined,
                reason: "readiness status is missing",
                artifactPath: `${workflowContext.runDirRelative}/readiness.json`,
                runDirectory: workflowContext.runDirRelative,
              },
            };
          }),
          markWorkflowStopped: Effect.fnUntraced(function* () {
            yield* Effect.void;
            marked = true;
            return undefined;
          }),
        },
      ),
    );
    expect(outcome).toMatchObject({
      outcome: "failed-readiness",
      outcomeDetail: "readiness status is missing",
    });
    expect(marked).toBe(false);
  });
});
