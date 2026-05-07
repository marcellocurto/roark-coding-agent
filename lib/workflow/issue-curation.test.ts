import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { artifactExists, createWorkflowContext, finalReviewRef, fixLogRef, readArtifact, writeArtifact, type WorkflowContext } from "./artifacts.ts";
import { buildIssueCurationPlan } from "./issue-curation.ts";
import { runSinglePhase } from "./phases.ts";

const tempDirs: string[] = [];
const fixedClock = { now: () => new Date("2026-05-06T12:00:00.000Z") };

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempContext(): Promise<WorkflowContext> {
  const dir = await mkdtemp(path.join(tmpdir(), "roark-curation-"));
  tempDirs.push(dir);
  const context = createWorkflowContext({
    command: "curate-issues",
    issue: "42",
    cwd: dir,
    outDir: ".roark/runs",
    repo: "owner/repo",
    force: false,
    yes: true,
    maxFixPasses: 1,
    attempt: 2,
  });
  await writeArtifact(context, "issue", `<github_issue number="42">\n  <title>Source issue title</title>\n  <url>https://github.com/owner/repo/issues/42</url>\n</github_issue>`);
  return context;
}

describe("buildIssueCurationPlan", () => {
  test("no reviewer findings produces an empty plan without crashing", async () => {
    const context = await tempContext();
    await writeArtifact(context, "reviewA", reviewWithLedger("None"));
    await writeArtifact(context, "reviewB", reviewWithLedger("None"));

    const plan = await buildIssueCurationPlan(context, fixedClock);

    expect(plan).toMatchObject({
      version: 1,
      sourceIssue: {
        number: 42,
        title: "Source issue title",
        url: "https://github.com/owner/repo/issues/42",
      },
      run: {
        runDirRelative: ".roark/runs/issue/42/attempts/2",
        attempt: 2,
        generatedAt: "2026-05-06T12:00:00.000Z",
      },
      blockingIssuesToCreate: [],
      followUpIssuesToCreate: [],
      rejectedCandidates: [],
      duplicatesMerged: [],
    });
    expect(plan.run.artifactPaths).toContain(".roark/runs/issue/42/attempts/2/issue.md");
  });

  test("one actionable follow-up produces a follow-up issue item", async () => {
    const context = await tempContext();
    await writeArtifact(context, "reviewA", reviewWithLedger(finding("F1", "follow-up", {
      title: "Document retry edge case",
      suggestedIssueTitle: "Document retry edge case for users",
      evidence: "src/retry.ts:17 demonstrates the missing user-facing description.",
      impact: "Future users cannot understand how retry exhaustion is reported.",
      handling: "Add focused documentation for retry exhaustion behavior.",
    })));
    await writeArtifact(context, "reviewB", reviewWithLedger("None"));

    const plan = await buildIssueCurationPlan(context, fixedClock);

    expect(plan.blockingIssuesToCreate).toEqual([]);
    expect(plan.followUpIssuesToCreate).toHaveLength(1);
    const item = plan.followUpIssuesToCreate[0];
    expect(item?.planItemId).toBe("follow-up-1");
    expect(item?.proposedTitle).toBe("Document retry edge case for users");
    expect(item?.proposedLabels).toContain("needs-triage");
    expect(item?.sourceFindingIds).toEqual(["review-a:F1"]);
    expect(item?.proposedBody).toContain("## Non-goals");
    expect(item?.proposedBody).toContain("Source issue: #42 Source issue title");
  });

  test("one actionable external-blocker produces a blocking issue item", async () => {
    const context = await tempContext();
    await writeArtifact(context, "reviewA", reviewWithLedger(finding("B1", "external-blocker", {
      title: "Missing prerequisite API token fixture",
      evidence: "tests/fixtures/token.json:1 is required but absent from the repository.",
      impact: "The current issue cannot be validated until the prerequisite fixture exists.",
      handling: "Create a separate prerequisite issue to define and provide the fixture.",
    })));
    await writeArtifact(context, "reviewB", reviewWithLedger("None"));

    const plan = await buildIssueCurationPlan(context, fixedClock);

    expect(plan.blockingIssuesToCreate).toHaveLength(1);
    expect(plan.followUpIssuesToCreate).toEqual([]);
    const item = plan.blockingIssuesToCreate[0];
    expect(item?.planItemId).toBe("blocking-1");
    expect(item?.proposedLabels).toEqual(["needs-triage", "external-blocker"]);
    expect(item?.whyBlockingOrNonBlocking).toContain("Blocking");
  });

  test("suggestion and must-fix-current findings are rejected by default", async () => {
    const context = await tempContext();
    await writeArtifact(context, "reviewA", reviewWithLedger(`${finding("S1", "suggestion")}\n${finding("M1", "must-fix-current")}`));
    await writeArtifact(context, "reviewB", reviewWithLedger("None"));

    const plan = await buildIssueCurationPlan(context, fixedClock);

    expect(plan.followUpIssuesToCreate).toEqual([]);
    expect(plan.blockingIssuesToCreate).toEqual([]);
    expect(plan.rejectedCandidates.map((candidate) => candidate.sourceFindingIds[0])).toEqual(["review-a:S1", "review-a:M1"]);
    expect(plan.rejectedCandidates[0]?.reason).toContain("suggestions are not issue candidates");
    expect(plan.rejectedCandidates[1]?.reason).toContain("current issue/fix pass");
  });

  test("missing evidence causes rejection", async () => {
    const context = await tempContext();
    await writeArtifact(context, "reviewA", reviewWithLedger(finding("F1", "follow-up", { evidence: "unspecified" })));
    await writeArtifact(context, "reviewB", reviewWithLedger("None"));

    const plan = await buildIssueCurationPlan(context, fixedClock);

    expect(plan.followUpIssuesToCreate).toEqual([]);
    expect(plan.rejectedCandidates).toHaveLength(1);
    expect(plan.rejectedCandidates[0]?.reason).toBe("missing concrete evidence");
  });

  test("vague or speculative candidates are rejected", async () => {
    const context = await tempContext();
    await writeArtifact(context, "reviewA", reviewWithLedger(finding("F1", "follow-up", {
      title: "Maybe improve unclear behavior",
      evidence: "src/flow.ts:9 shows the behavior under discussion.",
      impact: "Future users might encounter confusing output.",
      handling: "Investigate the behavior and decide whether anything should change.",
    })));
    await writeArtifact(context, "reviewB", reviewWithLedger("None"));

    const plan = await buildIssueCurationPlan(context, fixedClock);

    expect(plan.followUpIssuesToCreate).toEqual([]);
    expect(plan.rejectedCandidates[0]?.reason).toBe("vague or speculative candidate");
  });

  test("duplicate Review A/B findings merge into one proposed item preserving sources and evidence", async () => {
    const context = await tempContext();
    await writeArtifact(context, "reviewA", reviewWithLedger(finding("F1", "follow-up", {
      title: "Document cache invalidation behavior",
      evidence: "src/cache.ts:12 does not describe invalidation behavior.",
      impact: "Future users cannot predict cache refresh timing.",
      handling: "Document cache invalidation behavior in the user guide.",
    })));
    await writeArtifact(context, "reviewB", reviewWithLedger(finding("G1", "follow-up", {
      title: "Document cache invalidation behavior",
      evidence: "README.md:44 omits cache invalidation guidance.",
      impact: "Future users cannot predict cache refresh timing.",
      handling: "Add a focused cache invalidation follow-up issue.",
    })));

    const plan = await buildIssueCurationPlan(context, fixedClock);

    expect(plan.followUpIssuesToCreate).toHaveLength(1);
    const item = plan.followUpIssuesToCreate[0];
    expect(item?.sourceFindingIds).toEqual(["review-a:F1", "review-b:G1"]);
    expect(item?.reviewerSources).toEqual(["review-a", "review-b"]);
    expect(item?.evidence).toEqual([
      "src/cache.ts:12 does not describe invalidation behavior.",
      "README.md:44 omits cache invalidation guidance.",
    ]);
    expect(plan.duplicatesMerged).toEqual([
      {
        winningPlanItemId: "follow-up-1",
        mergedSourceFindingIds: ["review-a:F1", "review-b:G1"],
        reviewerSources: ["review-a", "review-b"],
        reason: "Merged findings with the same classification and matching normalized title or evidence reference.",
      },
    ]);
  });

  test("unrelated findings with the same generic impact remain separate", async () => {
    const context = await tempContext();
    await writeArtifact(context, "reviewA", reviewWithLedger(finding("F1", "follow-up", {
      title: "Document retry exhaustion behavior",
      evidence: "src/retry.ts:17 does not describe retry exhaustion behavior.",
      impact: "Future users encounter a concrete gap.",
      handling: "Document retry exhaustion behavior for future users.",
    })));
    await writeArtifact(context, "reviewB", reviewWithLedger(finding("G1", "follow-up", {
      title: "Add timeout configuration examples",
      evidence: "README.md:44 omits timeout configuration examples.",
      impact: "Future users encounter a concrete gap.",
      handling: "Add focused timeout configuration examples.",
    })));

    const plan = await buildIssueCurationPlan(context, fixedClock);

    expect(plan.followUpIssuesToCreate).toHaveLength(2);
    expect(plan.followUpIssuesToCreate.map((item) => item.sourceFindingIds)).toEqual([
      ["review-b:G1"],
      ["review-a:F1"],
    ]);
    expect(plan.duplicatesMerged).toEqual([]);
  });

  test("metadata supplies stable source issue and run context", async () => {
    const context = await tempContext();
    await writeArtifact(context, "metadata", JSON.stringify({
      issueNumber: 42,
      repo: "owner/repo",
      issue: { number: 42, title: "Metadata issue title", html_url: "https://github.com/owner/repo/issues/42" },
    }));
    await writeArtifact(context, "implementationLog", "# Implementation Log\n");
    await writeArtifact(context, "reviewA", reviewWithLedger(finding("F1", "follow-up")));
    await writeArtifact(context, "reviewB", reviewWithLedger("None"));

    const plan = await buildIssueCurationPlan(context, fixedClock);
    const item = plan.followUpIssuesToCreate[0];

    expect(plan.sourceIssue.title).toBe("Metadata issue title");
    expect(plan.run.generatedAt).toBe("2026-05-06T12:00:00.000Z");
    expect(item?.sourceIssueContext).toEqual(plan.sourceIssue);
    expect(item?.runContext.artifactPaths).toContain(".roark/runs/issue/42/attempts/2/implementation-log.md");
  });

  test("available artifact paths include catalog static refs and numbered refs", async () => {
    const context = await tempContext();
    await writeArtifact(context, "metadata", "{}\n");
    await writeArtifact(context, "triage", "# Triage\n");
    await writeArtifact(context, "reviewA", reviewWithLedger("None"));
    await writeArtifact(context, "reviewB", reviewWithLedger("None"));
    await writeArtifact(context, fixLogRef(1), "# Fix Log Pass 1\n");
    await writeArtifact(context, finalReviewRef(1), "# Final Review Pass 1\n\n## Verdict\nready-for-pr\n");

    const plan = await buildIssueCurationPlan(context, fixedClock);

    expect(plan.run.artifactPaths).toEqual([
      ".roark/runs/issue/42/attempts/2/issue.md",
      ".roark/runs/issue/42/attempts/2/metadata.json",
      ".roark/runs/issue/42/attempts/2/triage.md",
      ".roark/runs/issue/42/attempts/2/review-a.md",
      ".roark/runs/issue/42/attempts/2/review-b.md",
      ".roark/runs/issue/42/attempts/2/fix-log-1.md",
      ".roark/runs/issue/42/attempts/2/final-review-1.md",
    ]);
  });
});

