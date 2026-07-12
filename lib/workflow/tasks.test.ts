import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { artifactExists, baselineResetLogRef, createWorkflowContext, implementationRestartLogRef, readArtifact, refinementLogRef, reviewARef, reviewBRef, writeArtifact } from "./artifacts.ts";
import type { AgentRunner } from "./agent-runner.ts";
import { AgentTaskRunError, codeRefinementTask, fixTask, implementationTask, reviewATask, reviewBTask, runAgentTask, triageTask } from "./tasks.ts";
import { validateAgentArtifact } from "./artifact-validation.ts";
import { noopAsync } from "../utils/async.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function createContext(options: { agentCwd?: string | undefined; model?: string | undefined} = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "roark-tasks-"));
  tempDirs.push(dir);
  const context = createWorkflowContext({
    command: "do",
    issue: "12",
    cwd: dir,
    outDir: ".roark/runs",
    model: options.model,
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
      await noopAsync();
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
      await noopAsync();
      requests.push(request.skillPaths);
      return "# Triage\n\n## Verdict\nproceed\n";
    };

    expect(runAgentTask(context, runner, triageTask)).resolves.toContain("## Verdict\nproceed");
    expect(requests).toEqual([undefined]);
  });

  test("sends the routed model unless the CLI supplied a global override", async () => {
    const requests: string[] = [];
    const runner: AgentRunner = async (request) => {
      await noopAsync();
      requests.push(request.model ?? "missing");
      return "# Triage\n\n## Verdict\nproceed\n";
    };

    await runAgentTask(await createContext(), runner, triageTask);
    await runAgentTask(await createContext({ model: "anthropic/claude-opus-4-7" }), runner, triageTask);

    expect(requests).toEqual(["openai-codex/gpt-5.6-sol", "anthropic/claude-opus-4-7"]);
  });
});

describe("runAgentTask thinking profiles", () => {
  test("routes task authority and thinking by assigned stage", async () => {
    const context = await createContext();
    context.thinkingConfig.implement = "minimal";
    context.thinkingConfig.codeRefinement = "medium";
    context.thinkingConfig.fix = "low";
    context.thinkingConfig.reviewA = "medium";
    context.thinkingConfig.reviewB = "high";
    await writeReadyThroughPlan(context);
    const requests: string[] = [];
    const runner: AgentRunner = async (request) => {
      await noopAsync();
      requests.push(`${request.fileEditingToolsEnabled ? "write" : "read"}:${request.thinkingLevel}`);
      if (request.phase === "refinementLog-0") return "# Refinement Log Pass 0\n\n## Summary\nRefined.\n";
      if (request.phase === "reviewA-0") return "# Review A Pass 0\n\n## Verdict\napprove\n";
      if (request.phase === "reviewB-0") return "# Review B Pass 0\n\n## Verdict\napprove\n";
      if (request.prompt.includes("Fix")) return "# Fix Log Pass 1\n";
      return "# Implementation Log\n";
    };

    await runAgentTask(context, runner, implementationTask);
    await runAgentTask(context, runner, codeRefinementTask(0));
    await runAgentTask(context, runner, reviewATask);
    await runAgentTask(context, runner, reviewBTask);
    await runAgentTask(context, runner, fixTask(1));

    expect(requests).toEqual(["write:minimal", "write:medium", "read:medium", "read:high", "write:low"]);
  });

  test("restart refinement pass uses restart artifacts instead of requiring a fix log", async () => {
    const context = await createContext();
    await writeReadyThroughReviews(context);
    await writeArtifact(context, baselineResetLogRef(1), "# Baseline Reset Pass 1\n\n## Summary\nReset.\n");
    await writeArtifact(context, implementationRestartLogRef(1), "# Implementation Restart Log Pass 1\n\n## Summary\nRestarted.\n");
    const prompts: string[] = [];

    await runAgentTask(context, async (request) => {
      await noopAsync();
      prompts.push(request.prompt);
      return "# Refinement Log Pass 1\n\n## Summary\nRefined restart.\n";
    }, codeRefinementTask(1, "restart"));

    expect(await readArtifact(context, refinementLogRef(1))).toContain("Refined restart");
    expect(prompts[0]).toContain('<artifact kind="implementation_log">');
    expect(prompts[0]).toContain('<artifact kind="baseline_reset">');
    expect(prompts[0]).toContain('<artifact kind="implementation_restart_log">');
    expect(prompts[0]).not.toContain('<artifact kind="fix_log">');
  });

});

