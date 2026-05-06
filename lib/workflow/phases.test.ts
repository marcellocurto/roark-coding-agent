import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentRunner } from "./agent-runner.ts";
import { artifactExists, createWorkflowContext, readArtifact, writeArtifact } from "./artifacts.ts";
import { runFullWorkflow } from "./phases.ts";

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
  await writeArtifact(context, "issue", "# GitHub Issue #12\n");
  return context;
}

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

  test("completed path returns completed", async () => {
    const context = await tempContext();
    await writeArtifact(context, "implementationLog", "# Implementation Log\n\n## Summary\nDone.\n");

    const runner: AgentRunner = async (request) => {
      if (request.prompt.includes('name="triage"')) {
        return proceedTriage();
      }
      if (request.prompt.includes('name="implementation_plan"')) {
        return readyPlan();
      }
      if (request.prompt.includes('name="review_a"')) {
        return "# Review A\n\n## Verdict\napprove\n\n## Findings\nNone.\n\n## Required Fixes\nNone.\n\n## Suggested Improvements\nNone.\n\n## Validation Reviewed\nTests.\n";
      }
      if (request.prompt.includes('name="review_b"')) {
        return "# Review B\n\n## Verdict\napprove\n\n## Findings\nNone.\n\n## Required Fixes\nNone.\n\n## Suggested Improvements\nNone.\n\n## Validation Reviewed\nTests.\n";
      }
      throw new Error("unexpected prompt");
    };

    await expect(runFullWorkflow(context, runner)).resolves.toEqual({ status: "completed" });
  });

  test("does not run fix for follow-up and suggestion-only ledgers", async () => {
    const context = await tempContext();
    await writeArtifact(context, "implementationLog", "# Implementation Log\n\n## Summary\nDone.\n");
    const phases: string[] = [];

    const runner: AgentRunner = async (request) => {
      if (request.prompt.includes('name="triage"')) return proceedTriage();
      if (request.prompt.includes('name="implementation_plan"')) return readyPlan();
      if (request.prompt.includes('name="review_a"')) {
        phases.push("review-a");
        return reviewWithLedger("approve", `${finding("F1", "follow-up")}\n${finding("S1", "suggestion")}`);
      }
      if (request.prompt.includes('name="review_b"')) {
        phases.push("review-b");
        return "# Review B\n\n## Verdict\napprove\n\n## Findings Ledger\nNone\n";
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
    await writeArtifact(context, "implementationLog", "# Implementation Log\n\n## Summary\nDone.\n");
    const phases: string[] = [];

    const runner: AgentRunner = async (request) => {
      if (request.prompt.includes('name="triage"')) return proceedTriage();
      if (request.prompt.includes('name="implementation_plan"')) return readyPlan();
      if (request.prompt.includes('name="review_a"')) {
        phases.push("review-a");
        return reviewWithLedger("blocked", finding("B1", "external-blocker"));
      }
      if (request.prompt.includes('name="review_b"')) {
        phases.push("review-b");
        return "# Review B\n\n## Verdict\napprove\n\n## Findings Ledger\nNone\n";
      }
      if (request.prompt.includes('name="fix"')) phases.push("fix");
      throw new Error("unexpected prompt");
    };

    await expect(runFullWorkflow(context, runner)).resolves.toEqual({ status: "review-blocked" });
    expect(phases).toEqual(["review-a", "review-b"]);
    expect(await readArtifact(context, "readiness")).toContain("## External Blockers\n- review-a:B1");
  });
});

function proceedTriage(): string {
  return "# Triage\n\n## Verdict\nproceed\n\n## Reasoning\nOK.\n\n## Evidence\nRepo inspected.\n\n## Blocking Questions\nNone.\n\n## Recommended Next Step\nPlan.\n";
}

function readyPlan(): string {
  return "# Implementation Plan\n\n## Issue\n#12\n\n## Work Classification\nbackend\n\n## Goal\nTest.\n\n## Non-Goals\nNone.\n\n## Current Code Findings\nFound.\n\n## Proposed Changes\nChange.\n\n## Files Likely To Change\nFiles.\n\n## Detailed Steps\nSteps.\n\n## Tests And Validation\nTests.\n\n## Risks\nLow.\n\n## Rollback Plan\nRevert.\n\n## Ready For Implementation\nyes\n";
}

function reviewWithLedger(verdict: "approve" | "fixes-required" | "blocked", entries: string): string {
  return `# Review A\n\n## Verdict\n${verdict}\n\n## Findings Ledger\n${entries}\n\n## Required Fixes\nNone.\n\n## Suggested Improvements\nNone.\n\n## Validation Reviewed\nTests.\n`;
}

function finding(id: string, classification: string): string {
  return `- Identifier: ${id}\n- Classification: ${classification}\n- Title: ${id}\n- Severity: medium\n- Confidence: high\n- Evidence: file.ts:1\n- Current-issue impact: Impact.\n- Recommended handling: Handle.\n`;
}