describe("issue curation phase", () => {
  test("runSinglePhase writes issue-curation-plan.json without using an agent", async () => {
    const context = await tempContext();
    await writeArtifact(context, "reviewA", reviewWithLedger(finding("F1", "follow-up")));
    await writeArtifact(context, "reviewB", reviewWithLedger("None"));

    await runSinglePhase(context, "curate-issues", async () => {
      throw new Error("curation should not invoke an agent");
    });

    expect(artifactExists(context, "issueCurationPlan")).toBe(true);
    const raw = await readArtifact(context, "issueCurationPlan");
    const plan = JSON.parse(raw) as { followUpIssuesToCreate: unknown[] };
    expect(plan.followUpIssuesToCreate).toHaveLength(1);
  });
});

function reviewWithLedger(entries: string): string {
  return `# Review\n\n## Verdict\napprove\n\n## Findings Ledger\n${entries}\n\n## Validation Reviewed\nTests.\n`;
}

function finding(
  id: string,
  classification: string,
  overrides: Partial<{
    title: string;
    severity: string;
    confidence: string;
    evidence: string;
    impact: string;
    handling: string;
    suggestedIssueTitle: string;
  }> = {},
): string {
  const suggestedIssueTitle = overrides.suggestedIssueTitle === undefined
    ? ""
    : `- Suggested issue title: ${overrides.suggestedIssueTitle}\n`;
  return `- Identifier: ${id}\n- Classification: ${classification}\n- Title: ${overrides.title ?? `Finding ${id}`}\n- Severity: ${overrides.severity ?? "medium"}\n- Confidence: ${overrides.confidence ?? "high"}\n- Evidence: ${overrides.evidence ?? "src/example.ts:1 shows concrete behavior."}\n- Current-issue impact: ${overrides.impact ?? "Future users encounter a concrete gap."}\n- Recommended handling: ${overrides.handling ?? "Create a focused follow-up issue for this gap."}\n${suggestedIssueTitle}`;
}
