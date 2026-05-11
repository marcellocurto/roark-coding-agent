import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { artifactExists, createWorkflowContext, readArtifact, writeArtifact } from "./artifacts.ts";
import type { AgentRunner } from "./agent-runner.ts";
import { AgentTaskRunError, finalReviewTask, fixTask, implementationTask, reviewATask, reviewBTask, runAgentTask, triageTask } from "./tasks.ts";
import { validateAgentArtifact } from "./artifact-validation.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function createContext(options: { agentCwd?: string; thinkingProfile?: "fast" | "deep"; thinkingLevel?: "medium" } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "roark-tasks-"));
  tempDirs.push(dir);
  const context = createWorkflowContext({
    command: "do",
    issue: "12",
    cwd: dir,
    outDir: ".roark/runs",
    thinkingLevel: options.thinkingLevel,
    thinkingProfile: options.thinkingProfile,
    force: false,
    yes: false,
    maxFixPasses: 1,
  }, { agentCwd: options.agentCwd });
  await writeArtifact(context, "issue", "# Issue\n");
  return context;
}

describe("runAgentTask skill loading", () => {
  test("runs agent requests in the explicit agent cwd", async () => {
    const agentCwd = path.join(await mkdtemp(path.join(tmpdir(), "roark-agent-cwd-")), "worktree");
    tempDirs.push(path.dirname(agentCwd));
    const context = await createContext({ agentCwd });
    const requests: string[] = [];
    const runner: AgentRunner = async (request) => {
      requests.push(request.cwd);
      return "# Triage\n\n## Verdict\nproceed\n";
    };

    await runAgentTask(context, runner, triageTask);
    expect(requests).toEqual([agentCwd]);
  });

  test("normal workflow tasks do not request any skill paths", async () => {
    const context = await createContext();
    const requests: unknown[] = [];
    const runner: AgentRunner = async (request) => {
      requests.push(request.skillPaths);
      return "# Triage\n\n## Verdict\nproceed\n";
    };

    await expect(runAgentTask(context, runner, triageTask)).resolves.toContain("## Verdict\nproceed");
    expect(requests).toEqual([undefined]);
  });
});

describe("runAgentTask thinking profiles", () => {
  test("uses fast profile levels by explicit task stage", async () => {
    const context = await createContext({ thinkingProfile: "fast" });
    await writeReadyThroughPlan(context);
    const requests: string[] = [];
    const runner: AgentRunner = async (request) => {
      requests.push(`${request.writable ? "write" : "read"}:${request.thinkingLevel}`);
      if (request.prompt.includes("Review A")) return "# Review A\n\n## Verdict\napprove\n";
      if (request.prompt.includes("Review B")) return "# Review B\n\n## Verdict\napprove\n";
      if (request.prompt.includes("Final Review")) return "# Final Review\n\n## Verdict\nready-for-pr\n";
      if (request.prompt.includes("Fix")) return "# Fix Log Pass 1\n";
      return "# Implementation Log\n";
    };

    await runAgentTask(context, runner, implementationTask);
    await runAgentTask(context, runner, reviewATask);
    await runAgentTask(context, runner, reviewBTask);
    await runAgentTask(context, runner, fixTask(1));
    await runAgentTask(context, runner, finalReviewTask(1));

    expect(requests).toEqual(["write:low", "read:medium", "read:medium", "write:low", "read:low"]);
  });

  test("deep profile and explicit thinking override use the resolved context config", async () => {
    const deep = await createContext({ thinkingProfile: "deep" });
    await writeReadyThroughPlan(deep);
    const deepRequests: string[] = [];
    await runAgentTask(deep, async (request) => {
      deepRequests.push(request.thinkingLevel);
      return "# Implementation Log\n";
    }, implementationTask);
    expect(deepRequests).toEqual(["high"]);

    const explicit = await createContext({ thinkingLevel: "medium" });
    const explicitRequests: string[] = [];
    await runAgentTask(explicit, async (request) => {
      explicitRequests.push(request.thinkingLevel);
      return "# Triage\n\n## Verdict\nproceed\n";
    }, triageTask);
    expect(explicitRequests).toEqual(["medium"]);
  });
});

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

async function writeReadyThroughPlan(context: Awaited<ReturnType<typeof createContext>>) {
  await writeArtifact(context, "triage", "# Triage\n\n## Verdict\nproceed\n");
  await writeArtifact(context, "implementationPlan", "# Implementation Plan\n\n## Ready For Implementation\nyes\n");
}

async function writeReadyThroughReviews(context: Awaited<ReturnType<typeof createContext>>) {
  await writeReadyThroughPlan(context);
  await writeArtifact(context, "implementationLog", "# Implementation Log\n");
  await writeArtifact(context, "reviewA", "# Review A\n\n## Verdict\napprove\n");
  await writeArtifact(context, "reviewB", "# Review B\n\n## Verdict\napprove\n");
}

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

  test("adds partial-edit guidance to writable retry prompts", async () => {
    const context = await createContext();
    await writeArtifact(context, "triage", "# Triage\n\n## Verdict\nproceed\n");
    await writeArtifact(
      context,
      "implementationPlan",
      "# Implementation Plan\n\n## Ready For Implementation\nyes\n",
    );
    const prompts: string[] = [];
    const runner: AgentRunner = async (request) => {
      prompts.push(request.prompt);
      if (prompts.length === 1) throw new Error("openai-codex/gpt-5.5 failed: WebSocket closed 1006 Connection ended");
      return "# Implementation Log\n";
    };

    await expect(runAgentTask(context, runner, implementationTask, {
      delaysMs: [0, 60_000, 180_000],
      sleep: async () => {},
    })).resolves.toBe("# Implementation Log\n");

    expect(prompts).toHaveLength(2);
    expect(prompts[0]).not.toContain("<transient_connection_retry>");
    expect(prompts[1]).toContain("<transient_connection_retry>");
    expect(prompts[1]).toContain("It may have already modified files in the working tree.");
    expect(prompts[1]).toContain("Inspect the current diff before editing");
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
