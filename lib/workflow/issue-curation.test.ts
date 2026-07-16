import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { artifactExists, createWorkflowContext, fixLogRef, readArtifact, reviewARef, reviewBRef, writeArtifact, writeJsonArtifact, type WorkflowContext } from "./artifacts.ts";
import { buildIssueCurationPlan } from "./issue-curation.ts";
import { runSinglePhase } from "./phases.ts";
import { noopAsync } from "../utils/async.ts";
import { reviewFinding, reviewResult } from "../testing/reviews.ts";
import type { FindingConfidence, FindingSeverity, ReviewConcernClassification, ReviewFinding } from "../review/result.ts";
import { triageResult } from "../testing/workflow-results.ts";
import { changeReport } from "../testing/change-reports.ts";

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
    await writeArtifact(context, reviewARef(0), reviewWithLedger("None"));
    await writeArtifact(context, reviewBRef(0), reviewWithLedger("None"));

    const plan = await buildIssueCurationPlan(context, fixedClock);

    expect(plan).toMatchObject({
      version: 2,
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
      issuesToCreate: [],
      rejectedCandidates: [],
      duplicatesMerged: [],
    });
    expect(plan.run.artifactPaths).toContain(".roark/runs/issue/42/attempts/2/issue.md");
  });

  test("one actionable follow-up produces a follow-up issue item", async () => {
    const context = await tempContext();
    await writeArtifact(context, reviewARef(0), reviewWithLedger(finding("F1", "follow-up", {
      title: "Document retry edge case",
      suggestedIssueTitle: "Document retry edge case for users",
      evidence: "src/retry.ts:17 demonstrates the missing user-facing description.",
      impact: "Future users cannot understand how retry exhaustion is reported.",
      handling: "Add focused documentation for retry exhaustion behavior.",
    })));
    await writeArtifact(context, reviewBRef(0), reviewWithLedger("None"));

    const plan = await buildIssueCurationPlan(context, fixedClock);

    expect(plan.issuesToCreate).toHaveLength(1);
    const item = plan.issuesToCreate[0];
    expect(item?.planItemId).toBe("follow-up-1");
    expect(item?.classification).toBe("follow-up");
    expect(item?.proposedTitle).toBe("Document retry edge case for users");
    expect(item?.proposedLabels).toEqual(["needs-triage", "review:follow-up"]);
    expect(item?.sourceFindingIds).toEqual(["review-a:f1"]);
    expect(item?.proposedBody.startsWith("## Summary\n\nDocument retry edge case for users.")).toBe(true);
    expect(item?.proposedBody).toContain("## Why this issue exists");
    expect(item?.proposedBody).toContain("## What the reviewer observed");
    expect(item?.proposedBody).toContain("## Suggested fix");
    expect(item?.proposedBody).toContain("## Acceptance criteria");
    expect(item?.proposedBody).toContain("## Triage recommendation");
    expect(item?.proposedBody).not.toContain(".roark/runs/");
    expect(item?.proposedBody).toContain("## Non-goals");
    expect(item?.proposedBody).toContain("Source issue: #42 Source issue title");
    expect(item?.proposedBody).not.toContain("## Source");
    expect(item?.proposedBody).not.toContain("Why Roark created this candidate");
  });

  test("numbered autorun review artifacts are used when present", async () => {
    const context = await tempContext();
    await writeArtifact(context, reviewARef(0), reviewWithLedger(finding("N1", "follow-up", {
      title: "Document autorun review artifact handling",
      evidence: "lib/workflow/issue-curation.ts:116 reads the review artifact selected for curation.",
      impact: "Reviewer findings from normal autorun attempts are promoted into follow-up issues.",
      handling: "Use numbered review artifacts when curating autorun findings.",
    })));
    await writeArtifact(context, reviewBRef(0), reviewWithLedger("None"));

    const plan = await buildIssueCurationPlan(context, fixedClock);

    expect(plan.issuesToCreate).toHaveLength(1);
    expect(plan.issuesToCreate[0]?.sourceFindingIds).toEqual(["review-a:n1"]);
    expect(plan.run.artifactPaths).toContain(".roark/runs/issue/42/attempts/2/review-a-0.json");
    expect(plan.run.artifactPaths).toContain(".roark/runs/issue/42/attempts/2/review-b-0.json");
    expect(plan.warnings).not.toContain("review-a-0.json is missing; treating Review Agent A findings as empty.");
  });

  test("ignores unnumbered review JSON files", async () => {
    const context = await tempContext();
    await Bun.write(path.join(context.runDir, "review-a.json"), reviewWithLedger(finding("OLD", "follow-up")));
    await Bun.write(path.join(context.runDir, "review-b.json"), reviewWithLedger("None"));

    const plan = await buildIssueCurationPlan(context, fixedClock);

    expect(plan.issuesToCreate).toEqual([]);
    expect(plan.run.artifactPaths).not.toContain(".roark/runs/issue/42/attempts/2/review-a.json");
    expect(plan.run.artifactPaths).not.toContain(".roark/runs/issue/42/attempts/2/review-b.json");
  });

  test("one actionable external-blocker produces a blocking issue item", async () => {
    const context = await tempContext();
    await writeArtifact(context, reviewARef(0), reviewWithLedger(finding("B1", "external-blocker", {
      title: "Missing prerequisite API token fixture",
      evidence: "tests/fixtures/token.json:1 is required but absent from the repository.",
      impact: "The current issue cannot be validated until the prerequisite fixture exists.",
      handling: "Create a separate prerequisite issue to define and provide the fixture.",
    })));
    await writeArtifact(context, reviewBRef(0), reviewWithLedger("None"));

    const plan = await buildIssueCurationPlan(context, fixedClock);

    expect(plan.issuesToCreate).toHaveLength(1);
    const item = plan.issuesToCreate[0];
    expect(item?.planItemId).toBe("external-blocker-1");
    expect(item?.classification).toBe("external-blocker");
    expect(item?.proposedLabels).toEqual(["needs-triage", "review:external-blocker"]);
    expect(item?.whyBlockingOrNonBlocking).toContain("prerequisite or external work");
  });

  test("approval-blocking review limitations produce external-blocker issue items", async () => {
    const context = await tempContext();
    await writeArtifact(context, reviewARef(0), JSON.stringify(reviewResult([], {
      completeness: "limited",
      limitations: [{
        id: "generated-migration-unavailable",
        description: "Generated migration output could not be inspected.",
        blocksApproval: true,
      }],
    })));
    await writeArtifact(context, reviewBRef(0), reviewWithLedger("None"));

    const plan = await buildIssueCurationPlan(context, fixedClock);

    expect(plan.issuesToCreate).toHaveLength(1);
    expect(plan.issuesToCreate[0]?.classification).toBe("external-blocker");
    expect(plan.issuesToCreate[0]?.sourceFindingIds)
      .toEqual(["review-a:limitation:generated-migration-unavailable"]);
  });

  test("suggestion findings become issues while must-fix-current findings are rejected", async () => {
    const context = await tempContext();
    await writeArtifact(context, reviewARef(0), reviewWithLedger([
      finding("S1", "suggestion"),
      finding("M1", "must-fix-current", {
        evidence: ["src/first.ts:1 shows the first problem.", "src/second.ts:2 shows the second problem."],
      }),
    ]));
    await writeArtifact(context, reviewBRef(0), reviewWithLedger("None"));

    const plan = await buildIssueCurationPlan(context, fixedClock);

    expect(plan.issuesToCreate.map((item) => item.planItemId)).toEqual(["suggestion-1"]);
    expect(plan.issuesToCreate[0]?.proposedLabels).toEqual(["needs-triage", "review:suggestion"]);
    expect(plan.rejectedCandidates.map((candidate) => candidate.sourceFindingIds[0])).toEqual(["review-a:m1"]);
    expect(plan.rejectedCandidates[0]?.reason).toContain("current issue/fix pass");
    expect(plan.rejectedCandidates[0]?.evidence).toEqual([
      "src/first.ts:1 shows the first problem.",
      "src/second.ts:2 shows the second problem.",
    ]);
  });

  test("missing evidence causes rejection", async () => {
    const context = await tempContext();
    await writeArtifact(context, reviewARef(0), reviewWithLedger(finding("F1", "follow-up", { evidence: "unspecified" })));
    await writeArtifact(context, reviewBRef(0), reviewWithLedger("None"));

    const plan = await buildIssueCurationPlan(context, fixedClock);

    expect(plan.issuesToCreate).toEqual([]);
    expect(plan.rejectedCandidates).toHaveLength(1);
    expect(plan.rejectedCandidates[0]?.reason).toBe("missing concrete evidence");
  });

  test("vague or speculative candidates are rejected", async () => {
    const context = await tempContext();
    await writeArtifact(context, reviewARef(0), reviewWithLedger(finding("F1", "follow-up", {
      title: "Maybe improve unclear behavior",
      evidence: "src/flow.ts:9 shows the behavior under discussion.",
      impact: "Future users might encounter confusing output.",
      handling: "Investigate the behavior and decide whether anything should change.",
    })));
    await writeArtifact(context, reviewBRef(0), reviewWithLedger("None"));

    const plan = await buildIssueCurationPlan(context, fixedClock);

    expect(plan.issuesToCreate).toEqual([]);
    expect(plan.rejectedCandidates[0]?.reason).toBe("vague or speculative candidate");
  });

  test("duplicate Review A/B findings merge into one proposed item preserving sources and evidence", async () => {
    const context = await tempContext();
    await writeArtifact(context, reviewARef(0), reviewWithLedger(finding("F1", "follow-up", {
      title: "Document cache invalidation behavior",
      evidence: [
        "src/cache.ts:12 does not describe invalidation behavior.",
        "src/cache.ts:30 invalidates entries without documenting the timing.",
      ],
      impact: "Future users cannot predict cache refresh timing.",
      handling: "Document cache invalidation behavior in the user guide.",
    })));
    await writeArtifact(context, reviewBRef(0), reviewWithLedger(finding("G1", "follow-up", {
      title: "Document cache invalidation behavior",
      evidence: "README.md:44 omits cache invalidation guidance.",
      impact: "Future users cannot predict cache refresh timing.",
      handling: "Add a focused cache invalidation follow-up issue.",
    })));

    const plan = await buildIssueCurationPlan(context, fixedClock);

    expect(plan.issuesToCreate).toHaveLength(1);
    const item = plan.issuesToCreate[0];
    expect(item?.sourceFindingIds).toEqual(["review-a:f1", "review-b:g1"]);
    expect(item?.reviewerSources).toEqual(["review-a", "review-b"]);
    expect(item?.evidence).toEqual([
      "src/cache.ts:12 does not describe invalidation behavior.",
      "src/cache.ts:30 invalidates entries without documenting the timing.",
      "README.md:44 omits cache invalidation guidance.",
    ]);
    expect(plan.duplicatesMerged).toEqual([
      {
        winningPlanItemId: "follow-up-1",
        mergedSourceFindingIds: ["review-a:f1", "review-b:g1"],
        reviewerSources: ["review-a", "review-b"],
        reason: "Merged findings with the same classification and matching normalized title or evidence reference.",
      },
    ]);
  });

  test("unrelated findings with the same generic impact remain separate", async () => {
    const context = await tempContext();
    await writeArtifact(context, reviewARef(0), reviewWithLedger(finding("F1", "follow-up", {
      title: "Document retry exhaustion behavior",
      evidence: "src/retry.ts:17 does not describe retry exhaustion behavior.",
      impact: "Future users encounter a concrete gap.",
      handling: "Document retry exhaustion behavior for future users.",
    })));
    await writeArtifact(context, reviewBRef(0), reviewWithLedger(finding("G1", "follow-up", {
      title: "Add timeout configuration examples",
      evidence: "README.md:44 omits timeout configuration examples.",
      impact: "Future users encounter a concrete gap.",
      handling: "Add focused timeout configuration examples.",
    })));

    const plan = await buildIssueCurationPlan(context, fixedClock);

    expect(plan.issuesToCreate).toHaveLength(2);
    expect(plan.issuesToCreate.map((item) => item.sourceFindingIds)).toEqual([
      ["review-b:g1"],
      ["review-a:f1"],
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
    await writeArtifact(context, "implementationLog", JSON.stringify(changeReport()));
    await writeArtifact(context, reviewARef(0), reviewWithLedger(finding("F1", "follow-up")));
    await writeArtifact(context, reviewBRef(0), reviewWithLedger("None"));

    const plan = await buildIssueCurationPlan(context, fixedClock);
    const item = plan.issuesToCreate[0];

    expect(plan.sourceIssue.title).toBe("Metadata issue title");
    expect(plan.run.generatedAt).toBe("2026-05-06T12:00:00.000Z");
    expect(item?.sourceIssueContext).toEqual(plan.sourceIssue);
    expect(item?.runContext.artifactPaths).toContain(".roark/runs/issue/42/attempts/2/implementation-log.json");
  });

  test("PR context is preserved in plan and generated issue bodies", async () => {
    const context = await tempContext();
    await writeArtifact(context, reviewARef(0), reviewWithLedger(finding("F1", "suggestion")));
    await writeArtifact(context, reviewBRef(0), reviewWithLedger("None"));

    const plan = await buildIssueCurationPlan(context, fixedClock, { prUrl: "https://github.com/owner/repo/pull/99" });
    const item = plan.issuesToCreate[0];

    expect(plan.run.prUrl).toBe("https://github.com/owner/repo/pull/99");
    expect(item?.runContext.prUrl).toBe("https://github.com/owner/repo/pull/99");
    expect(item?.proposedBody).toContain("Related PR: https://github.com/owner/repo/pull/99");
    expect(item?.proposedBody).toContain("Classification: suggestion");
  });

  test("available artifact paths include catalog static refs and numbered review refs", async () => {
    const context = await tempContext();
    await writeArtifact(context, "metadata", "{}\n");
    await writeJsonArtifact(context, "triage", triageResult());
    await writeArtifact(context, reviewARef(0), reviewWithLedger("None"));
    await writeArtifact(context, reviewBRef(0), reviewWithLedger("None"));
    await writeArtifact(context, fixLogRef(1), JSON.stringify(changeReport()));

    const plan = await buildIssueCurationPlan(context, fixedClock);

    expect(plan.run.artifactPaths).toEqual([
      ".roark/runs/issue/42/attempts/2/issue.md",
      ".roark/runs/issue/42/attempts/2/metadata.json",
      ".roark/runs/issue/42/attempts/2/triage.json",
      ".roark/runs/issue/42/attempts/2/review-a-0.json",
      ".roark/runs/issue/42/attempts/2/review-b-0.json",
      ".roark/runs/issue/42/attempts/2/fix-log-1.json",
    ]);
  });
});