describe("runAgentTask error diagnostics", () => {
  test("writes provider errors into the target phase artifact before throwing", async () => {
    const context = await createContext();
    let calls = 0;
    const runner: AgentRunner = async () => {
      await noopAsync();
      calls++;
      throw new Error("openai-codex/gpt-5.5 failed: provider unavailable");
    };

    expect(runAgentTask(context, runner, triageTask)).rejects.toThrow(AgentTaskRunError);
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
      await noopAsync();
      calls++;
      return "";
    };

    expect(runAgentTask(context, runner, triageTask)).rejects.toThrow(AgentTaskRunError);
    expect(calls).toBe(2);

    const artifact = await readArtifact(context, "triage");
    expect(artifact).toContain("# Triage Error");
    expect(artifact).toContain("## Phase\noutput-contract");
    expect(artifact).toContain("triage failed output contract: artifact is empty");
  });
});

async function writeReadyThroughPlan(context: Awaited<ReturnType<typeof createContext>>) {
  await writeArtifact(context, "triage", "# Triage\n\n## Verdict\nproceed\n");
  await writeArtifact(context, "implementationPlanDraft", "# Implementation Plan Draft\n\n## Ready For Implementation\nyes\n");
  await writeArtifact(context, "implementationPlan", "# Implementation Plan\n\n## Ready For Implementation\nyes\n");
}

async function writeReadyThroughReviews(context: Awaited<ReturnType<typeof createContext>>) {
  await writeReadyThroughPlan(context);
  await writeArtifact(context, "implementationLog", "# Implementation Log\n");
  await writeArtifact(context, refinementLogRef(0), "# Refinement Log Pass 0\n");
  await writeArtifact(context, reviewARef(0), "# Review A Pass 0\n\n## Verdict\napprove\n");
  await writeArtifact(context, reviewBRef(0), "# Review B Pass 0\n\n## Verdict\napprove\n");
}

describe("runAgentTask transient agent retry", () => {
  test("retries transient connection errors before writing the phase artifact", async () => {
        await noopAsync();
    const context = await createContext();
    const validTriage = "# Triage\n\n## Verdict\nproceed\n";
    let calls = 0;
    const sleeps: number[] = [];
    const runner: AgentRunner = async () => {
      await noopAsync();
      calls++;
      if (calls === 1) throw new Error("openai-codex/gpt-5.5 failed: WebSocket closed 1006 Connection ended");
      return validTriage;
    };

    const result = await runAgentTask(context, runner, triageTask, {
      delaysMs: [0, 60_000, 180_000],
      sleep: async (ms) => {
        await noopAsync();
        sleeps.push(ms);
      },
    });

    expect(result).toBe(validTriage);
    expect(calls).toBe(2);
    expect(sleeps).toEqual([]);
    expect(await readArtifact(context, "triage")).toBe(validTriage);
  });

  test("adds partial-edit guidance when file-editing tools are enabled", async () => {
    const context = await createContext();
    await writeArtifact(context, "triage", "# Triage\n\n## Verdict\nproceed\n");
    await writeArtifact(
      context,
      "implementationPlan",
      "# Implementation Plan\n\n## Ready For Implementation\nyes\n",
    );
    const prompts: string[] = [];
    const runner: AgentRunner = async (request) => {
      await noopAsync();
      prompts.push(request.prompt);
      if (prompts.length === 1) throw new Error("openai-codex/gpt-5.5 failed: WebSocket closed 1006 Connection ended");
      return "# Implementation Log\n";
    };

    expect(runAgentTask(context, runner, implementationTask, {
      delaysMs: [0, 60_000, 180_000],
      sleep: async () => {
        await noopAsync();},
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
      await noopAsync();
      calls++;
      expect(artifactExists(context, "triage")).toBe(false);
      if (calls < 4) throw new Error("openai-codex/gpt-5.5 failed: WebSocket closed 1006 Connection ended");
      return validTriage;
    };

    expect(runAgentTask(context, runner, triageTask, {
      delaysMs: [0, 1, 2],
      sleep: async () => {
        await noopAsync();},
    })).resolves.toBe(validTriage);

    expect(calls).toBe(4);
    expect(await readArtifact(context, "triage")).toBe(validTriage);
  });

  test("exhausts immediate, one minute, and three minute retries before failing", async () => {
        await noopAsync();
    const context = await createContext();
    let calls = 0;
    const sleeps: number[] = [];
    const runner: AgentRunner = async () => {
      await noopAsync();
      calls++;
      throw new Error("openai-codex/gpt-5.5 failed: fetch failed");
    };

    expect(runAgentTask(context, runner, triageTask, {
      delaysMs: [0, 60_000, 180_000],
      sleep: async (ms) => {
        await noopAsync();
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
