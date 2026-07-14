import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentRunRequest } from "../workflow/agent-runner.ts";
import { artifactExists, createWorkflowContext, readArtifact, writeJsonArtifact } from "../workflow/artifacts.ts";
import type { IssueCurationPlan } from "../workflow/issue-curation.ts";
import { configurePresenter } from "../presentation/presenter.ts";
import type { TerminalStream } from "../presentation/terminal.ts";

import { createIssuesFromCurationPlan } from "./create-issues.ts";
import { noopAsync } from "../utils/async.ts";

const tempDirs: string[] = [];
const clock = { now: () => new Date("2026-05-07T00:00:00.000Z") };

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("createIssuesFromCurationPlan", () => {
  test("dry-run reports approved plan items without calling GitHub or writing results", async () => {
        await noopAsync();
    const context = await tempContext({ yes: false });
    const plan = basePlan();
    plan.issuesToCreate.push({ planItemId: "bad", proposedTitle: "Bad" } as never);
    await writeJsonArtifact(context, "issueCurationPlan", plan);

    const result = await createIssuesFromCurationPlan({
      context,
      clock,
      agentRunner: async () => {
        await noopAsync();
        throw new Error("dry-run should not invoke an agent");
      },
    });

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

  test("preserves the parent workflow command in issue-publishing display context", async () => {
    const context = await tempContext({ yes: true, displayCommand: "auto" });
    await writeJsonArtifact(context, "issueCurationPlan", basePlan());
    let displayCommand: string | undefined;

    await createIssuesFromCurationPlan({
      context,
      clock,
      labelEnsurer: false,
      agentRunner: async (request) => {
        await noopAsync();
        displayCommand = request.display.command;
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

    expect(displayCommand).toBe("auto");
  });

  test("approved run uses the issue-authoring publishing agent without loading a skill", async () => {
        await noopAsync();
    const context = await tempContext({ yes: true });
    await writeJsonArtifact(context, "issueCurationPlan", basePlan());
    const requests: AgentRunRequest[] = [];

    const result = await createIssuesFromCurationPlan({
      context,
      clock,
      labelEnsurer: false,
      agentRunner: async (request) => {
        await noopAsync();
        requests.push(request);
        return JSON.stringify({
          created: [
            { planItemId: "external-blocker-1", title: "Clear blocker title", url: "https://github.com/owner/repo/issues/300", number: 300 },
            { planItemId: "follow-up-1", url: "https://github.com/owner/repo/issues/301", number: 301 },
          ],
          failed: [],
          relationshipOutcomes: [{ planItemId: "external-blocker-1", status: "not-requested", message: "No native relationship was requested for this plan item." }],
        });
      },
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.skillPaths).toBeUndefined();
    expect(requests[0]?.fileEditingToolsEnabled).toBe(false);
    expect(requests[0]?.prompt).toContain("write the final GitHub issue title and body yourself");
    expect(requests[0]?.prompt).toContain("Do not copy the plan's proposedBody as the final body");
    expect(requests[0]?.prompt).toContain("external-blocker-1");
    expect(result.created.map((entry) => entry.number)).toEqual([300, 301]);
    expect(result.created[0]?.title).toBe("Clear blocker title");
    expect(result.relationshipOutcomes).toEqual([{ planItemId: "external-blocker-1", status: "not-requested", message: "No native relationship was requested for this plan item." }]);
  });

  test("publishing context names the result artifact and completes only after it is persisted", async () => {
    const context = await tempContext({ yes: true });
    await writeJsonArtifact(context, "issueCurationPlan", basePlan());
    const resultPath = path.join(context.runDir, "issue-creation-results.json");
    let persistedAtCompletion = false;
    let expectedArtifact: string | undefined;
    const stream: TerminalStream = {
      isTTY: false,
      columns: 80,
      write(chunk) {
        if (chunk.startsWith("DONE #12 · Author and create issues")) persistedAtCompletion = existsSync(resultPath);
      },
    };
    configurePresenter({ stream });

    try {
      await createIssuesFromCurationPlan({
        context,
        clock,
        labelEnsurer: false,
        agentRunner: async (request) => {
          await noopAsync();
          expectedArtifact = request.display.expectedArtifact;
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
    } finally {
      configurePresenter({});
    }

    expect(expectedArtifact).toBe(".roark/runs/issue/12/attempts/2/issue-creation-results.json");
    expect(persistedAtCompletion).toBe(true);
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

  test("approved publishing agent uses the issue-publishing thinking stage", async () => {
    await noopAsync();
    const context = await tempContext({ yes: true });
    context.thinkingConfig.issuePublishing = "minimal";
    await writeJsonArtifact(context, "issueCurationPlan", basePlan());
    const thinkingLevels: string[] = [];

    await createIssuesFromCurationPlan({
      context,
      clock,
      labelEnsurer: false,
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

    expect(thinkingLevels).toEqual(["minimal"]);
  });

  test("approved agent response must cover every creatable plan item exactly once", async () => {
  await noopAsync();
    const context = await tempContext({ yes: true });
    await writeJsonArtifact(context, "issueCurationPlan", basePlan());

    const result = await createIssuesFromCurationPlan({
      context,
      clock,
      labelEnsurer: false,
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

  test("publishing agent failures are recorded for every creatable issue", async () => {
  await noopAsync();
    const context = await tempContext({ yes: true });
    await writeJsonArtifact(context, "issueCurationPlan", basePlan());
    let agentCalls = 0;

    const result = await createIssuesFromCurationPlan({
      context,
      clock,
      labelEnsurer: false,
      agentRunner: async () => {
        await noopAsync();
        agentCalls += 1;
        throw new Error("publishing agent failed");
      },
    });

    expect(agentCalls).toBe(1);
    expect(result.created).toEqual([]);
    expect(result.failed).toHaveLength(2);
    expect(result.failed[0]?.message).toBe("publishing agent failed");
    expect(artifactExists(context, "issueCreationResults")).toBe(true);
  });

  test("records partial agent-publishing failures while preserving successes", async () => {
    const context = await tempContext({ yes: true });
    await writeJsonArtifact(context, "issueCurationPlan", basePlan());

    const result = await createIssuesFromCurationPlan({
      context,
      clock,
      labelEnsurer: false,
      agentRunner: async () => {
        await noopAsync();
        return JSON.stringify({
          created: [{ planItemId: "external-blocker-1", url: "https://github.com/owner/repo/issues/200", number: 200 }],
          failed: [{ planItemId: "follow-up-1", message: "rate limited" }],
          relationshipOutcomes: [],
        });
      },
    });

    expect(result.created.map((entry) => entry.planItemId)).toEqual(["external-blocker-1"]);
    expect(result.failed).toEqual([{ planItemId: "follow-up-1", kind: "follow-up", title: "Follow-up tracker", message: "rate limited" }]);
    const written = JSON.parse(await readArtifact(context, "issueCreationResults")) as { created: unknown[]; failed: unknown[] };
    expect(written.created).toHaveLength(1);
    expect(written.failed).toHaveLength(1);
  });

  test("rerun skips already-created plan item IDs unless forced", async () => {
    const context = await tempContext({ yes: true });
    await writeJsonArtifact(context, "issueCurationPlan", basePlan());
    await writeJsonArtifact(context, "issueCreationResults", {
      version: 1,
      created: [{ planItemId: "external-blocker-1", kind: "external-blocker", title: "Blocking tracker", url: "https://github.com/owner/repo/issues/10" }],
    });

    let agentCalls = 0;
    const rerun = await createIssuesFromCurationPlan({
      context,
      clock,
      labelEnsurer: false,
      agentRunner: async () => {
        await noopAsync();
        agentCalls += 1;
        return JSON.stringify({
          created: [{ planItemId: "follow-up-1", url: "https://github.com/owner/repo/issues/11", number: 11 }],
          failed: [],
          relationshipOutcomes: [],
        });
      },
    });
    expect(agentCalls).toBe(1);
    expect(rerun.created.filter((entry) => entry.source === "current-run").map((entry) => entry.planItemId)).toEqual(["follow-up-1"]);
    expect(rerun.skipped.map((entry) => entry.planItemId)).toContain("external-blocker-1");

    const forcedContext = await tempContext({ yes: true, force: true, reuseDir: context.controlCwd });
    let forcedAgentCalls = 0;
    const forced = await createIssuesFromCurationPlan({
      context: forcedContext,
      clock,
      labelEnsurer: false,
      agentRunner: async () => {
        await noopAsync();
        forcedAgentCalls += 1;
        return JSON.stringify({
          created: [
            { planItemId: "external-blocker-1", url: "https://github.com/owner/repo/issues/12", number: 12 },
            { planItemId: "follow-up-1", url: "https://github.com/owner/repo/issues/13", number: 13 },
          ],
          failed: [],
          relationshipOutcomes: [],
        });
      },
    });
    expect(forcedAgentCalls).toBe(1);
    expect(forced.counts.createdCurrentRun).toBe(2);
  });
});

async function tempContext(options: { yes: boolean; force?: boolean; reuseDir?: string; agentCwd?: string | undefined; displayCommand?: string | undefined }) {
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
  }, {
    ...(options.agentCwd ? { agentCwd: options.agentCwd } : {}),
    ...(options.displayCommand ? { displayCommand: options.displayCommand } : {}),
  });
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
