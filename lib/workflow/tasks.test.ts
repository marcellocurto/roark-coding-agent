import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { createWorkflowContext, readArtifact, writeArtifact } from "./artifacts.ts";
import type { AgentRunner } from "./agent-runner.ts";
import { AgentTaskRunError, runAgentTask, triageTask } from "./tasks.ts";
import { validateAgentArtifact } from "./artifact-validation.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function createContext() {
  const dir = await mkdtemp(path.join(tmpdir(), "roark-tasks-"));
  tempDirs.push(dir);
  const context = createWorkflowContext({
    command: "do",
    issue: "12",
    cwd: dir,
    outDir: ".roark/runs",
    force: false,
    yes: false,
    maxFixPasses: 1,
  });
  await writeArtifact(context, "issue", "# Issue\n");
  return context;
}

describe("runAgentTask error diagnostics", () => {
  test("writes provider errors into the target phase artifact before throwing", async () => {
    const context = await createContext();
    const runner: AgentRunner = async () => {
      throw new Error("openai-codex/gpt-5.5 failed: provider unavailable");
    };

    await expect(runAgentTask(context, runner, triageTask)).rejects.toThrow(AgentTaskRunError);

    const artifact = await readArtifact(context, "triage");
    expect(artifact).toContain("# Triage Error");
    expect(artifact).toContain("## Status\nerrored");
    expect(artifact).toContain("openai-codex/gpt-5.5 failed: provider unavailable");
    expect(validateAgentArtifact("triage", artifact)).toEqual({
      ok: false,
      reason: "previous Triage Error diagnostic: agent-error: openai-codex/gpt-5.5 failed: provider unavailable",
    });
  });

  test("writes output-contract failures into the target phase artifact", async () => {
    const context = await createContext();
    const runner: AgentRunner = async () => "";

    await expect(runAgentTask(context, runner, triageTask)).rejects.toThrow(AgentTaskRunError);

    const artifact = await readArtifact(context, "triage");
    expect(artifact).toContain("# Triage Error");
    expect(artifact).toContain("## Phase\noutput-contract");
    expect(artifact).toContain("triage failed output contract: artifact is empty");
  });
});
