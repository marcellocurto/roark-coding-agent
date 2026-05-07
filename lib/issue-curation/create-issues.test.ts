import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ProcessResult } from "../cli/process.ts";
import { artifactExists, createWorkflowContext, readArtifact, writeJsonArtifact } from "../workflow/artifacts.ts";
import type { IssueCurationPlan } from "../workflow/issue-curation.ts";
import {
  buildIssueCreateArgv,
  createIssuesFromCurationPlan,
  type ProcessRunner,
} from "./create-issues.ts";

const tempDirs: string[] = [];
const clock = { now: () => new Date("2026-05-07T00:00:00.000Z") };

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("buildIssueCreateArgv", () => {
  test("builds gh issue create argv with needs-triage, labels, and repo", () => {
    expect(buildIssueCreateArgv({
      repo: "owner/repo",
      title: "Follow-up",
      body: "Body",
      labels: ["follow-up", "needs-triage", " follow-up ", ""],
    })).toEqual([
      "gh",
      "issue",
      "create",
      "--title",
      "Follow-up",
      "--body",
      "Body",
      "--label",
      "needs-triage",
      "--label",
      "follow-up",
      "--repo",
      "owner/repo",
    ]);
  });
});

describe("createIssuesFromCurationPlan", () => {
  test("dry-run reports approved plan items without calling GitHub or writing results", async () => {
    const context = await tempContext({ yes: false });
    const plan = basePlan();
    plan.blockingIssuesToCreate.push({ planItemId: "bad", proposedTitle: "Bad" } as never);
    await writeJsonArtifact(context, "issueCurationPlan", plan);

    let calls = 0;
    const result = await createIssuesFromCurationPlan({
      context,
      clock,
      runner: async () => {
        calls += 1;
        return okProcess("unexpected");
      },
    });

    expect(calls).toBe(0);
    expect(artifactExists(context, "issueCreationResults")).toBe(false);
    expect(result.dryRun).toBe(true);
    expect(result.wouldCreate.map((item) => item.planItemId)).toEqual(["blocking-1", "follow-up-1"]);
    expect(result.wouldCreate[0]?.labels).toEqual(["needs-triage", "external-blocker"]);
    expect(result.counts.skippedRejectedCandidates).toBe(1);
    expect(result.counts.skippedDuplicateGroups).toBe(1);
    expect(result.counts.skippedDuplicateSourceFindings).toBe(2);
    expect(result.counts.skippedMalformed).toBe(1);
  });

  test("approved run creates blocking and follow-up items sequentially", async () => {
    const context = await tempContext({ yes: true });
    const plan = basePlan();
    await writeJsonArtifact(context, "issueCurationPlan", plan);
    const calls: string[][] = [];
    const runner: ProcessRunner = async (args) => {
      calls.push(args);
      return okProcess(`https://github.com/owner/repo/issues/${100 + calls.length}\n`);
    };

    const result = await createIssuesFromCurationPlan({ context, runner, clock });

    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(buildIssueCreateArgv({
      repo: "owner/repo",
      title: "Blocking tracker",
      body: plan.blockingIssuesToCreate[0]?.proposedBody ?? "",
      labels: ["external-blocker"],
    }));
    expect(calls[1]).toContain("follow-up");
    expect(calls[0]?.[calls[0].indexOf("--body") + 1]).toContain("Source issue: #12 Source title");
    expect(calls[0]?.[calls[0].indexOf("--body") + 1]).toContain("Reviewer source(s): review-a");
    expect(result.created.map((entry) => entry.number)).toEqual([101, 102]);
    expect(result.failed).toEqual([]);
    expect(JSON.parse(await readArtifact(context, "issueCreationResults")).created).toHaveLength(2);
  });

  test("records partial failures while preserving successes", async () => {
    const context = await tempContext({ yes: true });
    await writeJsonArtifact(context, "issueCurationPlan", basePlan());
    const runner: ProcessRunner = async (_args) => {
      if (_args.includes("Follow-up tracker")) return { stdout: "", stderr: "rate limited", exitCode: 1 };
      return okProcess("https://github.com/owner/repo/issues/200\n");
    };

    const result = await createIssuesFromCurationPlan({ context, runner, clock });

    expect(result.created.map((entry) => entry.planItemId)).toEqual(["blocking-1"]);
    expect(result.failed).toEqual([{ planItemId: "follow-up-1", kind: "follow-up", title: "Follow-up tracker", message: "rate limited" }]);
    const written = JSON.parse(await readArtifact(context, "issueCreationResults"));
    expect(written.created).toHaveLength(1);
    expect(written.failed).toHaveLength(1);
  });

  test("rerun skips already-created plan item IDs unless forced", async () => {
    const context = await tempContext({ yes: true });
    await writeJsonArtifact(context, "issueCurationPlan", basePlan());
    await writeJsonArtifact(context, "issueCreationResults", {
      version: 1,
      created: [{ planItemId: "blocking-1", kind: "blocking", title: "Blocking tracker", url: "https://github.com/owner/repo/issues/10" }],
    });

    const calls: string[][] = [];
    await createIssuesFromCurationPlan({
      context,
      clock,
      runner: async (args) => {
        calls.push(args);
        return okProcess("https://github.com/owner/repo/issues/11\n");
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("Follow-up tracker");

    const forcedContext = await tempContext({ yes: true, force: true, reuseDir: context.cwd });
    const forcedCalls: string[][] = [];
    await createIssuesFromCurationPlan({
      context: forcedContext,
      clock,
      runner: async (args) => {
        forcedCalls.push(args);
        return okProcess("https://github.com/owner/repo/issues/12\n");
      },
    });
    expect(forcedCalls).toHaveLength(2);
  });
});

async function tempContext(options: { yes: boolean; force?: boolean; reuseDir?: string }) {
  const dir = options.reuseDir ?? await mkdtemp(path.join(tmpdir(), "roark-create-issues-"));
  if (!options.reuseDir) tempDirs.push(dir);
  return createWorkflowContext({
    command: "create-issues",
    issue: "12",
    cwd: dir,
    outDir: ".roark/runs",
    repo: "owner/repo",
    force: options.force ?? false,
    yes: options.yes,
    maxFixPasses: 1,
    attempt: 2,
  });
}

function basePlan(): IssueCurationPlan {
  return {
    version: 1,
    sourceIssue: { number: 12, title: "Source title", url: "https://github.com/owner/repo/issues/12" },
    run: {
      runDirRelative: ".roark/runs/issue/12/attempts/2",
      attempt: 2,
      generatedAt: "2026-05-07T00:00:00.000Z",
      artifactPaths: [".roark/runs/issue/12/attempts/2/review-a.md"],
    },
    blockingIssuesToCreate: [planItem("blocking-1", "Blocking tracker", ["external-blocker"], "blocking")],
    followUpIssuesToCreate: [planItem("follow-up-1", "Follow-up tracker", ["needs-triage", "follow-up"], "follow-up")],
    rejectedCandidates: [{
      sourceFindingIds: ["review-a:S1"],
      reviewerSources: ["review-a"],
      sourceClassifications: ["suggestion"],
      reason: "suggestions are not issue candidates by default",
    }],
    duplicatesMerged: [{
      winningPlanItemId: "follow-up-1",
      mergedSourceFindingIds: ["review-a:F1", "review-b:F1"],
      reviewerSources: ["review-a", "review-b"],
      reason: "same title",
    }],
    warnings: ["parser warning"],
  };
}

function planItem(id: string, title: string, labels: string[], classification: "blocking" | "follow-up"): IssueCurationPlan["blockingIssuesToCreate"][number] {
  return {
    planItemId: id,
    proposedTitle: title,
    proposedBody: `## Source\n- Source issue: #12 Source title (https://github.com/owner/repo/issues/12)\n- Run directory: .roark/runs/issue/12/attempts/2\n- Attempt: 2\n- Source finding IDs: review-a:${id}\n- Reviewer source(s): review-a\n- Classification: ${classification}\n\n## Evidence\n- Concrete evidence\n\n## Impact\nImpact.\n\n## Recommended handling\n- Handle it.\n`,
    sourceFindingIds: [`review-a:${id}`],
    reviewerSources: ["review-a"],
    sourceClassifications: [classification === "blocking" ? "external-blocker" : "follow-up"],
    severitySummary: "severity: high",
    confidenceSummary: "confidence: high",
    evidence: ["Concrete evidence"],
    impact: "Impact.",
    whyBlockingOrNonBlocking: classification === "blocking" ? "Blocking." : "Non-blocking.",
    sourceIssueContext: { number: 12, title: "Source title", url: "https://github.com/owner/repo/issues/12" },
    runContext: {
      runDirRelative: ".roark/runs/issue/12/attempts/2",
      attempt: 2,
      artifactPaths: [".roark/runs/issue/12/attempts/2/review-a.md"],
    },
    proposedLabels: labels,
  };
}

function okProcess(stdout: string): ProcessResult {
  return { stdout, stderr: "", exitCode: 0 };
}
