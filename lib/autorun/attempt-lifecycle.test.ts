import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readArtifact, refinementLogRef, reviewARef, reviewBRef, verificationBeforeFixRef, writeArtifact, type WorkflowContext } from "../workflow/artifacts.ts";
import { getWorkflowThinkingConfig } from "../workflow/thinking.ts";
import { ArtifactValidationError } from "../workflow/artifact-validation.ts";
import { AgentTaskRunError } from "../workflow/tasks.ts";
import { formatAttemptMetadata, readAttemptIndex, readAttemptMetadata } from "./attempts.ts";
import { runAutorunAttemptLifecycle } from "./attempt-lifecycle.ts";
import type { AutorunBranchPlan } from "./branch.ts";
import { runProcessOrThrow } from "../cli/process.ts";
import type { AutorunGateOptions } from "./publish-flow.ts";
import { noopAsync } from "../utils/async.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("runAutorunAttemptLifecycle", () => {
  test("marks attempts in-progress before workflow and records terminal completion outcomes", async () => {
  await noopAsync();
    const fixture = await createFixture();

    await runAutorunAttemptLifecycle({
      ...fixture,
      issue: { number: 44, title: "Lifecycle", url: "https://github.com/owner/repo/issues/44" },
    }, {
      clock: { now: () => new Date("2026-05-07T01:00:00.000Z") },
      runFullWorkflow: async () => {
        await noopAsync();
        const duringWorkflow = await readAttemptMetadata(fixture.issueDir, 1);
        expect(duringWorkflow.outcome).toBe("in-progress");
        expect(duringWorkflow.endedAt).toBeNull();
        expect((await readAttemptIndex(fixture.issueDir))[0]?.outcome).toBe("in-progress");
        return { status: "completed" };
      },
      completeAutorunWorkflow: async () => (await noopAsync(), ({
        outcome: "failed-verification",
        outcomeDetail: "verification failed",
      })),
      finalizeAttemptObservability: async () => {
        await noopAsync();},
    });

    const terminal = await readAttemptMetadata(fixture.issueDir, 1);
    expect(terminal.outcome).toBe("failed-verification");
    expect(terminal.outcomeDetail).toBe("verification failed");
    expect(terminal.endedAt).toBe("2026-05-07T01:00:00.000Z");
    expect((await readAttemptIndex(fixture.issueDir))[0]?.outcome).toBe("failed-verification");
  });

  test("runs fix, refinement, reviews, readiness, and completion again for verification repair", async () => {
        await noopAsync();
    const fixture = await createFixture();
    await writeCompletedWorkflowArtifacts(fixture.workflowContext);
    const phases: string[] = [];
    let completions = 0;

    await runAutorunAttemptLifecycle({
      ...fixture,
      issue: { number: 44, title: "Lifecycle", url: "https://github.com/owner/repo/issues/44" },
      runner: async (request) => {
        await noopAsync();
        phases.push(request.display.phaseId);
        expect(request.prompt).toContain("failed_verification");
        if (request.display.phaseId === "fixLog-1") {
          return "# Fix Log Pass 1\n\n## Summary\nAddressed verification failure.\n\n## Changed Files\n- lib/example.ts\n\n## Validation Run\n- bun test (passed)\n\n## Review Findings Addressed\n- Failed verification.\n\n## Remaining Concerns\nNone\n";
        }
        if (request.display.phaseId === "refinementLog-1") {
          return "# Refinement Log Pass 1\n\n## Summary\nRefined.\n\n## Changed Files\n- lib/example.ts\n\n## Simplifications Made\nNone\n\n## Abstractions / Names Adjusted\nNone\n\n## Behavior Risk Decisions\n- Verification repair behavior in lib/example.ts was kept unchanged except for the targeted failure.\n\n## Plan / Issue Alignment\nAligned.\n\n## Validation Run\n- bun test (passed)\n\n## Remaining Concerns\nNone\n";
        }
        if (request.display.phaseId === "reviewA-1") {
          return "# Review A Pass 1\n\n## Verdict\napprove\n";
        }
        if (request.display.phaseId === "reviewB-1") {
          return "# Review B Pass 1\n\n## Verdict\napprove\n";
        }
        throw new Error(`unexpected phase ${request.display.phaseId}`);
      },
    }, {
      clock: { now: () => new Date("2026-05-07T01:30:00.000Z") },
      runFullWorkflow: async () => (await noopAsync(), ({ status: "completed" })),
      completeAutorunWorkflow: async () => {
        completions += 1;
        if (completions === 1) {
          await writeArtifact(fixture.workflowContext, verificationBeforeFixRef(1), "# Verification\n\n## Exit Code\n1\n");
          return { outcome: "verification-needs-fix", outcomeDetail: "verify command exited 1", pass: 1 };
        }
        return { outcome: "published", outcomeDetail: null };
      },
      finalizeAttemptObservability: async () => {
        await noopAsync();},
    });

    expect(completions).toBe(2);
    expect(phases).toEqual(["fixLog-1", "refinementLog-1", "reviewA-1", "reviewB-1"]);
    expect(await readArtifact(fixture.workflowContext, "readiness")).toContain("## Status\nready-for-pr");
    const terminal = await readAttemptMetadata(fixture.issueDir, 1);
    expect(terminal.outcome).toBe("published");
  });

  test("continues verification repair when the numbered review requests another fix pass", async () => {
        await noopAsync();
    const fixture = await createFixture();
    await writeCompletedWorkflowArtifacts(fixture.workflowContext);
    const phases: string[] = [];
    let completions = 0;

    await runAutorunAttemptLifecycle({
      ...fixture,
      issue: { number: 44, title: "Lifecycle", url: "https://github.com/owner/repo/issues/44" },
      runner: async (request) => {
        await noopAsync();
        phases.push(request.display.phaseId);
        if (request.display.phaseId === "fixLog-1") {
          return "# Fix Log Pass 1\n\n## Summary\nPartially addressed verification failure.\n\n## Changed Files\n- lib/example.ts\n\n## Validation Run\n- bun test (failed)\n\n## Review Findings Addressed\n- Failed verification.\n\n## Remaining Concerns\nNumbered review requested another fix.\n";
        }
        if (request.display.phaseId === "refinementLog-1") {
          return "# Refinement Log Pass 1\n\n## Summary\nRefined.\n";
        }
        if (request.display.phaseId === "reviewA-1") {
          return "# Review A Pass 1\n\n## Verdict\nfixes-required\n";
        }
        if (request.display.phaseId === "reviewB-1") {
          return "# Review B Pass 1\n\n## Verdict\napprove\n";
        }
        if (request.display.phaseId === "fixLog-2") {
          return "# Fix Log Pass 2\n\n## Summary\nCompleted verification repair.\n\n## Changed Files\n- lib/example.ts\n\n## Validation Run\n- bun test (passed)\n\n## Review Findings Addressed\n- Failed verification.\n\n## Remaining Concerns\nNone\n";
        }
        if (request.display.phaseId === "refinementLog-2") {
          return "# Refinement Log Pass 2\n\n## Summary\nRefined.\n";
        }
        if (request.display.phaseId === "reviewA-2") {
          return "# Review A Pass 2\n\n## Verdict\napprove\n";
        }
        if (request.display.phaseId === "reviewB-2") {
          return "# Review B Pass 2\n\n## Verdict\napprove\n";
        }
        throw new Error(`unexpected phase ${request.display.phaseId}`);
      },
    }, {
      clock: { now: () => new Date("2026-05-07T01:45:00.000Z") },
      runFullWorkflow: async () => (await noopAsync(), ({ status: "completed" })),
      completeAutorunWorkflow: async () => {
        completions += 1;
        if (completions === 1) {
          await writeArtifact(fixture.workflowContext, verificationBeforeFixRef(1), "# Verification\n\n## Exit Code\n1\n");
          return { outcome: "verification-needs-fix", outcomeDetail: "verify command exited 1", pass: 1 };
        }
        return { outcome: "published", outcomeDetail: null };
      },
      finalizeAttemptObservability: async () => {
        await noopAsync();},
    });

    expect(completions).toBe(2);
    expect(phases).toEqual(["fixLog-1", "refinementLog-1", "reviewA-1", "reviewB-1", "fixLog-2", "refinementLog-2", "reviewA-2", "reviewB-2"]);
    expect(await readArtifact(fixture.workflowContext, "readiness")).toContain("## Status\nready-for-pr");
    const terminal = await readAttemptMetadata(fixture.issueDir, 1);
    expect(terminal.outcome).toBe("published");
  });

  test("classifies output-contract failures and includes failing artifact details in the failure comment", async () => {
        await noopAsync();
    const fixture = await createFixture();
    await writeArtifact(fixture.workflowContext, "implementationLog", "# Implementation Log\n\ninvalid output\n");
    const comments: string[] = [];
    const error = new AgentTaskRunError({
      artifact: "implementationLog",
      label: "Implementation",
      phase: "output-contract",
      originalError: new Error("missing Summary section"),
    });

    expect(runAutorunAttemptLifecycle({
      ...fixture,
      issue: { number: 44, title: "Lifecycle", url: "https://github.com/owner/repo/issues/44" },
    }, {
      clock: { now: () => new Date("2026-05-07T02:00:00.000Z") },
      runFullWorkflow: async () => {
        await noopAsync();
        throw error;
      },
      publishReviewLedgerComments: async () => {
        await noopAsync();},
      markIssueFailed: async (options) => {
        await noopAsync();
        comments.push(options.comment);
        expect(options.removeLabels).toEqual(["busy"]);
        return undefined;
      },
      finalizeAttemptObservability: async () => {
        await noopAsync();},
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
    expect(comment).toContain("roark continue 44 --repo owner/repo --attempt 1");
    expect(comment).not.toContain("--cwd");
    expect(comment).not.toContain(fixture.gateOptions.cwd);
  });

  test("includes direct artifact validation error artifact details in the failure comment", async () => {
        await noopAsync();
    const fixture = await createFixture();
    await writeArtifact(fixture.workflowContext, "implementationLog", "# Implementation Log\n\ninvalid direct validation output\n");
    const comments: string[] = [];
    const error = new ArtifactValidationError("implementationLog", "missing Summary section");

    expect(runAutorunAttemptLifecycle({
      ...fixture,
      issue: { number: 44, title: "Lifecycle", url: "https://github.com/owner/repo/issues/44" },
    }, {
      clock: { now: () => new Date("2026-05-07T02:30:00.000Z") },
      runFullWorkflow: async () => {
        await noopAsync();
        throw error;
      },
      publishReviewLedgerComments: async () => {
        await noopAsync();},
      markIssueFailed: async (options) => {
        await noopAsync();
        comments.push(options.comment);
        return undefined;
      },
      finalizeAttemptObservability: async () => {
        await noopAsync();},
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
        await noopAsync();
    const fixture = await createFixture();
    const calls: string[] = [];

    expect(runAutorunAttemptLifecycle({
      ...fixture,
      issue: { number: 44, title: "Lifecycle" },
      beforeRun: async () => {
        await noopAsync();
        const persisted = await readAttemptMetadata(fixture.issueDir, 1);
        expect(persisted.outcome).toBe("in-progress");
        calls.push("beforeRun");
        throw new Error("setup failed");
      },
    }, {
      clock: { now: () => new Date("2026-05-07T02:45:00.000Z") },
      runFullWorkflow: async () => {
        await noopAsync();
        calls.push("workflow");
        return { status: "completed" };
      },
      publishReviewLedgerComments: async () => {
        await noopAsync();},
      markIssueFailed: async () => (await noopAsync(), undefined),
      finalizeAttemptObservability: async () => {
        await noopAsync();},
    })).rejects.toThrow("setup failed");

    expect(calls).toEqual(["beforeRun"]);
    const terminal = await readAttemptMetadata(fixture.issueDir, 1);
    expect(terminal.outcome).toBe("errored");
    expect(terminal.outcomeDetail).toBe("setup failed");
    expect(terminal.endedAt).toBe("2026-05-07T02:45:00.000Z");
  });

  test("classifies generic failures as errored and records terminal metadata from finally", async () => {
        await noopAsync();
    const fixture = await createFixture();
    const comments: string[] = [];

    expect(runAutorunAttemptLifecycle({
      ...fixture,
      issue: { number: 44, title: "Lifecycle" },
    }, {
      clock: { now: () => new Date("2026-05-07T03:00:00.000Z") },
      runFullWorkflow: async () => {
        await noopAsync();
        throw new Error("workflow exploded");
      },
      publishReviewLedgerComments: async () => {
        await noopAsync();},
      markIssueFailed: async (options) => {
        await noopAsync();
        comments.push(options.comment);
        return undefined;
      },
      finalizeAttemptObservability: async () => {
        await noopAsync();},
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
  await writeArtifact(context, "implementationPlanDraft", "# Implementation Plan Draft\n\n## Ready For Implementation\nyes\n");
  await writeArtifact(context, "implementationPlan", "# Implementation Plan\n\n## Ready For Implementation\nyes\n");
  await writeArtifact(context, "preImplementationBaseline", JSON.stringify({ head: "abc", capturedAt: "now", excludes: [".roark"] }));
  await writeArtifact(context, "implementationLog", "# Implementation Log\n\n## Summary\nDone.\n");
  await writeArtifact(context, refinementLogRef(0), "# Refinement Log Pass 0\n\n## Summary\nRefined.\n");
  await writeArtifact(context, reviewARef(0), "# Review A Pass 0\n\n## Verdict\napprove\n");
  await writeArtifact(context, reviewBRef(0), "# Review B Pass 0\n\n## Verdict\napprove\n");
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
    thinkingConfig: getWorkflowThinkingConfig(),
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
