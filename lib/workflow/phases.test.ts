import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentRunner } from "./agent-runner.ts";
import { artifactExists, createWorkflowContext, readArtifact, writeArtifact } from "./artifacts.ts";
import { issueArtifactHasRelationshipSnapshot, runFullWorkflow } from "./phases.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempContext() {
  const dir = await mkdtemp(path.join(tmpdir(), "roark-phases-"));
  tempDirs.push(dir);
  const context = createWorkflowContext({
    command: "do",
    issue: "12",
    cwd: dir,
    outDir: ".roark/runs",
    force: false,
    yes: true,
    maxFixPasses: 1,
    attempt: 1,
  });
  await writeArtifact(
    context,
    "issue",
    "# GitHub Issue #12\n\n<github_issue_relationships source=\"gh\">\n  <blocking_status active_blockers=\"0\" total_blockers=\"0\" />\n</github_issue_relationships>\n",
  );
  return context;
}

describe("issueArtifactHasRelationshipSnapshot", () => {
  test("requires a machine-generated relationship snapshot before reusing issue artifacts", () => {
    expect(issueArtifactHasRelationshipSnapshot("# GitHub Issue #12\n")).toBe(false);
    expect(
      issueArtifactHasRelationshipSnapshot(
        '<github_issue_relationships source="gh"><blocking_status active_blockers="0" /></github_issue_relationships>',
      ),
    ).toBe(true);
  });
});

describe("runFullWorkflow", () => {
  test("returns triage-stopped and does not run later agents after blocked triage", async () => {
    const context = await tempContext();
    const prompts: string[] = [];
    const runner: AgentRunner = async (request) => {
      prompts.push(request.prompt);
      return "# Triage\n\n## Verdict\nblocked\n\n## Reasoning\nWaiting.\n\n## Evidence\n#7 is open.\n\n## Blocking Questions\nNone.\n\n## Recommended Next Step\nWait.\n";
    };

    const result = await runFullWorkflow(context, runner);

    expect(result).toEqual({ status: "triage-stopped", triageVerdict: "blocked" });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('name="triage"');
    expect(artifactExists(context, "readiness")).toBe(true);
    expect(artifactExists(context, "implementationPlan")).toBe(false);
    expect(artifactExists(context, "implementationLog")).toBe(false);
    expect(await readArtifact(context, "readiness")).toContain("- Triage verdict: blocked");
  });

  test("returns planning-stopped and does not implement when plan is not ready", async () => {
    const context = await tempContext();
    const phases: string[] = [];
    const runner: AgentRunner = async (request) => {
      if (request.prompt.includes('name="triage"')) {
        phases.push("triage");
        return proceedTriage();
      }
      if (request.prompt.includes('name="implementation_plan_draft"')) {
        phases.push("plan-draft");
        return readyPlanDraft();
      }
      if (request.prompt.includes('name="implementation_plan_refinement"')) {
        phases.push("plan");
        return notReadyPlan();
      }
      phases.push("unexpected");
      throw new Error("unexpected prompt");
    };

    await expect(runFullWorkflow(context, runner)).resolves.toEqual({ status: "planning-stopped" });
    expect(phases).toEqual(["triage", "plan-draft", "plan"]);
    expect(artifactExists(context, "readiness")).toBe(true);
    expect(artifactExists(context, "implementationLog")).toBe(false);
  });

  test("completed path returns completed", async () => {
    const context = await tempContext();
    await seedBaselineAndImplementation(context);

    const runner: AgentRunner = async (request) => {
      if (request.prompt.includes('name="triage"')) return proceedTriage();
      if (request.prompt.includes('name="implementation_plan_draft"')) return readyPlanDraft();
      if (request.prompt.includes('name="implementation_plan_refinement"')) return readyPlan();
      if (request.prompt.includes('name="code_refinement"')) return refinementLog();
      if (request.prompt.includes('name="review_a"')) return approveReview("A");
      if (request.prompt.includes('name="review_b"')) return approveReview("B");
      throw new Error("unexpected prompt");
    };

    await expect(runFullWorkflow(context, runner)).resolves.toEqual({ status: "completed" });
  });

  test("does not run fix for follow-up and suggestion-only ledgers", async () => {
    const context = await tempContext();
    await seedBaselineAndImplementation(context);
    const phases: string[] = [];

    const runner: AgentRunner = async (request) => {
      if (request.prompt.includes('name="triage"')) return proceedTriage();
      if (request.prompt.includes('name="implementation_plan_draft"')) return readyPlanDraft();
      if (request.prompt.includes('name="implementation_plan_refinement"')) return readyPlan();
      if (request.prompt.includes('name="code_refinement"')) return refinementLog();
      if (request.prompt.includes('name="review_a"')) {
        phases.push("review-a");
        return reviewWithLedger("approve", `${finding("F1", "follow-up")}\n${finding("S1", "suggestion")}`);
      }
      if (request.prompt.includes('name="review_b"')) {
        phases.push("review-b");
        return "# Review B Pass 0\n\n## Verdict\napprove\n\n## Findings Ledger\nNone\n";
      }
      if (request.prompt.includes('name="fix"')) phases.push("fix");
      throw new Error("unexpected prompt");
    };

    await expect(runFullWorkflow(context, runner)).resolves.toEqual({ status: "completed" });
    expect(phases).toEqual(["review-a", "review-b"]);
    expect(await readArtifact(context, "readiness")).toContain("## Status\nready-for-pr");
  });

  test("external-blocker ledgers stop after review without running fix", async () => {
    const context = await tempContext();
    await seedBaselineAndImplementation(context);
    const phases: string[] = [];

    const runner: AgentRunner = async (request) => {
      if (request.prompt.includes('name="triage"')) return proceedTriage();
      if (request.prompt.includes('name="implementation_plan_draft"')) return readyPlanDraft();
      if (request.prompt.includes('name="implementation_plan_refinement"')) return readyPlan();
      if (request.prompt.includes('name="code_refinement"')) return refinementLog();
      if (request.prompt.includes('name="review_a"')) {
        phases.push("review-a");
        return reviewWithLedger("blocked", finding("B1", "external-blocker"));
      }
      if (request.prompt.includes('name="review_b"')) {
        phases.push("review-b");
        return "# Review B Pass 0\n\n## Verdict\napprove\n\n## Findings Ledger\nNone\n";
      }
      if (request.prompt.includes('name="fix"')) phases.push("fix");
      throw new Error("unexpected prompt");
    };

    await expect(runFullWorkflow(context, runner)).resolves.toEqual({ status: "review-blocked" });
    expect(phases).toEqual(["review-a", "review-b"]);
    expect(await readArtifact(context, "readiness")).toContain("## External Blockers\n- review-a:B1");
  });
});

