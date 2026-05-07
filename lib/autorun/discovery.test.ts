import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AutoCliOptions } from "../cli/args.ts";
import { defaultAutorunBaseBranch } from "./branch.ts";
import { defaultAutorunFailureLabel } from "./failure.ts";
import { defaultAutorunRemote, defaultAutorunSuccessLabel } from "./publish.ts";
import { defaultAutorunInProgressLabel, defaultAutorunReadyLabel, defaultAutorunSkipLabels } from "./selection.ts";
import { defaultAutorunVerifyCommand } from "./verification.ts";
import { runAutoDiscovery } from "./discovery.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("runAutoDiscovery", () => {
  test("discovery auto still lists and selects eligible issues", async () => {
    let listed = false;
    const logs = await captureLogs(async () => {
      await runAutoDiscovery({ ...baseOptions(), dryRun: true }, {
        listOpenGitHubIssues: async (input) => {
          listed = true;
          expect(input.limit).toBe(100);
          return [
            issue(1, "2026-01-03T00:00:00Z", [defaultAutorunReadyLabel]),
            issue(2, "2026-01-01T00:00:00Z", ["enhancement"]),
            issue(3, "2026-01-02T00:00:00Z", [defaultAutorunReadyLabel]),
            issue(4, "2026-01-01T00:00:00Z", [defaultAutorunReadyLabel, "roark-in-progress"]),
          ];
        },
        fetchGitHubIssueRelationships: async (input) => dependencyClearRelationships(Number(input.issueNumber)),
      });
    });

    expect(listed).toBe(true);
    expect(logs.join("\n")).toContain("#3 Issue 3");
    expect(logs.join("\n")).not.toContain("#1 Issue 1");
  });

  test("discovery auto skips active native-blocked issues and selects the next eligible issue", async () => {
    const checked: number[] = [];

    const logs = await captureLogs(async () => {
      await runAutoDiscovery({ ...baseOptions(), dryRun: true }, {
        listOpenGitHubIssues: async () => [
          issue(1, "2026-01-01T00:00:00Z", [defaultAutorunReadyLabel]),
          issue(2, "2026-01-02T00:00:00Z", [defaultAutorunReadyLabel]),
        ],
        fetchGitHubIssueRelationships: async (input) => {
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
    expect(logText).toContain("Skipped issue(s) with active native blockers:");
    expect(logText).toContain("- #1 Issue 1");
    expect(logText).toContain("blocked by #99 Blocker [OPEN]");
    expect(logText).toContain("Selected issue(s):\n- #2 Issue 2");
  });

  test("discovery auto keeps issues whose native blockers are all closed eligible", async () => {
    const checked: number[] = [];

    const logs = await captureLogs(async () => {
      await runAutoDiscovery({ ...baseOptions(), dryRun: true }, {
        listOpenGitHubIssues: async () => [
          issue(1, "2026-01-01T00:00:00Z", [defaultAutorunReadyLabel]),
          issue(2, "2026-01-02T00:00:00Z", [defaultAutorunReadyLabel]),
        ],
        fetchGitHubIssueRelationships: async (input) => {
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
    expect(logText).not.toContain("Skipped issue(s) with active native blockers:");
    expect(logText).toContain("Selected issue(s):\n- #1 Issue 1");
  });

  test("discovery auto selection limit counts unblocked issues", async () => {
    const checked: number[] = [];

    const logs = await captureLogs(async () => {
      await runAutoDiscovery({ ...baseOptions(), dryRun: true, limit: 2 }, {
        listOpenGitHubIssues: async () => [
          issue(1, "2026-01-01T00:00:00Z", [defaultAutorunReadyLabel]),
          issue(2, "2026-01-02T00:00:00Z", [defaultAutorunReadyLabel]),
          issue(3, "2026-01-03T00:00:00Z", [defaultAutorunReadyLabel]),
        ],
        fetchGitHubIssueRelationships: async (input) => {
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
    let preflighted = false;
    let claimed = false;

    await expect(runAutoDiscovery({ ...baseOptions() }, {
      listOpenGitHubIssues: async () => [issue(1, "2026-01-01T00:00:00Z", [defaultAutorunReadyLabel])],
      fetchGitHubIssueRelationships: async () => ({
        fetchedAt: "2026-05-07T00:00:00.000Z",
        repo: "owner/repo",
        nativeDependenciesAvailable: false,
        blockedBy: [],
        blocking: [],
        bodyDeclaredBlockers: [],
        unavailableReason: "GitHub dependency API unavailable",
      }),
      assertCleanAutorunGit: async () => {
        preflighted = true;
      },
      claimGitHubIssue: async () => {
        claimed = true;
      },
    })).rejects.toThrow("Could not verify native GitHub dependencies for issue #1: GitHub dependency API unavailable");

    expect(preflighted).toBe(false);
    expect(claimed).toBe(false);
  });

  test("targeted auto fetches the requested issue instead of listing discovery candidates", async () => {
    let fetchedIssue: string | undefined;
    await runAutoDiscovery({ ...baseOptions(), issue: "owner/repo#29", dryRun: true }, {
      listOpenGitHubIssues: async () => {
        throw new Error("targeted auto should not list issues");
      },
      fetchGitHubIssue: async (input) => {
        fetchedIssue = input;
        return fetchedGitHubIssue(29, []);
      },
    });

    expect(fetchedIssue).toBe("owner/repo#29");
  });

  test("targeted auto refuses skip labels before claim", async () => {
    let claimed = false;
    let preflighted = false;

    await expect(runAutoDiscovery({ ...baseOptions(), issue: "29" }, {
      fetchGitHubIssue: async () => fetchedGitHubIssue(29, ["roark-in-progress"]),
      assertCleanAutorunGit: async () => {
        preflighted = true;
      },
      claimGitHubIssue: async () => {
        claimed = true;
      },
    })).rejects.toThrow("Issue #29 has skip label roark-in-progress");

    expect(preflighted).toBe(false);
    expect(claimed).toBe(false);
  });

  test("dirty autorun preflight runs before claim", async () => {
    const order: string[] = [];

    await expect(runAutoDiscovery({ ...baseOptions(), issue: "29" }, {
      fetchGitHubIssue: async () => fetchedGitHubIssue(29, []),
      assertCleanAutorunGit: async () => {
        order.push("preflight");
        throw new Error("dirty worktree");
      },
      claimGitHubIssue: async () => {
        order.push("claim");
      },
    })).rejects.toThrow("dirty worktree");

    expect(order).toEqual(["preflight"]);
  });

  test("targeted auto uses the managed claim, branch, attempt, workflow, and completion pipeline", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "roark-targeted-auto-"));
    tempDirs.push(cwd);
    const calls: string[] = [];

    await runAutoDiscovery({ ...baseOptions(cwd), issue: "29", noAssign: true }, {
      clock: { now: () => new Date("2026-05-07T00:00:00.000Z") },
      fetchGitHubIssue: async () => fetchedGitHubIssue(29, []),
      assertCleanAutorunGit: async () => {
        calls.push("preflight");
      },
      claimGitHubIssue: async (input) => {
        calls.push(`claim:${input.plan.branchName}`);
        expect(input.repo).toBe("owner/repo");
      },
      checkoutIssueBranch: async (input) => {
        calls.push(`checkout:${input.plan.branchName}`);
      },
      publishIssueLedgerComment: async () => {
        calls.push("ledger");
      },
      runFullWorkflow: async (context) => {
        calls.push(`workflow:${context.runDirRelative}`);
        return { status: "completed" };
      },
      completeAutorunWorkflow: async (input) => {
        calls.push(`complete:${input.branchPlan.branchName}`);
        return { outcome: "published", outcomeDetail: null };
      },
    });

    expect(calls).toEqual([
      "preflight",
      "claim:roark/issue-29",
      "checkout:roark/issue-29",
      "ledger",
      "workflow:.roark/runs/issue/29/attempts/1",
      "complete:roark/issue-29",
    ]);
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
  blockedBy: Array<{ number: number; title: string; state: string; url: string }> = [],
) {
  return {
    fetchedAt: "2026-05-07T00:00:00.000Z",
    repo: "owner/repo",
    nativeDependenciesAvailable: true,
    blockedBy,
    blocking: [],
    bodyDeclaredBlockers: [],
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
    logs.push(String(message ?? ""));
  };
  try {
    await fn();
    return logs;
  } finally {
    console.log = original;
  }
}
