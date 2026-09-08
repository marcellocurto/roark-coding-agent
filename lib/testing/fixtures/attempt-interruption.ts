import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import { Effect, FileSystem } from "effect";
import path from "node:path";
import { runAutorunAttemptLifecycle } from "../../autorun/attempt-lifecycle.ts";
import { formatAttemptMetadata } from "../../autorun/attempts.ts";
import { withCheckoutLock } from "../../autorun/lock.ts";
import { runVerificationPromise } from "../../autorun/verification.ts";
import { applicationLayer } from "../../runtime/application.ts";
import { createWorkflowContext } from "../../workflow/artifacts.ts";

const cwd = process.cwd();
const context = createWorkflowContext({
  command: "do",
  issue: "1",
  cwd,
  outDir: ".roark/runs",
  force: false,
  yes: false,
  maxFixPasses: 1,
  attempt: 1,
});
const metadata = formatAttemptMetadata({
  attempt: 1,
  issueNumber: 1,
  branch: "roark/issue-1",
  baseBranch: "main",
  worktreePath: cwd,
  runArtifactPath: context.runDirRelative,
  startedAt: new Date().toISOString(),
});
const cleanup = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.writeFileString(path.join(cwd, "cleanup-started"), "started");
  while (!(yield* fs.exists(path.join(cwd, "allow-cleanup"))))
    yield* Effect.sleep(10);
  yield* fs.writeFileString(path.join(cwd, "cleanup-finished"), "finished");
});

BunRuntime.runMain(
  withCheckoutLock(
    { cwd, name: "shutdown", description: "shutdown fixture" },
    runAutorunAttemptLifecycle(
      {
        issueDir: path.join(cwd, ".roark/runs/issue/1"),
        workflowContext: context,
        branchPlan: {
          issueNumber: 1,
          branchName: "roark/issue-1",
          baseBranch: "main",
        },
        gateOptions: {
          cwd,
          repo: "owner/repo",
          verifyCommand: "true",
          failureLabel: "failed",
          successLabel: "done",
          inProgressLabel: "in-progress",
          remote: "origin",
          baseBranch: "main",
        },
        attemptMetadata: metadata,
        issue: {
          number: 1,
          title: "Interruption",
          url: "https://github.com/owner/repo/issues/1",
        },
        afterRun: () => cleanup,
      },
      {
        runFullWorkflow: async (_context, _runner, _options, application) => {
          await runVerificationPromise(
            { command: "sleep 30 & echo $! > child.pid; wait", cwd },
            application,
          );
          return { status: "completed" };
        },
      },
    ),
  ).pipe(Effect.provide(applicationLayer)),
);
