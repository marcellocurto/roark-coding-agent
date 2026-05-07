import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { artifactExists, createWorkflowContext, readArtifact, writeArtifact } from "./artifacts.ts";
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
    let calls = 0;
    const runner: AgentRunner = async () => {
      calls++;
      throw new Error("openai-codex/gpt-5.5 failed: provider unavailable");
    };

    await expect(runAgentTask(context, runner, triageTask)).rejects.toThrow(AgentTaskRunError);
    expect(calls).toBe(1);

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
    let calls = 0;
    const runner: AgentRunner = async () => {
      calls++;
      return "";
    };

    await expect(runAgentTask(context, runner, triageTask)).rejects.toThrow(AgentTaskRunError);
    expect(calls).toBe(2);

    const artifact = await readArtifact(context, "triage");
    expect(artifact).toContain("# Triage Error");
    expect(artifact).toContain("## Phase\noutput-contract");
    expect(artifact).toContain("triage failed output contract: artifact is empty");
  });
});

describe("runAgentTask transient agent retry", () => {
  test("retries transient connection errors before writing the phase artifact", async () => {
    const context = await createContext();
    const validTriage = "# Triage\n\n## Verdict\nproceed\n";
    let calls = 0;
    const sleeps: number[] = [];
    const runner: AgentRunner = async () => {
      calls++;
      if (calls === 1) throw new Error("openai-codex/gpt-5.5 failed: WebSocket closed 1006 Connection ended");
      return validTriage;
    };

    const result = await runAgentTask(context, runner, triageTask, {
      delaysMs: [0, 60_000, 180_000],
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    expect(result).toBe(validTriage);
    expect(calls).toBe(2);
    expect(sleeps).toEqual([]);
    expect(await readArtifact(context, "triage")).toBe(validTriage);
  });

  test("does not write diagnostic artifacts while transient retries remain", async () => {
    const context = await createContext();
    const validTriage = "# Triage\n\n## Verdict\nproceed\n";
    let calls = 0;
    const runner: AgentRunner = async () => {
      calls++;
      expect(artifactExists(context, "triage")).toBe(false);
      if (calls < 4) throw new Error("openai-codex/gpt-5.5 failed: WebSocket closed 1006 Connection ended");
      return validTriage;
    };

    await expect(runAgentTask(context, runner, triageTask, {
      delaysMs: [0, 1, 2],
      sleep: async () => {},
    })).resolves.toBe(validTriage);

    expect(calls).toBe(4);
    expect(await readArtifact(context, "triage")).toBe(validTriage);
  });

  test("exhausts immediate, one minute, and three minute retries before failing", async () => {
    const context = await createContext();
    let calls = 0;
    const sleeps: number[] = [];
    const runner: AgentRunner = async () => {
      calls++;
      throw new Error("openai-codex/gpt-5.5 failed: fetch failed");
    };

    await expect(runAgentTask(context, runner, triageTask, {
      delaysMs: [0, 60_000, 180_000],
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    })).rejects.toThrow(AgentTaskRunError);

    expect(calls).toBe(4);
    expect(sleeps).toEqual([60_000, 180_000]);
    const artifact = await readArtifact(context, "triage");
    expect(artifact).toContain("# Triage Error");
    expect(artifact).toContain("openai-codex/gpt-5.5 failed: fetch failed");
  });
});