describe("issue curation phase", () => {
  test("manual curate-issues without --attempt gives guidance when attempt artifacts exist", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "roark-curation-root-"));
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
    });
    await mkdir(path.join(dir, ".roark/runs/issue/42/attempts/3"), { recursive: true });

    try {
      await runSinglePhase(context, "curate-issues");
      throw new Error("expected curate-issues to require --attempt");
    } catch (error) {
      expect(error instanceof Error ? error.message : String(error)).toContain("--attempt 3");
    }
  });

  test("runSinglePhase writes issue-curation-plan.json without using an agent", async () => {
    const context = await tempContext();
    await writeArtifact(context, reviewARef(0), reviewWithLedger(finding("F1", "follow-up")));
    await writeArtifact(context, reviewBRef(0), reviewWithLedger("None"));

    await runSinglePhase(context, "curate-issues", async () => {
      await noopAsync();
      throw new Error("curation should not invoke an agent");
    });

    expect(artifactExists(context, "issueCurationPlan")).toBe(true);
    const raw = await readArtifact(context, "issueCurationPlan");
    const plan = JSON.parse(raw) as { issuesToCreate: unknown[] };
    expect(plan.issuesToCreate).toHaveLength(1);
  });
});

function reviewWithLedger(entries: ReviewFinding | ReviewFinding[] | "None"): string {
  const findings = entries === "None" ? [] : Array.isArray(entries) ? entries : [entries];
  return JSON.stringify(reviewResult(findings), null, 2);
}

function finding(
  _id: string,
  classification: ReviewConcernClassification,
  overrides: Partial<{
    title: string;
    severity: FindingSeverity;
    confidence: FindingConfidence;
    evidence: string | string[];
    impact: string;
    handling: string;
    suggestedIssueTitle: string;
  }> = {},
): ReviewFinding {
  return reviewFinding(classification, overrides.title ?? `Finding ${_id}`, {
    id: _id.toLowerCase(),
    severity: overrides.severity ?? "medium",
    confidence: overrides.confidence ?? "high",
    evidence: typeof overrides.evidence === "string"
      ? [overrides.evidence]
      : overrides.evidence ?? ["src/example.ts:1 shows concrete behavior."],
    currentIssueImpact: overrides.impact ?? "Future users encounter a concrete gap.",
    recommendedHandling: overrides.handling ?? "Create a focused follow-up issue for this gap.",
    ...(overrides.suggestedIssueTitle ? { suggestedIssueTitle: overrides.suggestedIssueTitle } : {}),
  });
}
