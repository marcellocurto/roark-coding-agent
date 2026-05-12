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
import { tick } from "../test-utils/async.ts";

const tempDirs: string[] = [];
const noOpAutorunLock = {
  acquireAutorunLock: async () => (await tick(), { lockDir: "test-lock", release: async () => {
    await tick();} }),
  ensureAutorunLabelContract: async () => (await tick(), ({ existing: [], missing: [], created: [] })),
};

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("runAutoDiscovery", () => {
  test("discovery auto still lists and selects eligible issues", async () => {
    let listed = false;
    const logs = await captureLogs(async () => {
        await tick();
      await runAutoDiscovery({ ...baseOptions(), dryRun: true }, {
        ...noOpAutorunLock,
        listOpenGitHubIssues: async (input) => {
        await tick();
          listed = true;
          expect(input.limit).toBe(100);
          return [
            issue(1, "2026-01-03T00:00:00Z", [defaultAutorunReadyLabel]),
            issue(2, "2026-01-01T00:00:00Z", ["enhancement"]),
            issue(3, "2026-01-02T00:00:00Z", [defaultAutorunReadyLabel]),
            issue(4, "2026-01-01T00:00:00Z", [defaultAutorunReadyLabel, "roark-in-progress"]),
          ];
        },
        fetchGitHubIssueRelationships: async (input) => (await tick(), dependencyClearRelationships(Number(input.issueNumber))),
      });
    });

    expect(listed).toBe(true);
    expect(logs.join("\n")).toContain("#3 Issue 3");
    expect(logs.join("\n")).not.toContain("#1 Issue 1");
  });

  test("discovery auto acquires the local lock around selection", async () => {
  await tick();
    const calls: string[] = [];

    await runAutoDiscovery({ ...baseOptions(), dryRun: true }, {
      acquireAutorunLock: async () => {
        await tick();
        calls.push("acquire-lock");
        return { lockDir: "test-lock", release: async () => {
        await tick(); calls.push("release-lock"); } };
      },
      ensureAutorunLabelContract: async () => {
        await tick();
        calls.push("ensure-labels");
        return { existing: [], missing: [], created: [] };
      },
      listOpenGitHubIssues: async () => {
        await tick();
        calls.push("list");
        return [];
      },
    });

    expect(calls).toEqual(["acquire-lock", "ensure-labels", "list", "release-lock"]);
  });

  test("discovery auto skips active body-declared blockers and selects the next eligible issue", async () => {
        await tick();
    const checkedBodies: string[] = [];

    const logs = await captureLogs(async () => {
        await tick();
      await runAutoDiscovery({ ...baseOptions(), dryRun: true }, {
        ...noOpAutorunLock,
        listOpenGitHubIssues: async () => (await tick(), [
          { ...issue(1, "2026-01-01T00:00:00Z", [defaultAutorunReadyLabel]), body: "Depends on #99" },
          issue(2, "2026-01-02T00:00:00Z", [defaultAutorunReadyLabel]),
        ]),
        fetchGitHubIssueRelationships: async (input) => {
        await tick();
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
  await tick();
      await runAutoDiscovery({ ...baseOptions(), dryRun: true }, {
        ...noOpAutorunLock,
        listOpenGitHubIssues: async () => (await tick(), [
          { ...issue(1, "2026-01-01T00:00:00Z", [defaultAutorunReadyLabel]), body: "Blocked by #99" },
        ]),
        fetchGitHubIssueRelationships: async () => (await tick(), dependencyClearRelationships(1, [], [bodyBlocker(99, "Closed body blocker", "CLOSED")])),
      });
    });

    const logText = logs.join("\n");
    expect(logText).not.toContain("Skipped issue(s) with active blockers:");
    expect(logText).toContain("Selected issue(s):\n- #1 Issue 1");
  });

  test("discovery auto skips active native-blocked issues and selects the next eligible issue", async () => {
        await tick();
    const checked: number[] = [];

    const logs = await captureLogs(async () => {
  await tick();
      await runAutoDiscovery({ ...baseOptions(), dryRun: true }, {
        ...noOpAutorunLock,
        listOpenGitHubIssues: async () => (await tick(), [
          issue(1, "2026-01-01T00:00:00Z", [defaultAutorunReadyLabel]),
          issue(2, "2026-01-02T00:00:00Z", [defaultAutorunReadyLabel]),
        ]),
        fetchGitHubIssueRelationships: async (input) => {
        await tick();
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
        await tick();
    const checked: number[] = [];

    const logs = await captureLogs(async () => {
  await tick();
      await runAutoDiscovery({ ...baseOptions(), dryRun: true }, {
        ...noOpAutorunLock,
        listOpenGitHubIssues: async () => (await tick(), [
          issue(1, "2026-01-01T00:00:00Z", [defaultAutorunReadyLabel]),
          issue(2, "2026-01-02T00:00:00Z", [defaultAutorunReadyLabel]),
        ]),
        fetchGitHubIssueRelationships: async (input) => {
        await tick();
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
        await tick();
    const checked: number[] = [];

    const logs = await captureLogs(async () => {
  await tick();
      await runAutoDiscovery({ ...baseOptions(), dryRun: true, limit: 2 }, {
        ...noOpAutorunLock,
        listOpenGitHubIssues: async () => (await tick(), [
          issue(1, "2026-01-01T00:00:00Z", [defaultAutorunReadyLabel]),
          issue(2, "2026-01-02T00:00:00Z", [defaultAutorunReadyLabel]),
          issue(3, "2026-01-03T00:00:00Z", [defaultAutorunReadyLabel]),
        ]),
        fetchGitHubIssueRelationships: async (input) => {
        await tick();
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
        await tick();
    let preflighted = false;
    let claimed = false;

    expect(runAutoDiscovery({ ...baseOptions() }, {
      ...noOpAutorunLock,
      listOpenGitHubIssues: async () => (await tick(), [issue(1, "2026-01-01T00:00:00Z", [defaultAutorunReadyLabel])]),
      fetchGitHubIssueRelationships: async () => (await tick(), ({
        fetchedAt: "2026-05-07T00:00:00.000Z",
        repo: "owner/repo",
        nativeDependenciesAvailable: false,
        blockedBy: [],
        blocking: [],
        bodyDeclaredBlockers: [],
        unavailableReason: "GitHub dependency API unavailable",
      })),
      assertCleanAutorunGit: async () => {
        await tick();
        preflighted = true;
      },
      claimGitHubIssue: async () => {
        await tick();
        claimed = true;
      },
    })).rejects.toThrow("Could not verify native GitHub dependencies for issue #1: GitHub dependency API unavailable");

    expect(preflighted).toBe(false);
    expect(claimed).toBe(false);
  });

  test("targeted auto ensures labels before fetching the requested issue", async () => {
        await tick();
    const calls: string[] = [];
    await runAutoDiscovery({ ...baseOptions(), issue: "owner/repo#29", dryRun: true }, {
      ...noOpAutorunLock,
      ensureAutorunLabelContract: async () => {
        await tick();
        calls.push("ensure-labels");
        return { existing: [], missing: [], created: [] };
      },
      listOpenGitHubIssues: async () => {
        await tick();
        throw new Error("targeted auto should not list issues");
      },
      fetchGitHubIssue: async (input) => {
        await tick();
        calls.push(`fetch:${input}`);
        return fetchedGitHubIssue(29, []);
      },
    });

    expect(calls).toEqual(["ensure-labels", "fetch:owner/repo#29"]);
  });

  test("targeted auto refuses skip labels before claim", async () => {
        await tick();
    let claimed = false;
    let preflighted = false;

    expect(runAutoDiscovery({ ...baseOptions(), issue: "29" }, {
      ...noOpAutorunLock,
      fetchGitHubIssue: async () => (await tick(), fetchedGitHubIssue(29, ["roark-in-progress"])),
      assertCleanAutorunGit: async () => {
        await tick();
        preflighted = true;
      },
      claimGitHubIssue: async () => {
        await tick();
        claimed = true;
      },
    })).rejects.toThrow("Issue #29 has skip label roark-in-progress");

    expect(preflighted).toBe(false);
    expect(claimed).toBe(false);
  });

  test("dirty autorun preflight runs before claim", async () => {
  await tick();
    const order: string[] = [];

    expect(runAutoDiscovery({ ...baseOptions(), issue: "29" }, {
      ...noOpAutorunLock,
      fetchGitHubIssue: async () => (await tick(), fetchedGitHubIssue(29, [])),
      assertCleanAutorunGit: async () => {
        await tick();
        order.push("preflight");
        throw new Error("dirty worktree");
      },
      claimGitHubIssue: async () => {
        await tick();
        order.push("claim");
      },
    })).rejects.toThrow("dirty worktree");

    expect(order).toEqual(["preflight"]);
  });

  test("targeted auto rechecks labels after workspace setup and skips before claim without beforeRun", async () => {
        await tick();
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
      ...noOpAutorunLock,
      fetchGitHubIssue: async () => {
        await tick();
        fetchCount += 1;
        return fetchCount === 1
          ? fetchedGitHubIssue(29, [])
          : fetchedGitHubIssue(29, ["roark-in-progress"]);
      },
      assertCleanAutorunGit: async () => {
        await tick();
        calls.push("preflight");
      },
      prepareCloneWorkspace: async () => {
        await tick();
        calls.push("workspace");
        return {
          path: workspacePath,
          metadata: { path: workspacePath, strategy: "clone", cloneRemote: "origin", createdNow: true },
          releaseLock: async () => {
        await tick(); calls.push("release"); },
        };
      },
      claimGitHubIssue: async () => {
        await tick();
        calls.push("claim");
      },
      runFullWorkflow: async () => {
        await tick();
        calls.push("workflow");
        return { status: "completed" };
      },
    });

    expect(calls).toEqual(["preflight", "workspace", "release"]);
  });

  test("targeted auto uses clone workspace metadata, beforeRun hook, and the managed pipeline", async () => {
        await tick();
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
      ...noOpAutorunLock,
      clock: { now: () => new Date("2026-05-07T00:00:00.000Z") },
      fetchGitHubIssue: async () => (await tick(), fetchedGitHubIssue(29, [])),
      assertCleanAutorunGit: async () => {
        await tick();
        calls.push("preflight");
      },
      claimGitHubIssue: async (input) => {
        await tick();
        calls.push(`claim:${input.plan.branchName}`);
        expect(input.repo).toBe("owner/repo");
      },
      prepareCloneWorkspace: async (input) => {
  await tick();
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
          releaseLock: async () => {
        await tick(); calls.push("release"); },
        };
      },
      publishIssueLedgerComment: async () => {
        await tick();
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
        await tick();
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
      "release",
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
  const original = console.log;
  const logs: string[] = [];
  console.log = (message?: unknown) => {
    logs.push(typeof message === "string" ? message : JSON.stringify(message ?? ""));
  };
  try {
    await fn();
    return logs;
  } finally {
    console.log = original;
  }
}
