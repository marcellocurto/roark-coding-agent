import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readArtifact, verificationBeforeFixRef, writeArtifact, type WorkflowContext } from "../workflow/artifacts.ts";
import { ArtifactValidationError } from "../workflow/artifact-validation.ts";
import { AgentTaskRunError } from "../workflow/tasks.ts";
import { formatAttemptMetadata, readAttemptIndex, readAttemptMetadata } from "./attempts.ts";
import { runAutorunAttemptLifecycle } from "./attempt-lifecycle.ts";
import type { AutorunBranchPlan } from "./branch.ts";
import { runProcessOrThrow } from "../cli/process.ts";
import type { AutorunGateOptions } from "./publish-flow.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("runAutorunAttemptLifecycle", () => {
  test("marks attempts in-progress before workflow and records terminal completion outcomes", async () => {
    const fixture = await createFixture();

    await runAutorunAttemptLifecycle({
      ...fixture,
      issue: { number: 44, title: "Lifecycle", url: "https://github.com/owner/repo/issues/44" },
    }, {
      clock: { now: () => new Date("2026-05-07T01:00:00.000Z") },
      runFullWorkflow: async () => {
        const duringWorkflow = await readAttemptMetadata(fixture.issueDir, 1);
        expect(duringWorkflow.outcome).toBe("in-progress");
        expect(duringWorkflow.endedAt).toBeNull();
        expect((await readAttemptIndex(fixture.issueDir))[0]?.outcome).toBe("in-progress");
        return { status: "completed" };
      },
      completeAutorunWorkflow: async () => ({
        outcome: "failed-verification",
        outcomeDetail: "verification failed",
      }),
      finalizeAttemptObservability: async () => {},
    });

    const terminal = await readAttemptMetadata(fixture.issueDir, 1);
    expect(terminal.outcome).toBe("failed-verification");
    expect(terminal.outcomeDetail).toBe("verification failed");
    expect(terminal.endedAt).toBe("2026-05-07T01:00:00.000Z");
    expect((await readAttemptIndex(fixture.issueDir))[0]?.outcome).toBe("failed-verification");
  });

  test("runs fix, final review, readiness, and completion again for verification repair", async () => {
    const fixture = await createFixture();
    await writeCompletedWorkflowArtifacts(fixture.workflowContext);
    const phases: string[] = [];
    let completions = 0;

    await runAutorunAttemptLifecycle({
      ...fixture,
      issue: { number: 44, title: "Lifecycle", url: "https://github.com/owner/repo/issues/44" },
      runner: async (request) => {
        phases.push(request.phase ?? "unknown");
        expect(request.prompt).toContain("failed_verification");
        if (request.phase === "fixLog-1") {
          return "# Fix Log Pass 1\n\n## Summary\nAddressed verification failure.\n\n## Changed Files\n- lib/example.ts\n\n## Validation Run\n- bun test (passed)\n\n## Review Findings Addressed\n- Failed verification.\n\n## Remaining Concerns\nNone\n";
        }
        if (request.phase === "finalReview-1") {
          return "# Final Review Pass 1\n\n## Verdict\nready-for-pr\n\n## Reasoning\nVerification failure addressed.\n\n## Remaining Issues\nNone\n\n## Validation\nReviewed.\n";
        }
        throw new Error(`unexpected phase ${request.phase}`);
      },
    }, {
      clock: { now: () => new Date("2026-05-07T01:30:00.000Z") },
      runFullWorkflow: async () => ({ status: "completed" }),
      completeAutorunWorkflow: async () => {
        completions += 1;
        if (completions === 1) {
          await writeArtifact(fixture.workflowContext, verificationBeforeFixRef(1), "# Verification\n\n## Exit Code\n1\n");
          return { outcome: "verification-needs-fix", outcomeDetail: "verify command exited 1", pass: 1 };
        }
        return { outcome: "published", outcomeDetail: null };
      },
      finalizeAttemptObservability: async () => {},
    });

    expect(completions).toBe(2);
    expect(phases).toEqual(["fixLog-1", "finalReview-1"]);
    expect(await readArtifact(fixture.workflowContext, "readiness")).toContain("## Status\nready-for-pr");
    const terminal = await readAttemptMetadata(fixture.issueDir, 1);
    expect(terminal.outcome).toBe("published");
  });

  test("continues verification repair when final review requests another fix pass", async () => {
    const fixture = await createFixture();
    await writeCompletedWorkflowArtifacts(fixture.workflowContext);
    const phases: string[] = [];
    let completions = 0;

    await runAutorunAttemptLifecycle({
      ...fixture,
      issue: { number: 44, title: "Lifecycle", url: "https://github.com/owner/repo/issues/44" },
      runner: async (request) => {
        phases.push(request.phase ?? "unknown");
        if (request.phase === "fixLog-1") {
          return "# Fix Log Pass 1\n\n## Summary\nPartially addressed verification failure.\n\n## Changed Files\n- lib/example.ts\n\n## Validation Run\n- bun test (failed)\n\n## Review Findings Addressed\n- Failed verification.\n\n## Remaining Concerns\nFinal review requested another fix.\n";
        }
        if (request.phase === "finalReview-1") {
          return "# Final Review Pass 1\n\n## Verdict\nfixes-required\n\n## Reasoning\nRepair is incomplete.\n\n## Remaining Issues\n- Verification failure remains.\n\n## Validation\nReviewed.\n";
        }
        if (request.phase === "fixLog-2") {
          return "# Fix Log Pass 2\n\n## Summary\nCompleted verification repair.\n\n## Changed Files\n- lib/example.ts\n\n## Validation Run\n- bun test (passed)\n\n## Review Findings Addressed\n- Failed verification.\n\n## Remaining Concerns\nNone\n";
        }
        if (request.phase === "finalReview-2") {
          return "# Final Review Pass 2\n\n## Verdict\nready-for-pr\n\n## Reasoning\nRepair is complete.\n\n## Remaining Issues\nNone\n\n## Validation\nReviewed.\n";
        }
        throw new Error(`unexpected phase ${request.phase}`);
      },
    }, {
      clock: { now: () => new Date("2026-05-07T01:45:00.000Z") },
      runFullWorkflow: async () => ({ status: "completed" }),
      completeAutorunWorkflow: async () => {
        completions += 1;
        if (completions === 1) {
          await writeArtifact(fixture.workflowContext, verificationBeforeFixRef(1), "# Verification\n\n## Exit Code\n1\n");
          return { outcome: "verification-needs-fix", outcomeDetail: "verify command exited 1", pass: 1 };
        }
        return { outcome: "published", outcomeDetail: null };
      },
      finalizeAttemptObservability: async () => {},
    });

    expect(completions).toBe(2);
    expect(phases).toEqual(["fixLog-1", "finalReview-1", "fixLog-2", "finalReview-2"]);
    expect(await readArtifact(fixture.workflowContext, "readiness")).toContain("## Status\nready-for-pr");
    const terminal = await readAttemptMetadata(fixture.issueDir, 1);
    expect(terminal.outcome).toBe("published");
  });

  test("classifies output-contract failures and includes failing artifact details in the failure comment", async () => {
    const fixture = await createFixture();
    await writeArtifact(fixture.workflowContext, "implementationLog", "# Implementation Log\n\ninvalid output\n");
    const comments: string[] = [];
    const error = new AgentTaskRunError({
      artifact: "implementationLog",
      label: "Implementation",
      phase: "output-contract",
      originalError: new Error("missing Summary section"),
    });

    await expect(runAutorunAttemptLifecycle({
      ...fixture,
      issue: { number: 44, title: "Lifecycle", url: "https://github.com/owner/repo/issues/44" },
    }, {
      clock: { now: () => new Date("2026-05-07T02:00:00.000Z") },
      runFullWorkflow: async () => {
        throw error;
      },
      publishReviewLedgerComments: async () => {},
      markIssueFailed: async (options) => {
        comments.push(options.comment);
        expect(options.removeLabels).toEqual(["busy"]);
        return undefined;
      },
      finalizeAttemptObservability: async () => {},
    })).rejects.toThrow("Implementation failed: missing Summary section");

    const terminal = await readAttemptMetadata(fixture.issueDir, 1);
    expect(terminal.outcome).toBe("failed-output-contract");
    expect(terminal.outcomeDetail).toBe("Implementation failed: missing Summary section");
    expect(terminal.endedAt).toBe("2026-05-07T02:00:00.000Z");

    const comment = comments[0] ?? "";
    expect(comment).toContain("phase **output-contract**");
    expect(comment).toContain("Implementation failed: missing Summary section");
    expect(comment).toContain("Artifact: `.roark/runs/issue/44/attempts/1/implementation-log.md`");
    expect(comment).toContain("invalid output");
    expect(comment).toContain("Attempt: `.roark/runs/issue/44/attempts/1/attempt.json`");
    expect(comment).toContain(`roark continue 44 --cwd ${fixture.gateOptions.cwd} --repo owner/repo --attempt 1`);
  });

  test("includes direct artifact validation error artifact details in the failure comment", async () => {
    const fixture = await createFixture();
    await writeArtifact(fixture.workflowContext, "implementationLog", "# Implementation Log\n\ninvalid direct validation output\n");
    const comments: string[] = [];
    const error = new ArtifactValidationError("implementationLog", "missing Summary section");

    await expect(runAutorunAttemptLifecycle({
      ...fixture,
      issue: { number: 44, title: "Lifecycle", url: "https://github.com/owner/repo/issues/44" },
    }, {
      clock: { now: () => new Date("2026-05-07T02:30:00.000Z") },
      runFullWorkflow: async () => {
        throw error;
      },
      publishReviewLedgerComments: async () => {},
      markIssueFailed: async (options) => {
        comments.push(options.comment);
        return undefined;
      },
      finalizeAttemptObservability: async () => {},
    })).rejects.toThrow("implementationLog failed output contract: missing Summary section");

    const terminal = await readAttemptMetadata(fixture.issueDir, 1);
    expect(terminal.outcome).toBe("failed-output-contract");
    expect(terminal.outcomeDetail).toBe("implementationLog failed output contract: missing Summary section");

    const comment = comments[0] ?? "";
    expect(comment).toContain("phase **output-contract**");
    expect(comment).toContain("Artifact: `.roark/runs/issue/44/attempts/1/implementation-log.md`");
    expect(comment).toContain("invalid direct validation output");
  });

  test("runs fatal beforeRun after metadata is persisted and before workflow", async () => {
    const fixture = await createFixture();
    const calls: string[] = [];

    await expect(runAutorunAttemptLifecycle({
      ...fixture,
      issue: { number: 44, title: "Lifecycle" },
      beforeRun: async () => {
        const persisted = await readAttemptMetadata(fixture.issueDir, 1);
        expect(persisted.outcome).toBe("in-progress");
        calls.push("beforeRun");
        throw new Error("setup failed");
      },
    }, {
      clock: { now: () => new Date("2026-05-07T02:45:00.000Z") },
      runFullWorkflow: async () => {
        calls.push("workflow");
        return { status: "completed" };
      },
      publishReviewLedgerComments: async () => {},
      markIssueFailed: async () => undefined,
      finalizeAttemptObservability: async () => {},
    })).rejects.toThrow("setup failed");

    expect(calls).toEqual(["beforeRun"]);
    const terminal = await readAttemptMetadata(fixture.issueDir, 1);
    expect(terminal.outcome).toBe("errored");
    expect(terminal.outcomeDetail).toBe("setup failed");
    expect(terminal.endedAt).toBe("2026-05-07T02:45:00.000Z");
  });

  test("classifies generic failures as errored and records terminal metadata from finally", async () => {
    const fixture = await createFixture();
    const comments: string[] = [];

    await expect(runAutorunAttemptLifecycle({
      ...fixture,
      issue: { number: 44, title: "Lifecycle" },
    }, {
      clock: { now: () => new Date("2026-05-07T03:00:00.000Z") },
      runFullWorkflow: async () => {
        throw new Error("workflow exploded");
      },
      publishReviewLedgerComments: async () => {},
      markIssueFailed: async (options) => {
        comments.push(options.comment);
        return undefined;
      },
      finalizeAttemptObservability: async () => {},
    })).rejects.toThrow("workflow exploded");

    const terminal = await readAttemptMetadata(fixture.issueDir, 1);
    expect(terminal.outcome).toBe("errored");
    expect(terminal.outcomeDetail).toBe("workflow exploded");
    expect(terminal.endedAt).toBe("2026-05-07T03:00:00.000Z");
    expect(comments[0]).toContain("phase **workflow-error**");
  });
});

