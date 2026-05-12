import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ProcessResult } from "../cli/process.ts";
import type { AgentRunRequest } from "../workflow/agent-runner.ts";
import { artifactExists, createWorkflowContext, readArtifact, writeJsonArtifact } from "../workflow/artifacts.ts";
import type { IssueCurationPlan } from "../workflow/issue-curation.ts";

import {
  buildIssueCreateArgv,
  createIssuesFromCurationPlan,
  type ProcessRunner,
} from "./create-issues.ts";
import { noopAsync } from "../utils/async.ts";

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
      "needs-human",
      "--label",
      "follow-up",
      "--repo",
      "owner/repo",
    ]);
  });
});

describe("createIssuesFromCurationPlan", () => {
  test("dry-run reports approved plan items without calling GitHub or writing results", async () => {
        await noopAsync();
    const context = await tempContext({ yes: false });
    const plan = basePlan();
    plan.issuesToCreate.push({ planItemId: "bad", proposedTitle: "Bad" } as never);
    await writeJsonArtifact(context, "issueCurationPlan", plan);

    let calls = 0;
    const result = await createIssuesFromCurationPlan({
      context,
      clock,
      runner: async () => {
        await noopAsync();
        calls += 1;
        return okProcess("unexpected");
      },
      agentRunner: async () => {
        await noopAsync();
        throw new Error("dry-run should not invoke an agent");
      },
      skillResolver: async () => {
        await noopAsync();
        throw new Error("dry-run should not resolve skills");
      },
    });

    expect(calls).toBe(0);
    expect(artifactExists(context, "issueCreationResults")).toBe(false);
    expect(result.dryRun).toBe(true);
    expect(result.wouldCreate.map((item) => item.planItemId)).toEqual(["external-blocker-1", "follow-up-1"]);
    expect(result.wouldCreate[0]?.labels).toEqual(["needs-triage", "needs-human", "external-blocker"]);
    expect(result.counts.skippedRejectedCandidates).toBe(1);
    expect(result.counts.skippedDuplicateGroups).toBe(1);
    expect(result.counts.skippedDuplicateSourceFindings).toBe(2);
    expect(result.counts.skippedMalformed).toBe(1);
  });

  test("derives classification labels when proposed labels are incomplete", async () => {
    const context = await tempContext({ yes: false });
    const plan = basePlan();
    const first = plan.issuesToCreate[0];
    if (!first) throw new Error("expected base plan item");
    first.proposedLabels = [];
    await writeJsonArtifact(context, "issueCurationPlan", plan);

    const result = await createIssuesFromCurationPlan({ context, clock });

    expect(result.wouldCreate[0]?.labels).toEqual(["needs-triage", "needs-human", "external-blocker"]);
  });

  test("empty normalized plan does not fall back to legacy arrays", async () => {
    const context = await tempContext({ yes: false });
    const plan = basePlan();
    plan.issuesToCreate = [];
    plan.blockingIssuesToCreate = [planItem("legacy-blocking-1", "Legacy blocking", ["external-blocker"], "external-blocker")];
    await writeJsonArtifact(context, "issueCurationPlan", plan);

    const result = await createIssuesFromCurationPlan({ context, clock });

    expect(result.wouldCreate).toEqual([]);
    expect(result.counts.acceptedPlanItems).toBe(0);
  });

  test("invalid normalized classifications are skipped as malformed instead of defaulting to follow-up", async () => {
    const context = await tempContext({ yes: false });
    const plan = basePlan();
    const invalidItem = planItem("bad-kind-1", "Bad kind", ["follow-up"], "follow-up") as unknown as Record<string, unknown>;
    invalidItem["classification"] = "blocking";
    plan.issuesToCreate = [invalidItem as never];
    await writeJsonArtifact(context, "issueCurationPlan", plan);

    const result = await createIssuesFromCurationPlan({ context, clock });

    expect(result.wouldCreate).toEqual([]);
    expect(result.skipped).toEqual([{
      planItemId: "bad-kind-1",
      kind: "unknown",
      title: "Bad kind",
      reason: "malformed",
      message: "Missing or invalid required field(s): classification. Expected one of: external-blocker, follow-up, suggestion.",
    }]);
    expect(result.counts.acceptedPlanItems).toBe(1);
    expect(result.counts.skippedMalformed).toBe(1);
  });

  test("approved run creates blocking and follow-up items sequentially with an injected process runner", async () => {
    const context = await tempContext({ yes: true });
    const plan = basePlan();
    await writeJsonArtifact(context, "issueCurationPlan", plan);
    const calls: string[][] = [];
    const runner: ProcessRunner = async (args) => {
      await noopAsync();
      calls.push(args);
      return okProcess(`https://github.com/owner/repo/issues/${100 + calls.length}\n`);
    };

    const result = await createIssuesFromCurationPlan({ context, runner, clock });

    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(buildIssueCreateArgv({
      repo: "owner/repo",
      title: "Blocking tracker",
      body: plan.issuesToCreate[0]?.proposedBody ?? "",
      labels: ["external-blocker"],
    }));
    expect(calls[1]).toContain("follow-up");
    expect(calls[0]?.[calls[0].indexOf("--body") + 1]).toContain("Source issue: #12 Source title");
    expect(calls[0]?.[calls[0].indexOf("--body") + 1]).toContain("Reviewer source(s): review-a");
    expect(result.created.map((entry) => entry.number)).toEqual([101, 102]);
    expect(result.failed).toEqual([]);
    expect((JSON.parse(await readArtifact(context, "issueCreationResults")) as { created: unknown[] }).created).toHaveLength(2);
  });

  test("internal approval can publish with label preflight while context.yes is false", async () => {
    const context = await tempContext({ yes: false });
    await writeJsonArtifact(context, "issueCurationPlan", basePlan());
    const ensured: { cwd: string; repo?: string | undefined }[] = [];

    const result = await createIssuesFromCurationPlan({
      context,
      approved: true,
      approvalReason: "autorun PR was opened",
      clock,
      labelEnsurer: async (options) => { await noopAsync(); ensured.push(options); },
      skillResolver: async (cwd) => (await noopAsync(), path.join(cwd, "skills", "github-issue-create")),
      agentRunner: async (request) => {
        await noopAsync();
        expect(request.prompt).toContain("autorun PR was opened");
        return JSON.stringify({
          created: [
            { planItemId: "external-blocker-1", url: "https://github.com/owner/repo/issues/300", number: 300 },
            { planItemId: "follow-up-1", url: "https://github.com/owner/repo/issues/301", number: 301 },
          ],
          failed: [],
          relationshipOutcomes: [],
        });
      },
    });

    expect(ensured).toEqual([{ cwd: context.agentCwd, repo: "owner/repo" }]);
    expect(result.approved).toBe(true);
    expect(result.dryRun).toBe(false);
    expect(result.created.map((entry) => entry.planItemId)).toEqual(["external-blocker-1", "follow-up-1"]);
  });

  test("approved run uses the resolved issue-create skill through the agent runner", async () => {
        await noopAsync();
    const context = await tempContext({ yes: true });
    await writeJsonArtifact(context, "issueCurationPlan", basePlan());
    const requests: AgentRunRequest[] = [];

    const result = await createIssuesFromCurationPlan({
      context,
      clock,
      labelEnsurer: false,
      skillResolver: async (cwd) => (await noopAsync(), path.join(cwd, "skills", "github-issue-create")),
      agentRunner: async (request) => {
        await noopAsync();
        requests.push(request);
        return JSON.stringify({
          created: [
            { planItemId: "external-blocker-1", url: "https://github.com/owner/repo/issues/300", number: 300 },
            { planItemId: "follow-up-1", url: "https://github.com/owner/repo/issues/301", number: 301 },
          ],
          failed: [],
          relationshipOutcomes: [{ planItemId: "external-blocker-1", status: "not-requested", message: "No native relationship was requested for this plan item." }],
        });
      },
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.skillPaths).toEqual([path.join(context.agentCwd, "skills", "github-issue-create")]);
    expect(requests[0]?.writable).toBe(false);
    expect(requests[0]?.prompt).toContain("Read and follow the available `github-issue-create` skill");
    expect(requests[0]?.prompt).toContain("external-blocker-1");
    expect(result.created.map((entry) => entry.number)).toEqual([300, 301]);
    expect(result.relationshipOutcomes).toEqual([{ planItemId: "external-blocker-1", status: "not-requested", message: "No native relationship was requested for this plan item." }]);
  });

  test("approved publishing agent prompt uses artifact paths visible from a split agent workspace", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "roark-create-issues-split-"));
    tempDirs.push(root);
    const controlCwd = path.join(root, "control");
    const agentCwd = path.join(root, "agent");
    const context = await tempContext({ yes: true, reuseDir: controlCwd, agentCwd });
    await writeJsonArtifact(context, "issueCurationPlan", basePlan());
    const requests: AgentRunRequest[] = [];

    await createIssuesFromCurationPlan({
      context,
      clock,
      labelEnsurer: false,
      skillResolver: async (cwd) => (await noopAsync(), path.join(cwd, "skills", "github-issue-create")),
      agentRunner: async (request) => {
        await noopAsync();
        requests.push(request);
        return JSON.stringify({
          created: [
            { planItemId: "external-blocker-1", url: "https://github.com/owner/repo/issues/300", number: 300 },
            { planItemId: "follow-up-1", url: "https://github.com/owner/repo/issues/301", number: 301 },
          ],
          failed: [],
          relationshipOutcomes: [],
        });
      },
    });

    const expectedPlanPath = path.join("..", "control", ".roark", "runs", "issue", "12", "attempts", "2", "issue-curation-plan.json");
    const expectedResultPath = path.join("..", "control", ".roark", "runs", "issue", "12", "attempts", "2", "issue-creation-results.json");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.cwd).toBe(agentCwd);
    expect(requests[0]?.prompt).toContain(`The curation plan at \`${expectedPlanPath}\``);
    expect(requests[0]?.prompt).toContain(`Roark will write \`${expectedResultPath}\``);
  });

  test("approved publishing agent uses centralized thinking profiles", async () => {
        await noopAsync();
    for (const [profile, expected] of [["fast", "low"], ["deep", "high"]] as const) {
      const context = await tempContext({ yes: true, thinkingProfile: profile });
      await writeJsonArtifact(context, "issueCurationPlan", basePlan());
      const thinkingLevels: string[] = [];

      await createIssuesFromCurationPlan({
        context,
        clock,
        labelEnsurer: false,
        skillResolver: async (cwd) => (await noopAsync(), path.join(cwd, "skills", "github-issue-create")),
        agentRunner: async (request) => {
        await noopAsync();
          thinkingLevels.push(request.thinkingLevel);
          return JSON.stringify({
            created: [
              { planItemId: "external-blocker-1", url: "https://github.com/owner/repo/issues/300", number: 300 },
              { planItemId: "follow-up-1", url: "https://github.com/owner/repo/issues/301", number: 301 },
            ],
            failed: [],
            relationshipOutcomes: [],
          });
        },
      });

      expect(thinkingLevels).toEqual([expected]);
    }
  });

  test("approved agent response must cover every creatable plan item exactly once", async () => {
  await noopAsync();
    const context = await tempContext({ yes: true });
    await writeJsonArtifact(context, "issueCurationPlan", basePlan());

    const result = await createIssuesFromCurationPlan({
      context,
      clock,
      labelEnsurer: false,
      skillResolver: async (cwd) => (await noopAsync(), path.join(cwd, "skills", "github-issue-create")),
      agentRunner: async () => (await noopAsync(), JSON.stringify({
        created: [{ planItemId: "external-blocker-1", url: "https://github.com/owner/repo/issues/300", number: 300 }],
        failed: [],
        relationshipOutcomes: [],
      })),
    });

    expect(result.created).toEqual([]);
    expect(result.failed).toHaveLength(2);
    expect(result.failed[0]?.message).toContain("omitted result for planItemId(s): follow-up-1");
  });

  test("approved agent response rejects duplicate plan item results", async () => {
        await noopAsync();
    const context = await tempContext({ yes: true });
    await writeJsonArtifact(context, "issueCurationPlan", basePlan());

    const result = await createIssuesFromCurationPlan({
      context,
      clock,
      labelEnsurer: false,
      skillResolver: async (cwd) => (await noopAsync(), path.join(cwd, "skills", "github-issue-create")),
      agentRunner: async () => (await noopAsync(), JSON.stringify({
        created: [{ planItemId: "external-blocker-1", url: "https://github.com/owner/repo/issues/300", number: 300 }],
        failed: [
          { planItemId: "external-blocker-1", message: "duplicate status" },
          { planItemId: "follow-up-1", message: "not created" },
        ],
        relationshipOutcomes: [],
      })),
    });

    expect(result.created).toEqual([]);
    expect(result.failed).toHaveLength(2);
    expect(result.failed[0]?.message).toContain("duplicate result for planItemId(s): external-blocker-1");
  });

  test("approved agent relationship outcomes must reference approved plan items with status and message", async () => {
        await noopAsync();
    const context = await tempContext({ yes: true });
    await writeJsonArtifact(context, "issueCurationPlan", basePlan());

    const result = await createIssuesFromCurationPlan({
      context,
      clock,
      labelEnsurer: false,
      skillResolver: async (cwd) => (await noopAsync(), path.join(cwd, "skills", "github-issue-create")),
      agentRunner: async () => (await noopAsync(), JSON.stringify({
        created: [
          { planItemId: "external-blocker-1", url: "https://github.com/owner/repo/issues/300", number: 300 },
          { planItemId: "follow-up-1", url: "https://github.com/owner/repo/issues/301", number: 301 },
        ],
        failed: [],
        relationshipOutcomes: [{ planItemId: "outside-plan", status: "created", message: "Created a relationship." }],
      })),
    });

    expect(result.created).toEqual([]);
    expect(result.failed).toHaveLength(2);
    expect(result.failed[0]?.message).toContain("unknown relationship outcome planItemId 'outside-plan'");
  });

  test("approved agent relationship outcomes must include status and message", async () => {
        await noopAsync();
    const context = await tempContext({ yes: true });
    await writeJsonArtifact(context, "issueCurationPlan", basePlan());

    const result = await createIssuesFromCurationPlan({
      context,
      clock,
      labelEnsurer: false,
      skillResolver: async (cwd) => (await noopAsync(), path.join(cwd, "skills", "github-issue-create")),
      agentRunner: async () => (await noopAsync(), JSON.stringify({
        created: [
          { planItemId: "external-blocker-1", url: "https://github.com/owner/repo/issues/300", number: 300 },
          { planItemId: "follow-up-1", url: "https://github.com/owner/repo/issues/301", number: 301 },
        ],
        failed: [],
        relationshipOutcomes: [{ planItemId: "external-blocker-1", status: "created" }],
      })),
    });

    expect(result.failed).toHaveLength(2);
    expect(result.failed[0]?.message).toContain("without a non-empty message");
  });

  test("missing resolved skill fails before invoking the publishing agent", async () => {
  await noopAsync();
    const context = await tempContext({ yes: true });
    await writeJsonArtifact(context, "issueCurationPlan", basePlan());
    let agentCalls = 0;

    expect(createIssuesFromCurationPlan({
      context,
      clock,
      labelEnsurer: false,
      skillResolver: async () => {
        await noopAsync();
        throw new Error("Repo override skill 'github-issue-create' is missing or incomplete at /repo/.roark/skills/github-issue-create: missing SKILL.md.");
      },
      agentRunner: async () => {
        await noopAsync();
        agentCalls += 1;
        return "{}";
      },
    })).rejects.toThrow("Repo override skill 'github-issue-create' is missing or incomplete");
    expect(agentCalls).toBe(0);
    expect(artifactExists(context, "issueCreationResults")).toBe(false);
  });

  test("records partial failures from an injected process runner while preserving successes", async () => {
        await noopAsync();
    const context = await tempContext({ yes: true });
    await writeJsonArtifact(context, "issueCurationPlan", basePlan());
    const runner: ProcessRunner = async (_args) => {
      await noopAsync();
      if (_args.includes("Follow-up tracker")) return { stdout: "", stderr: "rate limited", exitCode: 1 };
      return okProcess("https://github.com/owner/repo/issues/200\n");
    };

    const result = await createIssuesFromCurationPlan({ context, runner, clock });

    expect(result.created.map((entry) => entry.planItemId)).toEqual(["external-blocker-1"]);
    expect(result.failed).toEqual([{ planItemId: "follow-up-1", kind: "follow-up", title: "Follow-up tracker", message: "rate limited" }]);
    const written = JSON.parse(await readArtifact(context, "issueCreationResults")) as { created: unknown[]; failed: unknown[] };
    expect(written.created).toHaveLength(1);
    expect(written.failed).toHaveLength(1);
  });

  test("rerun skips already-created plan item IDs unless forced", async () => {
        await noopAsync();
    const context = await tempContext({ yes: true });
    await writeJsonArtifact(context, "issueCurationPlan", basePlan());
    await writeJsonArtifact(context, "issueCreationResults", {
      version: 1,
      created: [{ planItemId: "external-blocker-1", kind: "external-blocker", title: "Blocking tracker", url: "https://github.com/owner/repo/issues/10" }],
    });

    const calls: string[][] = [];
    await createIssuesFromCurationPlan({
      context,
      clock,
      runner: async (args) => {
        await noopAsync();
        calls.push(args);
        return okProcess("https://github.com/owner/repo/issues/11\n");
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("Follow-up tracker");

    const forcedContext = await tempContext({ yes: true, force: true, reuseDir: context.controlCwd });
    const forcedCalls: string[][] = [];
    await createIssuesFromCurationPlan({
      context: forcedContext,
      clock,
      runner: async (args) => {
        await noopAsync();
        forcedCalls.push(args);
        return okProcess("https://github.com/owner/repo/issues/12\n");
      },
    });
    expect(forcedCalls).toHaveLength(2);
  });
});

async function tempContext(options: { yes: boolean; force?: boolean; reuseDir?: string; agentCwd?: string | undefined; thinkingProfile?: "fast" | "deep"  | undefined}) {
  const dir = options.reuseDir ?? await mkdtemp(path.join(tmpdir(), "roark-create-issues-"));
  if (!options.reuseDir) tempDirs.push(dir);
  return createWorkflowContext({
    command: "create-issues",
    issue: "12",
    cwd: dir,
    outDir: ".roark/runs",
    repo: "owner/repo",
    thinkingProfile: options.thinkingProfile,
    force: options.force ?? false,
    yes: options.yes,
    maxFixPasses: 1,
    attempt: 2,
  }, options.agentCwd ? { agentCwd: options.agentCwd } : {});
}

function basePlan(): IssueCurationPlan {
  return {
    version: 2,
    sourceIssue: { number: 12, title: "Source title", url: "https://github.com/owner/repo/issues/12" },
    run: {
      runDirRelative: ".roark/runs/issue/12/attempts/2",
      attempt: 2,
      generatedAt: "2026-05-07T00:00:00.000Z",
      artifactPaths: [".roark/runs/issue/12/attempts/2/review-a.md"],
    },
    issuesToCreate: [
      planItem("external-blocker-1", "Blocking tracker", ["needs-triage", "needs-human", "external-blocker"], "external-blocker"),
      planItem("follow-up-1", "Follow-up tracker", ["needs-triage", "needs-human", "follow-up"], "follow-up"),
    ],
    rejectedCandidates: [{
      sourceFindingIds: ["review-a:S1"],
      reviewerSources: ["review-a"],
      sourceClassifications: ["suggestion"],
      reason: "missing concrete evidence",
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

function planItem(id: string, title: string, labels: string[], classification: "external-blocker" | "follow-up"): IssueCurationPlan["issuesToCreate"][number] {
  return {
    planItemId: id,
    classification,
    proposedTitle: title,
    proposedBody: `## Source\n- Source issue: #12 Source title (https://github.com/owner/repo/issues/12)\n- Run directory: .roark/runs/issue/12/attempts/2\n- Attempt: 2\n- Source finding IDs: review-a:${id}\n- Reviewer source(s): review-a\n- Classification: ${classification}\n\n## Evidence\n- Concrete evidence\n\n## Impact\nImpact.\n\n## Recommended handling\n- Handle it.\n`,
    sourceFindingIds: [`review-a:${id}`],
    reviewerSources: ["review-a"],
    sourceClassifications: [classification],
    severitySummary: "severity: high",
    confidenceSummary: "confidence: high",
    evidence: ["Concrete evidence"],
    impact: "Impact.",
    recommendedHandling: ["Handle it."],
    whyBlockingOrNonBlocking: classification === "external-blocker" ? "Blocking." : "Non-blocking.",
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
