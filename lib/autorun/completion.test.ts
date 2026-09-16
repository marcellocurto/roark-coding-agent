import { presentAutorunOutcome } from "../../roark.ts";
import { Presenter } from "../presentation/presenter.ts";
import { runWithPresenter } from "../testing/presentation.ts";
import { GitHub } from "../github/service.ts";
import { runApplicationPromise } from "../runtime/application.ts";
import { Effect } from "effect";
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
const fakeGitHub = Effect.fnUntraced(function* () {
  const github = yield* GitHub;
  const comments: { id: number; marker: string; body: string }[] = [];
  const added: string[] = [];
  const removed: string[] = [];
  return {
    comments,
    added,
    removed,
    service: {
      ...github,
      postOrUpdateIssueCommentByMarker: (
        input: Parameters<typeof github.postOrUpdateIssueCommentByMarker>[0],
      ) =>
        Effect.sync(() => {
          const id = 45 + comments.length;
          const ref = {
            id,
            marker: input.marker,
            url: `https://github.com/owner/repo/issues/12#issuecomment-${id}`,
          };
          comments.push({ ...ref, body: input.body });
          return ref;
        }),
      addIssueLabel: (input: Parameters<typeof github.addIssueLabel>[0]) =>
        Effect.sync(() => {
          added.push(input.label);
        }),
      removeIssueLabel: (
        input: Parameters<typeof github.removeIssueLabel>[0],
      ) =>
        Effect.sync(() => {
          removed.push(input.label);
        }),
    },
  };
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
      const remote = await runApplicationPromise(fakeGitHub());
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
          },
        ).pipe(Effect.provideService(GitHub, remote.service)),
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
        `https://github.com/owner/repo/issues/12#issuecomment-${scenario === "execution-question" ? 45 : 46}\n`,
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
      expect(remote.added).toEqual([
        scenario === "final-blocker" ? "blocked" : "needs-human",
      ]);
      expect(remote.removed).toEqual([
        "ready-for-agent",
        "agent-in-progress",
        "agent-failed",
      ]);
      expect(remote.comments.at(-1)?.body).toContain(
        "roark continue 12 --attempt 1",
      );
      const phases =
        scenario === "execution-question"
          ? ["attempt-status"]
          : ["implementation-plan", "attempt-status"];
      expect(Object.keys(metadata.githubComments?.issue ?? {})).toEqual(phases);
      for (const [index, phase] of phases.entries()) {
        expect(metadata.githubComments?.issue?.[phase]).toMatchObject({
          id: 45 + index,
          marker: `<!-- roark:issue=12 attempt=1 phase=${phase} -->`,
        });
        expect(remote.comments[index]?.marker).toBe(
          `<!-- roark:issue=12 attempt=1 phase=${phase} -->`,
        );
      }
    },
  );
  test("marks triage-stopped and does not run the publish gate", async () => {
    await Promise.resolve();
    let publishCalls = 0;
    const remote = await runApplicationPromise(fakeGitHub());
    const metadata = { ...attemptMetadata };
    const outcome = await runApplicationPromise(
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
            attemptMetadata: metadata,
            attemptMetadataPath: ".roark/runs/issue/12/attempts/1/attempt.json",
          },
          {
            publishGate: Effect.fnUntraced(function* () {
              yield* Effect.void;
              publishCalls += 1;
              return { outcome: "published" as const, outcomeDetail: null };
            }),
          },
        );
      }).pipe(Effect.provideService(GitHub, remote.service)),
    );
    expect(outcome).toMatchObject({
      outcome: "triage-stopped",
      outcomeDetail: 'triage verdict is "blocked"',
    });
    expect(publishCalls).toBe(0);
    expect(remote.added).toEqual(["blocked"]);
    expect(remote.removed).toEqual([
      "ready-for-agent",
      "agent-in-progress",
      "agent-failed",
    ]);
    expect(Object.keys(metadata.githubComments?.issue ?? {})).toEqual([
      "triage",
      "attempt-status",
    ]);
    for (const [index, phase] of ["triage", "attempt-status"].entries()) {
      expect(metadata.githubComments?.issue?.[phase]).toMatchObject({
        id: 45 + index,
        marker: `<!-- roark:issue=12 attempt=1 phase=${phase} -->`,
      });
      expect(remote.comments[index]?.body).toContain("blocked");
    }
  });
  test.each(["completed", "fix-budget-exhausted"] as const)(
    "delegates %s workflow results to the publish gate unchanged",
    async (status) => {
      await Promise.resolve();
      let marked = false;
      const outcome = await runApplicationPromise(
        completeAutorunWorkflow(
          {
            workflowResult: { status },
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
              expect(input.recoveryCommand).toBe(
                "roark continue 12 --attempt 1",
              );
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
    },
  );
});