async function seedBaselineAndImplementation(context: Awaited<ReturnType<typeof tempContext>>) {
  await writeArtifact(context, "preImplementationBaseline", JSON.stringify({ head: "abc", capturedAt: "now", excludes: [".roark"] }));
  await writeArtifact(context, "implementationLog", "# Implementation Log\n\n## Summary\nDone.\n");
}

function proceedTriage(): string {
  return "# Triage\n\n## Verdict\nproceed\n\n## Reasoning\nOK.\n\n## Evidence\nRepo inspected.\n\n## Blocking Questions\nNone.\n\n## Recommended Next Step\nPlan.\n";
}

function readyPlanDraft(): string {
  return readyPlan().replace("# Implementation Plan", "# Implementation Plan Draft");
}

function readyPlan(): string {
  return "# Implementation Plan\n\n## Issue\n#12\n\n## Work Classification\nbackend\n\n## Goal\nTest.\n\n## Non-Goals\nNone.\n\n## Current Code Findings\nFound.\n\n## Proposed Changes\nChange.\n\n## Files Likely To Change\nFiles.\n\n## Detailed Steps\nSteps.\n\n## Tests And Validation\nTests.\n\n## Risks\nLow.\n\n## Rollback Plan\nRevert.\n\n## Ready For Implementation\nyes\n";
}

function notReadyPlan(): string {
  return readyPlan().replace("## Ready For Implementation\nyes", "## Ready For Implementation\nno");
}

function refinementLog(): string {
  return "# Refinement Log Pass 0\n\n## Summary\nRefined.\n";
}

function approveReview(reviewer: "A" | "B"): string {
  return `# Review ${reviewer} Pass 0\n\n## Verdict\napprove\n\n## Findings Ledger\nNone\n\n## Required Fixes\nNone.\n\n## Suggested Improvements\nNone.\n\n## Validation Reviewed\nTests.\n`;
}

function reviewWithLedger(verdict: "approve" | "fixes-required" | "blocked", entries: string): string {
  return `# Review A Pass 0\n\n## Verdict\n${verdict}\n\n## Findings Ledger\n${entries}\n\n## Required Fixes\nNone.\n\n## Suggested Improvements\nNone.\n\n## Validation Reviewed\nTests.\n`;
}

function finding(id: string, classification: string): string {
  return `- Identifier: ${id}\n- Classification: ${classification}\n- Title: ${id}\n- Severity: medium\n- Confidence: high\n- Evidence: file.ts:1\n- Current-issue impact: Impact.\n- Recommended handling: Handle.\n`;
}
