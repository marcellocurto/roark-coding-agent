import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import type { AgentRunner } from "./agent-runner.ts";
import { createWorkflowContext, writeArtifact } from "./artifacts.ts";
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
  });

  test("completed path returns completed", async () => {
    const context = await tempContext();
    await writeArtifact(context, "implementationLog", "# Implementation Log\n\n## Summary\nDone.\n");

    const runner: AgentRunner = async (request) => {
      if (request.prompt.includes('name="triage"')) {
        return "# Triage\n\n## Verdict\nproceed\n\n## Reasoning\nOK.\n\n## Evidence\nRepo inspected.\n\n## Blocking Questions\nNone.\n\n## Recommended Next Step\nPlan.\n";
      }
      if (request.prompt.includes('name="implementation_plan"')) {
        return "# Implementation Plan\n\n## Issue\n#12\n\n## Work Classification\nbackend\n\n## Goal\nTest.\n\n## Non-Goals\nNone.\n\n## Current Code Findings\nFound.\n\n## Proposed Changes\nChange.\n\n## Files Likely To Change\nFiles.\n\n## Detailed Steps\nSteps.\n\n## Tests And Validation\nTests.\n\n## Risks\nLow.\n\n## Rollback Plan\nRevert.\n\n## Ready For Implementation\nyes\n";
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
});