async function writeCompletedWorkflowArtifacts(context: WorkflowContext): Promise<void> {
  await writeArtifact(context, "issue", "# GitHub Issue #44\n\n<github_issue_relationships source=\"gh\" />\n");
  await writeArtifact(context, "triage", "# Triage\n\n## Verdict\nproceed\n");
  await writeArtifact(context, "implementationPlan", "# Implementation Plan\n\n## Ready For Implementation\nyes\n");
  await writeArtifact(context, "implementationLog", "# Implementation Log\n\n## Summary\nDone.\n");
  await writeArtifact(context, "reviewA", "# Review A\n\n## Verdict\napprove\n");
  await writeArtifact(context, "reviewB", "# Review B\n\n## Verdict\napprove\n");
}

async function createFixture(): Promise<{
  issueDir: string;
  workflowContext: WorkflowContext;
  branchPlan: AutorunBranchPlan;
  gateOptions: AutorunGateOptions;
  attemptMetadata: ReturnType<typeof formatAttemptMetadata>;
}> {
  const cwd = await mkdtemp(path.join(tmpdir(), "roark-lifecycle-"));
  tempDirs.push(cwd);
  await runProcessOrThrow(["git", "init"], { cwd });
  const issueDir = path.join(cwd, ".roark/runs/issue/44");
  const runDirRelative = ".roark/runs/issue/44/attempts/1";
  const runDir = path.join(cwd, runDirRelative);
  await mkdir(runDir, { recursive: true });

  const workflowContext: WorkflowContext = {
    controlCwd: cwd,
    agentCwd: cwd,
    outDir: path.join(cwd, ".roark/runs"),
    runDir,
    runDirRelative,
    issueInput: "44",
    issueNumber: "44",
    attempt: 1,
    repo: "owner/repo",
    force: false,
    yes: false,
    maxFixPasses: 3,
  };
  const branchPlan: AutorunBranchPlan = {
    issueNumber: 44,
    branchName: "roark/issue-44",
    baseBranch: "main",
  };
  const gateOptions: AutorunGateOptions = {
    cwd,
    repo: "owner/repo",
    verifyCommand: "bun test",
    failureLabel: "failed",
    successLabel: "opened",
    inProgressLabel: "busy",
    remote: "origin",
    baseBranch: "main",
  };
  const attemptMetadata = formatAttemptMetadata({
    attempt: 1,
    issueNumber: 44,
    branch: "roark/issue-44",
    baseBranch: "main",
    worktreePath: cwd,
    runArtifactPath: runDirRelative,
    startedAt: "2026-05-07T00:00:00.000Z",
  });

  return { issueDir, workflowContext, branchPlan, gateOptions, attemptMetadata };
}
