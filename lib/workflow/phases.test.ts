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
  return createWorkflowContext({
    command: "do",
    issue: "12",
    cwd: dir,
    outDir: ".roark/runs",
    force: false,
    yes: false,
    maxFixPasses: 1,
    attempt: 1,
  });
}

describe("runFullWorkflow", () => {
  test("returns a triage stop result and skips planning when triage does not proceed", async () => {
    const context = await tempContext();
    await writeArtifact(context, "issue", "# GitHub Issue #12\n");
    const calls: string[] = [];
    const runner: AgentRunner = async (request) => {
      calls.push(request.prompt);
      return "# Triage\n\n## Verdict\nblocked\n\n## Reasoning\nWaiting on another issue.\n";
    };

    const result = await runFullWorkflow(context, runner);

    expect(result).toEqual({ status: "stopped", phase: "triage", verdict: "blocked" });
    expect(calls).toHaveLength(1);
    expect(artifactExists(context, "readiness")).toBe(true);
    expect(artifactExists(context, "implementationPlan")).toBe(false);
    expect(artifactExists(context, "implementationLog")).toBe(false);
    expect(await readArtifact(context, "readiness")).toContain("- Triage verdict: blocked");
  });
});
