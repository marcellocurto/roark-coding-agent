import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AutoCliOptions } from "../cli/args.ts";
import { defaultAutorunBaseBranch } from "./branch.ts";
import { defaultAutorunFailureLabel } from "./failure.ts";
import { defaultAutorunRemote, defaultAutorunSuccessLabel } from "./publish.ts";
import { defaultAutorunInProgressLabel, defaultAutorunReadyLabel, defaultAutorunSkipLabels } from "./selection.ts";
import { defaultAutorunVerifyCommand } from "./verification.ts";
import { readAttemptMetadata } from "./attempts.ts";
import { runAutoDiscovery } from "./discovery.ts";
import { noopAsync } from "../utils/async.ts";
import { configurePresenter } from "../presentation/presenter.ts";

const tempDirs: string[] = [];
const noOpLabelContract = {
  ensureAutorunLabelContract: async () => (await noopAsync(), ({ existing: [], missing: [], created: [] })),
};

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("runAutoDiscovery", () => {
  test("discovery auto still lists and selects eligible issues", async () => {
    let listed = false;
    const logs = await captureLogs(async () => {
        await noopAsync();
      await runAutoDiscovery({ ...baseOptions(), dryRun: true }, {
        ...noOpLabelContract,
        listOpenGitHubIssues: async (input) => {
        await noopAsync();
          listed = true;
          expect(input.limit).toBe(100);
          return [
            issue(1, "2026-01-03T00:00:00Z", [defaultAutorunReadyLabel]),
            issue(2, "2026-01-01T00:00:00Z", ["enhancement"]),
            issue(3, "2026-01-02T00:00:00Z", [defaultAutorunReadyLabel]),
            issue(4, "2026-01-01T00:00:00Z", [defaultAutorunReadyLabel, "roark-in-progress"]),
          ];
        },
        fetchGitHubIssueRelationships: async (input) => (await noopAsync(), dependencyClearRelationships(Number(input.issueNumber))),
      });
    });

    expect(listed).toBe(true);
    expect(logs.join("\n")).toContain("#3 Issue 3");
    expect(logs.join("\n")).not.toContain("#1 Issue 1");
  });

  test("sanitizes hostile issue metadata in ordinary discovery output", async () => {
    const logs = await captureLogs(async () => {
      await runAutoDiscovery({ ...baseOptions(), dryRun: true }, {
        ...noOpLabelContract,
        listOpenGitHubIssues: async () => (await noopAsync(), [{
          ...issue(1, "2026-01-01T00:00:00Z", [defaultAutorunReadyLabel]),
          title: "hostile\u001b]0;owned\u0007\rrewritten",
          url: "https://example.invalid/one\nINJECTED",
        }]),
        fetchGitHubIssueRelationships: async () => (await noopAsync(), dependencyClearRelationships(1)),
      });
    });

    const output = logs.join("\n");
    expect(output).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
    expect(output).toContain("hostile ]0;owned rewritten");
    expect(output).toContain("INJECTED");
  });

  test("discovery auto skips active body-declared blockers and selects the next eligible issue", async () => {
        await noopAsync();
    const checkedBodies: string[] = [];

    const logs = await captureLogs(async () => {
        await noopAsync();
      await runAutoDiscovery({ ...baseOptions(), dryRun: true }, {
        ...noOpLabelContract,
        listOpenGitHubIssues: async () => (await noopAsync(), [
          { ...issue(1, "2026-01-01T00:00:00Z", [defaultAutorunReadyLabel]), body: "Depends on #99" },
          issue(2, "2026-01-02T00:00:00Z", [defaultAutorunReadyLabel]),
        ]),
        fetchGitHubIssueRelationships: async (input) => {
        await noopAsync();
          checkedBodies.push(input.body);
          return Number(input.issueNumber) === 1
            ? dependencyClearRelationships(1, [], [bodyBlocker(99, "Body blocker", "OPEN")])
            : dependencyClearRelationships(Number(input.issueNumber));
        },
      });
    });

    const logText = logs.join("\n");
    expect(checkedBodies).toEqual(["Depends on #99", ""]);
    expect(logText).toContain("Skipped issue(s) with active blockers:");
    expect(logText).toContain("blocked by #99 Body blocker [OPEN]");
    expect(logText).toContain("Selected issue(s):\n- #2 Issue 2");
  });

  test("discovery auto keeps issues whose body-declared blockers are closed eligible", async () => {
    const logs = await captureLogs(async () => {
  await noopAsync();
      await runAutoDiscovery({ ...baseOptions(), dryRun: true }, {
        ...noOpLabelContract,
        listOpenGitHubIssues: async () => (await noopAsync(), [
          { ...issue(1, "2026-01-01T00:00:00Z", [defaultAutorunReadyLabel]), body: "Blocked by #99" },
        ]),
        fetchGitHubIssueRelationships: async () => (await noopAsync(), dependencyClearRelationships(1, [], [bodyBlocker(99, "Closed body blocker", "CLOSED")])),
      });
    });

    const logText = logs.join("\n");
    expect(logText).not.toContain("Skipped issue(s) with active blockers:");
    expect(logText).toContain("Selected issue(s):\n- #1 Issue 1");
  });

  test("discovery auto skips active native-blocked issues and selects the next eligible issue", async () => {
        await noopAsync();
    const checked: number[] = [];

    const logs = await captureLogs(async () => {
  await noopAsync();
      await runAutoDiscovery({ ...baseOptions(), dryRun: true }, {
        ...noOpLabelContract,
        listOpenGitHubIssues: async () => (await noopAsync(), [
          issue(1, "2026-01-01T00:00:00Z", [defaultAutorunReadyLabel]),
          issue(2, "2026-01-02T00:00:00Z", [defaultAutorunReadyLabel]),
        ]),
        fetchGitHubIssueRelationships: async (input) => {
        await noopAsync();
          const issueNumber = Number(input.issueNumber);
          checked.push(issueNumber);
          return issueNumber === 1
            ? dependencyClearRelationships(issueNumber, [dependency(99, "Blocker", "OPEN")])
            : dependencyClearRelationships(issueNumber);
        },
      });
    });

    const logText = logs.join("\n");
    expect(checked).toEqual([1, 2]);
    expect(logText).toContain("Skipped issue(s) with active blockers:");
    expect(logText).toContain("- #1 Issue 1");
    expect(logText).toContain("blocked by #99 Blocker [OPEN]");
    expect(logText).toContain("Selected issue(s):\n- #2 Issue 2");
  });

  test("discovery auto keeps issues whose native blockers are all closed eligible", async () => {
        await noopAsync();
    const checked: number[] = [];

    const logs = await captureLogs(async () => {
  await noopAsync();
      await runAutoDiscovery({ ...baseOptions(), dryRun: true }, {
        ...noOpLabelContract,
        listOpenGitHubIssues: async () => (await noopAsync(), [
          issue(1, "2026-01-01T00:00:00Z", [defaultAutorunReadyLabel]),
          issue(2, "2026-01-02T00:00:00Z", [defaultAutorunReadyLabel]),
        ]),
        fetchGitHubIssueRelationships: async (input) => {
        await noopAsync();
          const issueNumber = Number(input.issueNumber);
          checked.push(issueNumber);
          return issueNumber === 1
            ? dependencyClearRelationships(issueNumber, [dependency(99, "Closed blocker", "CLOSED")])
            : dependencyClearRelationships(issueNumber);
        },
      });
    });

    const logText = logs.join("\n");
    expect(checked).toEqual([1]);
    expect(logText).not.toContain("Skipped issue(s) with active blockers:");
    expect(logText).toContain("Selected issue(s):\n- #1 Issue 1");
  });

  test("discovery auto selection limit counts unblocked issues", async () => {
        await noopAsync();
    const checked: number[] = [];

    const logs = await captureLogs(async () => {
  await noopAsync();
      await runAutoDiscovery({ ...baseOptions(), dryRun: true, limit: 2 }, {
        ...noOpLabelContract,
        listOpenGitHubIssues: async () => (await noopAsync(), [
          issue(1, "2026-01-01T00:00:00Z", [defaultAutorunReadyLabel]),
          issue(2, "2026-01-02T00:00:00Z", [defaultAutorunReadyLabel]),
          issue(3, "2026-01-03T00:00:00Z", [defaultAutorunReadyLabel]),
        ]),
        fetchGitHubIssueRelationships: async (input) => {
        await noopAsync();
          const issueNumber = Number(input.issueNumber);
          checked.push(issueNumber);
          return issueNumber === 1
            ? dependencyClearRelationships(issueNumber, [dependency(99, "Blocker", "OPEN")])
            : dependencyClearRelationships(issueNumber);
        },
      });
    });

    const logText = logs.join("\n");
    expect(checked).toEqual([1, 2, 3]);
    expect(logText).toContain("Selected issue(s):");
    expect(logText).toContain("- #2 Issue 2");
    expect(logText).toContain("- #3 Issue 3");
  });

  test("discovery auto fails closed when native dependency data is unavailable", async () => {
        await noopAsync();
    let preflighted = false;
    let claimed = false;

    expect(runAutoDiscovery({ ...baseOptions() }, {
      ...noOpLabelContract,
      listOpenGitHubIssues: async () => (await noopAsync(), [issue(1, "2026-01-01T00:00:00Z", [defaultAutorunReadyLabel])]),
      fetchGitHubIssueRelationships: async () => (await noopAsync(), ({
        fetchedAt: "2026-05-07T00:00:00.000Z",
        repo: "owner/repo",
        nativeDependenciesAvailable: false,
        blockedBy: [],
        blocking: [],
        bodyDeclaredBlockers: [],
        unavailableReason: "GitHub dependency API unavailable",
      })),
      assertCleanAutorunGit: async () => {
        await noopAsync();
        preflighted = true;
      },
      claimGitHubIssue: async () => {
        await noopAsync();
        claimed = true;
      },
    })).rejects.toThrow("Could not verify native GitHub dependencies for issue #1: GitHub dependency API unavailable");

    expect(preflighted).toBe(false);
    expect(claimed).toBe(false);
  });

  test("targeted auto ensures labels before fetching the requested issue", async () => {
        await noopAsync();
    const calls: string[] = [];
    await runAutoDiscovery({ ...baseOptions(), issue: "owner/repo#29", dryRun: true }, {
      ...noOpLabelContract,
      ensureAutorunLabelContract: async () => {
        await noopAsync();
        calls.push("ensure-labels");
        return { existing: [], missing: [], created: [] };
      },
      listOpenGitHubIssues: async () => {
        await noopAsync();
        throw new Error("targeted auto should not list issues");
      },
      fetchGitHubIssue: async (input) => {
        await noopAsync();
        calls.push(`fetch:${input}`);
        return fetchedGitHubIssue(29, []);
      },
    });

    expect(calls).toEqual(["ensure-labels", "fetch:owner/repo#29"]);
  });

  test("targeted auto refuses skip labels before claim", async () => {
        await noopAsync();
    let claimed = false;
    let preflighted = false;

    expect(runAutoDiscovery({ ...baseOptions(), issue: "29" }, {
      ...noOpLabelContract,
      fetchGitHubIssue: async () => (await noopAsync(), fetchedGitHubIssue(29, ["roark-in-progress"])),
      assertCleanAutorunGit: async () => {
        await noopAsync();
        preflighted = true;
      },
      claimGitHubIssue: async () => {
        await noopAsync();
        claimed = true;
      },
    })).rejects.toThrow("Issue #29 has skip label roark-in-progress");

    expect(preflighted).toBe(false);
    expect(claimed).toBe(false);
  });

  test("dirty autorun preflight runs before claim", async () => {
  await noopAsync();
    const order: string[] = [];

    expect(runAutoDiscovery({ ...baseOptions(), issue: "29" }, {
      ...noOpLabelContract,
      fetchGitHubIssue: async () => (await noopAsync(), fetchedGitHubIssue(29, [])),
      assertCleanAutorunGit: async () => {
        await noopAsync();
        order.push("preflight");
        throw new Error("dirty worktree");
      },
      claimGitHubIssue: async () => {
        await noopAsync();
        order.push("claim");
      },
    })).rejects.toThrow("dirty worktree");

    expect(order).toEqual(["preflight"]);
  });

  test("targeted auto rechecks labels after workspace setup and skips before claim without beforeRun", async () => {
        await noopAsync();
    const cwd = await mkdtemp(path.join(tmpdir(), "roark-targeted-auto-recheck-"));
    tempDirs.push(cwd);
    const workspacePath = path.join(cwd, "managed-workspace");
    const calls: string[] = [];
    let fetchCount = 0;

    await runAutoDiscovery({
      ...baseOptions(cwd),
      issue: "29",
      noAssign: true,
      hooks: { timeoutMs: 1000, beforeRun: "printf should-not-run > before-run.txt" },
    }, {
      ...noOpLabelContract,
      fetchGitHubIssue: async () => {
        await noopAsync();
        fetchCount += 1;
        return fetchCount === 1
          ? fetchedGitHubIssue(29, [])
          : fetchedGitHubIssue(29, ["roark-in-progress"]);
      },
      assertCleanAutorunGit: async () => {
        await noopAsync();
        calls.push("preflight");
      },
      prepareCloneWorkspace: async () => {
        await noopAsync();
        calls.push("workspace");
        return {
          path: workspacePath,
          metadata: { path: workspacePath, strategy: "clone", cloneRemote: "origin", createdNow: true },
        };
      },
      claimGitHubIssue: async () => {
        await noopAsync();
        calls.push("claim");
      },
      runFullWorkflow: async () => {
        await noopAsync();
        calls.push("workflow");
        return { status: "completed" };
      },
    });

    expect(calls).toEqual(["preflight", "workspace"]);
  });

  test("targeted auto uses clone workspace metadata, beforeRun hook, and the managed pipeline", async () => {
        await noopAsync();
    const cwd = await mkdtemp(path.join(tmpdir(), "roark-targeted-auto-"));
    tempDirs.push(cwd);
    const workspacePath = await mkdtemp(path.join(tmpdir(), "roark-clone-workspace-"));
    tempDirs.push(workspacePath);
    const calls: string[] = [];

    await runAutoDiscovery({
      ...baseOptions(cwd),
      issue: "29",
      noAssign: true,
      hooks: { timeoutMs: 1000, beforeRun: "printf before > before-run.txt" },
    }, {
      ...noOpLabelContract,
      clock: { now: () => new Date("2026-05-07T00:00:00.000Z") },
      fetchGitHubIssue: async () => (await noopAsync(), fetchedGitHubIssue(29, [])),
      assertCleanAutorunGit: async () => {
        await noopAsync();
        calls.push("preflight");
      },
      claimGitHubIssue: async (input) => {
        await noopAsync();
        calls.push(`claim:${input.plan.branchName}`);
        expect(input.repo).toBe("owner/repo");
      },
      prepareCloneWorkspace: async (input) => {
  await noopAsync();
        calls.push(`workspace:${input.plan.branchName}`);
        expect(input.controlCwd).toBe(cwd);
        return {
          path: workspacePath,
          metadata: {
            path: workspacePath,
            strategy: "clone",
            cloneRemote: "origin",
            cloneUrl: "git@github.com:owner/repo.git",
            createdNow: true,
          },
        };
      },
      publishIssueLedgerComment: async () => {
        await noopAsync();
        calls.push("ledger");
      },
      runFullWorkflow: async (context) => {
        calls.push(`workflow:${context.runDirRelative}`);
        expect(context.controlCwd).toBe(cwd);
        expect(context.agentCwd).toBe(workspacePath);
        expect(await readFile(path.join(workspacePath, "before-run.txt"), "utf8")).toBe("before");
        return { status: "completed" };
      },
      completeAutorunWorkflow: async (input) => {
        await noopAsync();
        calls.push(`complete:${input.branchPlan.branchName}`);
        return { outcome: "published", outcomeDetail: null };
      },
    });

    expect(calls).toEqual([
      "preflight",
      "workspace:roark/issue-29",
      "claim:roark/issue-29",
      "ledger",
      "workflow:.roark/runs/issue/29/attempts/1",
      "complete:roark/issue-29",
    ]);
    const metadata = await readAttemptMetadata(path.join(cwd, ".roark/runs/issue/29"), 1);
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
    const firstEntered = new Promise<void>((resolve) => { enteredFirst = resolve; });
    const release = new Promise<void>((resolve) => { releaseFirst = resolve; });

    const first = runAutoDiscovery({ ...baseOptions(cwd), issue: "29", noAssign: true }, {
      ...noOpLabelContract,
      fetchGitHubIssue: async () => (await noopAsync(), fetchedGitHubIssue(29, [])),
      assertCleanAutorunGit: async () => {
        await noopAsync();
      },
      prepareCloneWorkspace: async () => {
        enteredFirst();
        await release;
        throw new Error("stop first auto");
      },
    });

    await firstEntered;

    expect(runAutoDiscovery({ ...baseOptions(cwd), issue: "29", noAssign: true }, {
      ...noOpLabelContract,
      fetchGitHubIssue: async () => (await noopAsync(), fetchedGitHubIssue(29, [])),
      assertCleanAutorunGit: async () => {
        await noopAsync();
      },
      prepareCloneWorkspace: async () => {
        await noopAsync();
        throw new Error("second auto should not prepare a workspace");
      },
    })).rejects.toThrow("roark auto issue #29 is already running");

    releaseFirst();
    expect(first).rejects.toThrow("stop first auto");
  });

  test("non-dry auto allows different issues to run concurrently in one checkout", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "roark-auto-issue-lock-"));
    tempDirs.push(cwd);
    let releaseFirst!: () => void;
    let enteredFirst!: () => void;
    const firstEntered = new Promise<void>((resolve) => { enteredFirst = resolve; });
    const release = new Promise<void>((resolve) => { releaseFirst = resolve; });

    const first = runAutoDiscovery({ ...baseOptions(cwd), issue: "29", noAssign: true }, {
      ...noOpLabelContract,
      fetchGitHubIssue: async () => (await noopAsync(), fetchedGitHubIssue(29, [])),
      assertCleanAutorunGit: async () => {
        await noopAsync();
      },
      prepareCloneWorkspace: async () => {
        enteredFirst();
        await release;
        throw new Error("stop first auto");
      },
    });

    await firstEntered;

    expect(runAutoDiscovery({ ...baseOptions(cwd), issue: "30", noAssign: true }, {
      ...noOpLabelContract,
      fetchGitHubIssue: async () => (await noopAsync(), fetchedGitHubIssue(30, [])),
      assertCleanAutorunGit: async () => {
        await noopAsync();
      },
      prepareCloneWorkspace: async () => {
        await noopAsync();
        throw new Error("second auto reached workspace");
      },
    })).rejects.toThrow("second auto reached workspace");

    releaseFirst();
    expect(first).rejects.toThrow("stop first auto");
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
  blockedBy: { number: number; title: string; state: string; url: string }[] = [],
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

function fetchedGitHubIssue(number: number, labels: string[]) {
  return {
    issue: {
      number,
      title: `Issue ${number}`,
      url: `https://github.com/owner/repo/issues/${number}`,
      labels: labels.map((name) => ({ name })),
    },
    issueNumber: String(number),
    repo: "owner/repo",
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

async function captureLogs(fn: () => Promise<void>): Promise<string[]> {
  const logs: string[] = [];
  configurePresenter({
    stream: {
      isTTY: false,
      columns: 80,
      write(chunk) {
        logs.push(chunk.replace(/\n$/, ""));
      },
    },
  });
  try {
    await fn();
    return logs;
  } finally {
    configurePresenter({ titleEnabled: false });
  }
}
