import * as nativePhases from "../workflow/phases.ts";
import { AttemptStore } from "./attempts.ts";
import { rejects as assertRejects } from "node:assert/strict";
import { WorkspaceError } from "./workspace.ts";
import { GitWorkspaceError } from "../workflow/git.ts";
import { Effect } from "effect";
import {
  runApplicationPromise,
  type ApplicationExecution,
} from "../runtime/application.ts";
import { runWithPresenter } from "../testing/presentation.ts";
import { Presenter } from "../presentation/presenter.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type AutoCliOptions } from "../cli/args.ts";
import { defaultAutorunBaseBranch } from "./branch.ts";
import { defaultAutorunFailureLabel } from "./failure.ts";
import { defaultAutorunRemote, defaultAutorunSuccessLabel } from "./publish.ts";
import {
  defaultAutorunInProgressLabel,
  defaultAutorunReadyLabel,
  defaultAutorunSkipLabels,
} from "./selection.ts";
import { defaultAutorunVerifyCommand } from "./verification.ts";
import { runAutoDiscovery } from "./discovery.ts";
const tempDirs: string[] = [];
const noOpLabelContract = {
  ensureAutorunLabelContract: Effect.fnUntraced(function* () {
    return (yield* Effect.void, { existing: [], missing: [], created: [] });
  }),
};
afterEach(async () => {
  for (const dir of tempDirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});
describe("runAutoDiscovery", () => {
  test("discovery auto still lists and selects eligible issues", async () => {
    let listed = false;
    const logs = await captureLogs(async (application) => {
      await Promise.resolve();
      await runApplicationPromise(
        runAutoDiscovery(
          { ...baseOptions(), dryRun: true },
          {
            ...noOpLabelContract,
            listOpenGitHubIssues: Effect.fnUntraced(function* (input) {
              yield* Effect.void;
              listed = true;
              expect(input.limit).toBe(100);
              return [
                issue(1, "2026-01-03T00:00:00Z", [defaultAutorunReadyLabel]),
                issue(2, "2026-01-01T00:00:00Z", ["enhancement"]),
                issue(3, "2026-01-02T00:00:00Z", [defaultAutorunReadyLabel]),
                issue(4, "2026-01-01T00:00:00Z", [
                  defaultAutorunReadyLabel,
                  "agent-in-progress",
                ]),
              ];
            }),
            fetchGitHubIssueRelationships: Effect.fnUntraced(function* (input) {
              return (
                yield* Effect.void,
                dependencyClearRelationships(Number(input.issueNumber))
              );
            }),
          },
        ),
        application,
      );
    });
    expect(listed).toBe(true);
    expect(logs.join("\n")).toContain("#3 Issue 3");
    expect(logs.join("\n")).not.toContain("#1 Issue 1");
  });
  test("retains a discovered dry-run target in the presenter identity", async () => {
    let output = "";
    const presentation = new Presenter({
      stream: {
        isTTY: false,
        columns: 80,
        write(chunk) {
          output += chunk;
        },
      },
      now: () => 100,
    });
    return runWithPresenter(presentation, async (application) => {
      presentation.run({ command: "auto", repository: "owner/repo" });
      const result = await runApplicationPromise(
        runAutoDiscovery(
          { ...baseOptions(), dryRun: true },
          {
            ...noOpLabelContract,
            listOpenGitHubIssues: Effect.fnUntraced(function* () {
              return (
                yield* Effect.void,
                [issue(29, "2026-01-01T00:00:00Z", [defaultAutorunReadyLabel])]
              );
            }),
            fetchGitHubIssueRelationships: Effect.fnUntraced(function* () {
              return (yield* Effect.void, dependencyClearRelationships(29));
            }),
          },
        ),
        application,
      );
      presentation.outcome(
        "SUCCESS",
        presentation.currentTarget(),
        "dry run complete",
      );
      expect(result.kind).toBe("dry-run");
      expect(presentation.currentTarget()).toBe("#29");
      expect(output).toContain("DONE #29 · Discovery");
      expect(output).toContain("SUCCESS #29 · dry run complete");
    });
  });
  test("sanitizes hostile issue metadata in ordinary discovery output", async () => {
    const logs = await captureLogs(async (application) => {
      await runApplicationPromise(
        runAutoDiscovery(
          { ...baseOptions(), dryRun: true },
          {
            ...noOpLabelContract,
            listOpenGitHubIssues: Effect.fnUntraced(function* () {
              return (
                yield* Effect.void,
                [
                  {
                    ...issue(1, "2026-01-01T00:00:00Z", [
                      defaultAutorunReadyLabel,
                    ]),
                    title: "hostile\u001b]0;owned\u0007\rrewritten",
                    url: "https://example.invalid/one\nINJECTED",
                  },
                ]
              );
            }),
            fetchGitHubIssueRelationships: Effect.fnUntraced(function* () {
              return (yield* Effect.void, dependencyClearRelationships(1));
            }),
          },
        ),
        application,
      );
    });
    const output = logs.join("\n");
    expect(output).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
    expect(output).toContain("hostile ]0;owned rewritten");
    expect(output).toContain("INJECTED");
  });
  test("discovery auto skips active body-declared blockers and selects the next eligible issue", async () => {
    await Promise.resolve();
    const checkedBodies: string[] = [];
    const logs = await captureLogs(async (application) => {
      await Promise.resolve();
      await runApplicationPromise(
        runAutoDiscovery(
          { ...baseOptions(), dryRun: true },
          {
            ...noOpLabelContract,
            listOpenGitHubIssues: Effect.fnUntraced(function* () {
              return (
                yield* Effect.void,
                [
                  {
                    ...issue(1, "2026-01-01T00:00:00Z", [
                      defaultAutorunReadyLabel,
                    ]),
                    body: "Depends on #99",
                  },
                  issue(2, "2026-01-02T00:00:00Z", [defaultAutorunReadyLabel]),
                ]
              );
            }),
            fetchGitHubIssueRelationships: Effect.fnUntraced(function* (input) {
              yield* Effect.void;
              checkedBodies.push(input.body);
              return Number(input.issueNumber) === 1
                ? dependencyClearRelationships(
                    1,
                    [],
                    [bodyBlocker(99, "Body blocker", "OPEN")],
                  )
                : dependencyClearRelationships(Number(input.issueNumber));
            }),
          },
        ),
        application,
      );
    });
    const logText = logs.join("\n");
    expect(checkedBodies).toEqual(["Depends on #99", ""]);
    expect(logText).toContain("Skipped issue(s) with active blockers:");
    expect(logText).toContain("blocked by #99 Body blocker [OPEN]");
    expect(logText).toContain("Selected issue(s):\n- #2 Issue 2");
  });
  test("discovery auto keeps issues whose body-declared blockers are closed eligible", async () => {
    const logs = await captureLogs(async (application) => {
      await Promise.resolve();
      await runApplicationPromise(
        runAutoDiscovery(
          { ...baseOptions(), dryRun: true },
          {
            ...noOpLabelContract,
            listOpenGitHubIssues: Effect.fnUntraced(function* () {
              return (
                yield* Effect.void,
                [
                  {
                    ...issue(1, "2026-01-01T00:00:00Z", [
                      defaultAutorunReadyLabel,
                    ]),
                    body: "Blocked by #99",
                  },
                ]
              );
            }),
            fetchGitHubIssueRelationships: Effect.fnUntraced(function* () {
              return (
                yield* Effect.void,
                dependencyClearRelationships(
                  1,
                  [],
                  [bodyBlocker(99, "Closed body blocker", "CLOSED")],
                )
              );
            }),
          },
        ),
        application,
      );
    });
    const logText = logs.join("\n");
    expect(logText).not.toContain("Skipped issue(s) with active blockers:");
    expect(logText).toContain("Selected issue(s):\n- #1 Issue 1");
  });
  test("discovery auto skips active native-blocked issues and selects the next eligible issue", async () => {
    await Promise.resolve();
    const checked: number[] = [];
    const logs = await captureLogs(async (application) => {
      await Promise.resolve();
      await runApplicationPromise(
        runAutoDiscovery(
          { ...baseOptions(), dryRun: true },
          {
            ...noOpLabelContract,
            listOpenGitHubIssues: Effect.fnUntraced(function* () {
              return (
                yield* Effect.void,
                [
                  issue(1, "2026-01-01T00:00:00Z", [defaultAutorunReadyLabel]),
                  issue(2, "2026-01-02T00:00:00Z", [defaultAutorunReadyLabel]),
                ]
              );
            }),
            fetchGitHubIssueRelationships: Effect.fnUntraced(function* (input) {
              yield* Effect.void;
              const issueNumber = Number(input.issueNumber);
              checked.push(issueNumber);
              return issueNumber === 1
                ? dependencyClearRelationships(issueNumber, [
                    dependency(99, "Blocker", "OPEN"),
                  ])
                : dependencyClearRelationships(issueNumber);
            }),
          },
        ),
        application,
      );
    });
    const logText = logs.join("\n");
    expect(checked).toEqual([1, 2]);
    expect(logText).toContain("Skipped issue(s) with active blockers:");
    expect(logText).toContain("- #1 Issue 1");
    expect(logText).toContain("blocked by #99 Blocker [OPEN]");
    expect(logText).toContain("Selected issue(s):\n- #2 Issue 2");
  });
  test("discovery auto keeps issues whose native blockers are all closed eligible", async () => {
    await Promise.resolve();
    const checked: number[] = [];
    const logs = await captureLogs(async (application) => {
      await Promise.resolve();
      await runApplicationPromise(
        runAutoDiscovery(
          { ...baseOptions(), dryRun: true },
          {
            ...noOpLabelContract,
            listOpenGitHubIssues: Effect.fnUntraced(function* () {
              return (
                yield* Effect.void,
                [
                  issue(1, "2026-01-01T00:00:00Z", [defaultAutorunReadyLabel]),
                  issue(2, "2026-01-02T00:00:00Z", [defaultAutorunReadyLabel]),
                ]
              );
            }),
            fetchGitHubIssueRelationships: Effect.fnUntraced(function* (input) {
              yield* Effect.void;
              const issueNumber = Number(input.issueNumber);
              checked.push(issueNumber);
              return issueNumber === 1
                ? dependencyClearRelationships(issueNumber, [
                    dependency(99, "Closed blocker", "CLOSED"),
                  ])
                : dependencyClearRelationships(issueNumber);
            }),
          },
        ),
        application,
      );
    });
    const logText = logs.join("\n");
    expect(checked).toEqual([1]);
    expect(logText).not.toContain("Skipped issue(s) with active blockers:");
    expect(logText).toContain("Selected issue(s):\n- #1 Issue 1");
  });
  test("discovery auto selection limit counts unblocked issues", async () => {
    await Promise.resolve();
    const checked: number[] = [];
    const logs = await captureLogs(async (application) => {
      await Promise.resolve();
      await runApplicationPromise(
        runAutoDiscovery(
          { ...baseOptions(), dryRun: true, limit: 2 },
          {
            ...noOpLabelContract,
            listOpenGitHubIssues: Effect.fnUntraced(function* () {
              return (
                yield* Effect.void,
                [
                  issue(1, "2026-01-01T00:00:00Z", [defaultAutorunReadyLabel]),
                  issue(2, "2026-01-02T00:00:00Z", [defaultAutorunReadyLabel]),
                  issue(3, "2026-01-03T00:00:00Z", [defaultAutorunReadyLabel]),
                ]
              );
            }),
            fetchGitHubIssueRelationships: Effect.fnUntraced(function* (input) {
              yield* Effect.void;
              const issueNumber = Number(input.issueNumber);
              checked.push(issueNumber);
              return issueNumber === 1
                ? dependencyClearRelationships(issueNumber, [
                    dependency(99, "Blocker", "OPEN"),
                  ])
                : dependencyClearRelationships(issueNumber);
            }),
          },
        ),
        application,
      );
    });
    const logText = logs.join("\n");
    expect(checked).toEqual([1, 2, 3]);
    expect(logText).toContain("Selected issue(s):");
    expect(logText).toContain("- #2 Issue 2");
    expect(logText).toContain("- #3 Issue 3");
  });
  test("discovery auto fails closed when native dependency data is unavailable", async () => {
    await Promise.resolve();
    let preflighted = false;
    let claimed = false;
    await assertRejects(
      runApplicationPromise(
        runAutoDiscovery(
          { ...baseOptions() },
          {
            ...noOpLabelContract,
            listOpenGitHubIssues: Effect.fnUntraced(function* () {
              return (
                yield* Effect.void,
                [issue(1, "2026-01-01T00:00:00Z", [defaultAutorunReadyLabel])]
              );
            }),
            fetchGitHubIssueRelationships: Effect.fnUntraced(function* () {
              return (
                yield* Effect.void,
                {
                  fetchedAt: "2026-05-07T00:00:00.000Z",
                  repo: "owner/repo",
                  nativeDependenciesAvailable: false,
                  blockedBy: [],
                  blocking: [],
                  bodyDeclaredBlockers: [],
                  unavailableReason: "GitHub dependency API unavailable",
                }
              );
            }),
            assertCleanAutorunGit: Effect.fnUntraced(function* () {
              yield* Effect.void;
              preflighted = true;
              return undefined;
            }),
            claimGitHubIssue: Effect.fnUntraced(function* () {
              yield* Effect.void;
              claimed = true;
              return undefined;
            }),
          },
        ),
      ),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes(
          "Could not verify native GitHub dependencies for issue #1: GitHub dependency API unavailable",
        ),
    );
    expect(preflighted).toBe(false);
    expect(claimed).toBe(false);
  });
  test("targeted auto ensures labels before fetching the requested issue", async () => {
    await Promise.resolve();
    const calls: string[] = [];
    await runApplicationPromise(
      runAutoDiscovery(
        { ...baseOptions(), issue: "owner/repo#29", dryRun: true },
        {
          ...noOpLabelContract,
          ensureAutorunLabelContract: Effect.fnUntraced(function* () {
            yield* Effect.void;
            calls.push("ensure-labels");
            return { existing: [], missing: [], created: [] };
          }),
          listOpenGitHubIssues: Effect.fnUntraced(function* () {
            yield* Effect.void;
            return yield* Effect.die(
              new Error("targeted auto should not list issues"),
            );
          }),
          fetchGitHubIssue: Effect.fnUntraced(function* (input) {
            yield* Effect.void;
            calls.push(`fetch:${input}`);
            return fetchedGitHubIssue(29, []);
          }),
        },
      ),
    );
    expect(calls).toEqual(["ensure-labels", "fetch:owner/repo#29"]);
  });
  test("targeted auto refuses skip labels before claim", async () => {
    await Promise.resolve();
    let claimed = false;
    let preflighted = false;
    await assertRejects(
      runApplicationPromise(
        runAutoDiscovery(
          { ...baseOptions(), issue: "29" },
          {
            ...noOpLabelContract,
            fetchGitHubIssue: Effect.fnUntraced(function* () {
              return (
                yield* Effect.void,
                fetchedGitHubIssue(29, ["agent-in-progress"])
              );
            }),
            assertCleanAutorunGit: Effect.fnUntraced(function* () {
              yield* Effect.void;
              preflighted = true;
              return undefined;
            }),
            claimGitHubIssue: Effect.fnUntraced(function* () {
              yield* Effect.void;
              claimed = true;
              return undefined;
            }),
          },
        ),
      ),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes("Issue #29 has skip label agent-in-progress"),
    );
    expect(preflighted).toBe(false);
    expect(claimed).toBe(false);
  });
  test("dirty autorun preflight runs before claim", async () => {
    await Promise.resolve();
    const order: string[] = [];
    await assertRejects(
      runApplicationPromise(
        runAutoDiscovery(
          { ...baseOptions(), issue: "29" },
          {
            ...noOpLabelContract,
            fetchGitHubIssue: Effect.fnUntraced(function* () {
              return (
                yield* Effect.void, fetchedGitHubIssue(29, ["ready-for-agent"])
              );
            }),
            assertCleanAutorunGit: Effect.fnUntraced(function* () {
              yield* Effect.void;
              order.push("preflight");
              return yield* Effect.fail(
                new GitWorkspaceError({ message: "dirty worktree" }),
              );
            }),
            claimGitHubIssue: Effect.fnUntraced(function* () {
              yield* Effect.void;
              order.push("claim");
              return undefined;
            }),
          },
        ),
      ),
      (error: unknown) =>
        error instanceof Error && error.message.includes("dirty worktree"),
    );
    expect(order).toEqual(["preflight"]);
  });
  test("targeted auto rechecks labels after workspace setup and skips before claim without beforeRun", async () => {
    await Promise.resolve();
    const cwd = await mkdtemp(
      path.join(tmpdir(), "roark-targeted-auto-recheck-"),
    );
    tempDirs.push(cwd);
    const workspacePath = path.join(cwd, "managed-workspace");
    const calls: string[] = [];
    let fetchCount = 0;
    await runApplicationPromise(
      runAutoDiscovery(
        {
          ...baseOptions(cwd),
          issue: "29",
          noAssign: true,
          hooks: {
            timeoutMs: 1000,
            beforeRun: "printf should-not-run > before-run.txt",
          },
        },
        {
          ...noOpLabelContract,
          fetchGitHubIssue: Effect.fnUntraced(function* () {
            yield* Effect.void;
            fetchCount += 1;
            return fetchCount === 1
              ? fetchedGitHubIssue(29, [])
              : fetchedGitHubIssue(29, ["agent-in-progress"]);
          }),
          assertCleanAutorunGit: Effect.fnUntraced(function* () {
            yield* Effect.void;
            calls.push("preflight");
            return undefined;
          }),
          prepareCloneWorkspace: Effect.fnUntraced(function* () {
            yield* Effect.void;
            calls.push("workspace");
            return {
              path: workspacePath,
              metadata: {
                path: workspacePath,
                strategy: "clone" as const,
                cloneRemote: "origin",
                createdNow: true,
              },
            };
          }),
          claimGitHubIssue: Effect.fnUntraced(function* () {
            yield* Effect.void;
            calls.push("claim");
            return undefined;
          }),
          runFullWorkflow: Effect.fnUntraced(function* () {
            yield* Effect.void;
            calls.push("workflow");
            return { status: "completed" as const };
          }),
        },
      ),
    );
    expect(calls).toEqual(["preflight", "workspace"]);
  });
  test("targeted auto uses clone workspace metadata, beforeRun hook, and the managed pipeline", async () => {
    await Promise.resolve();
    const cwd = await mkdtemp(path.join(tmpdir(), "roark-targeted-auto-"));
    tempDirs.push(cwd);
    const workspacePath = await mkdtemp(
      path.join(tmpdir(), "roark-clone-workspace-"),
    );
    tempDirs.push(workspacePath);
    const calls: string[] = [];
    let fetchCount = 0;
    await runApplicationPromise(
      runAutoDiscovery(
        {
          ...baseOptions(cwd),
          issue: "29",
          noAssign: true,
          hooks: {
            timeoutMs: 1000,
            beforeRun: "printf before > before-run.txt",
          },
        },
        {
          ...noOpLabelContract,
          clock: { now: () => new Date("2026-05-07T00:00:00.000Z") },
          fetchGitHubIssue: Effect.fnUntraced(function* () {
            yield* Effect.void;
            fetchCount += 1;
            return fetchedGitHubIssue(
              29,
              ["ready-for-agent"],
              fetchCount === 1 ? "Initial issue title" : "Fresh issue title",
            );
          }),
          assertCleanAutorunGit: Effect.fnUntraced(function* () {
            yield* Effect.void;
            calls.push("preflight");
            return undefined;
          }),
          claimGitHubIssue: Effect.fnUntraced(function* (input) {
            yield* Effect.void;
            calls.push(`claim:${input.plan.branchName}`);
            expect(input.repo).toBe("owner/repo");
            expect(input.plan.removeLabels).toEqual(["ready-for-agent"]);
            return undefined;
          }),
          prepareCloneWorkspace: Effect.fnUntraced(function* (input) {
            yield* Effect.void;
            calls.push(`workspace:${input.plan.branchName}`);
            expect(input.controlCwd).toBe(cwd);
            return {
              path: workspacePath,
              metadata: {
                path: workspacePath,
                strategy: "clone" as const,
                cloneRemote: "origin",
                cloneUrl: "git@github.com:owner/repo.git",
                createdNow: true,
              },
            };
          }),
          publishIssueLedgerComment: Effect.fnUntraced(function* () {
            yield* Effect.void;
            calls.push("ledger");
            return undefined;
          }),
          runFullWorkflow: Effect.fnUntraced(
            function* (context, workflowOptions) {
              calls.push(`workflow:${context.runDirRelative}`);
              expect(context.controlCwd).toBe(cwd);
              expect(context.agentCwd).toBe(workspacePath);
              const suppliedSnapshot = workflowOptions?.issueSnapshot;
              expect(suppliedSnapshot?.issue.title).toBe("Fresh issue title");
              if (!suppliedSnapshot)
                return yield* Effect.die(
                  new Error("Expected fresh pre-claim issue snapshot"),
                );
              expect(
                yield* Effect.promise(() =>
                  readFile(path.join(workspacePath, "before-run.txt"), "utf8"),
                ),
              ).toBe("before");
              yield* Effect.promise(() =>
                runApplicationPromise(
                  nativePhases.fetchIssuePhase(context, suppliedSnapshot),
                ),
              );
              return { status: "completed" as const };
            },
          ),
          completeAutorunWorkflow: Effect.fnUntraced(function* (input) {
            yield* Effect.void;
            calls.push(`complete:${input.branchPlan.branchName}`);
            return { outcome: "published" as const, outcomeDetail: null };
          }),
        },
      ),
    );
    expect(calls).toEqual([
      "preflight",
      "workspace:roark/issue-29",
      "claim:roark/issue-29",
      "ledger",
      "workflow:.roark/runs/issue/29/attempts/1",
      "complete:roark/issue-29",
    ]);
    expect(fetchCount).toBe(2);
    const issueArtifact = await readFile(
      path.join(cwd, ".roark/runs/issue/29/attempts/1/issue.md"),
      "utf8",
    );
    expect(issueArtifact).toContain("Fresh issue title");
    expect(issueArtifact).not.toContain("Initial issue title");
    const metadata = await runApplicationPromise(
      Effect.flatMap(AttemptStore, (store) =>
        store.read(path.join(cwd, ".roark/runs/issue/29"), 1),
      ),
    );
    expect(metadata.worktreePath).toBe(workspacePath);
    expect(metadata.workspace).toEqual({
      path: workspacePath,
      strategy: "clone",
      cloneRemote: "origin",
      cloneUrl: "git@github.com:owner/repo.git",
      createdNow: true,
    });
  });
  test("non-dry auto runs are serialized per issue", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "roark-auto-lock-"));
    tempDirs.push(cwd);
    let releaseFirst!: () => void;
    let enteredFirst!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      enteredFirst = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = runApplicationPromise(
      runAutoDiscovery(
        { ...baseOptions(cwd), issue: "29", noAssign: true },
        {
          ...noOpLabelContract,
          fetchGitHubIssue: Effect.fnUntraced(function* () {
            return (yield* Effect.void, fetchedGitHubIssue(29, []));
          }),
          assertCleanAutorunGit: Effect.fnUntraced(function* () {
            yield* Effect.void;
            return undefined;
          }),
          prepareCloneWorkspace: Effect.fnUntraced(function* () {
            enteredFirst();
            yield* Effect.promise(() => release);
            return yield* Effect.fail(
              new WorkspaceError({ message: "stop first auto" }),
            );
          }),
        },
      ),
    );
    await firstEntered;
    await assertRejects(
      runApplicationPromise(
        runAutoDiscovery(
          { ...baseOptions(cwd), issue: "29", noAssign: true },
          {
            ...noOpLabelContract,
            fetchGitHubIssue: Effect.fnUntraced(function* () {
              return (yield* Effect.void, fetchedGitHubIssue(29, []));
            }),
            assertCleanAutorunGit: Effect.fnUntraced(function* () {
              yield* Effect.void;
              return undefined;
            }),
            prepareCloneWorkspace: Effect.fnUntraced(function* () {
              yield* Effect.void;
              return yield* Effect.die(
                new Error("second auto should not prepare a workspace"),
              );
            }),
          },
        ),
      ),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes("roark auto issue #29 is already running"),
    );
    releaseFirst();
    await assertRejects(
      first,
      (error: unknown) =>
        error instanceof Error && error.message.includes("stop first auto"),
    );
  });
  test("non-dry auto allows different issues to run concurrently in one checkout", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "roark-auto-issue-lock-"));
    tempDirs.push(cwd);
    let releaseFirst!: () => void;
    let enteredFirst!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      enteredFirst = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = runApplicationPromise(
      runAutoDiscovery(
        { ...baseOptions(cwd), issue: "29", noAssign: true },
        {
          ...noOpLabelContract,
          fetchGitHubIssue: Effect.fnUntraced(function* () {
            return (yield* Effect.void, fetchedGitHubIssue(29, []));
          }),
          assertCleanAutorunGit: Effect.fnUntraced(function* () {
            yield* Effect.void;
            return undefined;
          }),
          prepareCloneWorkspace: Effect.fnUntraced(function* () {
            enteredFirst();
            yield* Effect.promise(() => release);
            return yield* Effect.fail(
              new WorkspaceError({ message: "stop first auto" }),
            );
          }),
        },
      ),
    );
    await firstEntered;
    await assertRejects(
      runApplicationPromise(
        runAutoDiscovery(
          { ...baseOptions(cwd), issue: "30", noAssign: true },
          {
            ...noOpLabelContract,
            fetchGitHubIssue: Effect.fnUntraced(function* () {
              return (yield* Effect.void, fetchedGitHubIssue(30, []));
            }),
            assertCleanAutorunGit: Effect.fnUntraced(function* () {
              yield* Effect.void;
              return undefined;
            }),
            prepareCloneWorkspace: Effect.fnUntraced(function* () {
              yield* Effect.void;
              return yield* Effect.die(
                new Error("second auto reached workspace"),
              );
            }),
          },
        ),
      ),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes("second auto reached workspace"),
    );
    releaseFirst();
    await assertRejects(
      first,
      (error: unknown) =>
        error instanceof Error && error.message.includes("stop first auto"),
    );
  });
});
function baseOptions(cwd = "/repo"): AutoCliOptions {
  return {
    command: "auto",
    cwd,
    repo: "owner/repo",
    readyLabel: defaultAutorunReadyLabel,
    skipLabels: [...defaultAutorunSkipLabels],
    limit: 1,
    inProgressLabel: defaultAutorunInProgressLabel,
    noAssign: true,
    dryRun: false,
    baseBranch: defaultAutorunBaseBranch,
    verifyCommand: defaultAutorunVerifyCommand,
    failureLabel: defaultAutorunFailureLabel,
    successLabel: defaultAutorunSuccessLabel,
    remote: defaultAutorunRemote,
    maxFixPasses: 3,
    force: false,
    yes: false,
  };
}
function issue(number: number, createdAt: string, labels: string[]) {
  return {
    number,
    title: `Issue ${number}`,
    url: `https://github.com/owner/repo/issues/${number}`,
    createdAt,
    labels: labels.map((name) => ({ name })),
  };
}
function dependencyClearRelationships(
  issueNumber: number,
  blockedBy: {
    number: number;
    title: string;
    state: string;
    url: string;
  }[] = [],
  bodyDeclaredBlockers: ReturnType<typeof bodyBlocker>[] = [],
) {
  return {
    fetchedAt: "2026-05-07T00:00:00.000Z",
    repo: "owner/repo",
    nativeDependenciesAvailable: true,
    blockedBy,
    blocking: [],
    bodyDeclaredBlockers,
    issueDependenciesSummary: {
      blockedBy: blockedBy.filter((item) => item.state !== "CLOSED").length,
      blocking: 0,
      totalBlockedBy: blockedBy.length,
      totalBlocking: 0,
    },
    issueNumber,
  };
}
function dependency(number: number, title: string, state: string) {
  return {
    number,
    title,
    state,
    url: `https://github.com/owner/repo/issues/${number}`,
  };
}
function bodyBlocker(number: number, title: string, state: string) {
  return {
    raw: `#${number}`,
    repo: "owner/repo",
    number,
    verified: true,
    title,
    url: `https://github.com/owner/repo/issues/${number}`,
    state,
    closed: state === "CLOSED",
  };
}
function fetchedGitHubIssue(
  number: number,
  labels: string[],
  title = `Issue ${number}`,
) {
  return {
    issue: {
      number,
      title,
      url: `https://github.com/owner/repo/issues/${number}`,
      labels: labels.map((name) => ({ name })),
    },
    issueNumber: String(number),
    repo: "owner/repo",
    fetchedAt: "2026-05-07T00:00:01.000Z",
    relationships: {
      fetchedAt: "2026-05-07T00:00:00.000Z",
      repo: "owner/repo",
      nativeDependenciesAvailable: true,
      blockedBy: [],
      blocking: [],
      bodyDeclaredBlockers: [],
    },
  };
}
async function captureLogs(
  fn: (application: ApplicationExecution) => Promise<void>,
): Promise<string[]> {
  const logs: string[] = [];
  return runWithPresenter(
    new Presenter({
      stream: {
        isTTY: false,
        columns: 80,
        write(chunk) {
          logs.push(chunk.replace(/\n$/, ""));
        },
      },
    }),
    async (application) => {
      await fn(application);
      return logs;
    },
  );
}
