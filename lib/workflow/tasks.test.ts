import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { artifactExists, baselineResetLogRef, createWorkflowContext, implementationRestartLogRef, readArtifact, refinementLogRef, reviewARef, reviewBRef, writeArtifact, writeJsonArtifact } from "./artifacts.ts";
import type { AgentRunner } from "./agent-runner.ts";
import { AgentTaskRunError, codeRefinementTask, fixTask, implementationTask, reviewATask, reviewBTask, runChangeReportTask, runReviewTask, runTriageTask } from "./tasks.ts";
import { noopAsync } from "../utils/async.ts";
import { reviewResult, submitReview } from "../testing/reviews.ts";
import { implementationPlanResult, submitTriage, triageResult } from "../testing/workflow-results.ts";
import { changeReport, submitChangeReport } from "../testing/change-reports.ts";
import { parseChangeReportJson } from "../change-report/result.ts";

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
      return submitTriage(request, triageResult());
    };

    await runTriageTask(context, runner);
    expect(requests).toEqual([agentCwd]);
  });

  test("normal workflow tasks do not request any skill paths", async () => {
    const context = await createContext();
    const requests: unknown[] = [];
    const runner: AgentRunner = async (request) => {
      await noopAsync();
      requests.push(request.skillPaths);
      return submitTriage(request, triageResult());
    };

    expect(runTriageTask(context, runner)).resolves.toMatchObject({ verdict: "proceed" });
    expect(requests).toEqual([undefined]);
  });

  test("sends the routed model unless the CLI supplied a global override", async () => {
    const requests: string[] = [];
    const runner: AgentRunner = async (request) => {
      await noopAsync();
      requests.push(request.model ?? "missing");
      return submitTriage(request, triageResult());
    };

    await runTriageTask(await createContext(), runner);
    await runTriageTask(await createContext({ model: "anthropic/claude-opus-4-7" }), runner);

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
      if (request.phase === "refinementLog-0") return submitChangeReport(request, changeReport({ summary: "Refined." }));
      if (request.phase === "reviewA-0" || request.phase === "reviewB-0") {
        return submitReview(request, reviewResult());
      }
      return submitChangeReport(request, changeReport());
    };

    await runChangeReportTask(context, runner, implementationTask);
    await runChangeReportTask(context, runner, codeRefinementTask(0));
    await runReviewTask(context, runner, reviewATask);
    await runReviewTask(context, runner, reviewBTask);
    await runChangeReportTask(context, runner, fixTask(1));

    expect(requests).toEqual(["write:minimal", "write:medium", "read:medium", "read:high", "write:low"]);
  });

  test("restart refinement pass uses restart artifacts instead of requiring a fix log", async () => {
    const context = await createContext();
    await writeReadyThroughReviews(context);
    await writeArtifact(context, baselineResetLogRef(1), "# Baseline Reset Pass 1\n\n## Summary\nReset.\n");
    await writeArtifact(context, implementationRestartLogRef(1), "# Implementation Restart Log Pass 1\n\n## Summary\nRestarted.\n");
    const prompts: string[] = [];

    await runChangeReportTask(context, async (request) => {
      await noopAsync();
      prompts.push(request.prompt);
      return submitChangeReport(request, changeReport({ summary: "Refined restart." }));
    }, codeRefinementTask(1, "restart"));

    expect(parseChangeReportJson(await readArtifact(context, refinementLogRef(1))).summary).toBe("Refined restart.");
    expect(prompts[0]).toContain('<artifact kind="implementation_log">');
    expect(prompts[0]).toContain('<artifact kind="baseline_reset">');
    expect(prompts[0]).toContain('<artifact kind="implementation_restart_log">');
    expect(prompts[0]).not.toContain('<artifact kind="fix_log">');
  });

});

describe("structured task failures", () => {
  test("preserves provider failures without creating a triage artifact", async () => {
    const context = await createContext();
    let calls = 0;
    const runner: AgentRunner = async () => {
      await noopAsync();
      calls++;
      throw new Error("openai-codex/gpt-5.5 failed: provider unavailable");
    };

    let thrown: unknown;
    try {
      await runTriageTask(context, runner);
    } catch (error) {
      thrown = error;
    }
    expect(calls).toBe(1);
    expect(thrown).toBeInstanceOf(AgentTaskRunError);
    expect((thrown as AgentTaskRunError).phase).toBe("agent-error");
    expect(artifactExists(context, "triage")).toBe(false);
  });

  test("classifies missing structured triage submission without creating an artifact", async () => {
    const context = await createContext();
    let calls = 0;
    const runner: AgentRunner = async () => {
      await noopAsync();
      calls++;
      return "";
    };

    let thrown: unknown;
    try {
      await runTriageTask(context, runner);
    } catch (error) {
      thrown = error;
    }
    expect(calls).toBe(1);
    expect(thrown).toBeInstanceOf(AgentTaskRunError);
    expect((thrown as AgentTaskRunError).phase).toBe("output-contract");
    expect(artifactExists(context, "triage")).toBe(false);
  });

  test("rejects implementation prose without creating a canonical report", async () => {
    const context = await createContext();
    await writeReadyThroughPlan(context);

    let thrown: unknown;
    try {
      await runChangeReportTask(context, async () => {
        await noopAsync();
        return "# Implementation Log\n\nLooks good.\n";
      }, implementationTask);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AgentTaskRunError);
    expect((thrown as AgentTaskRunError).phase).toBe("output-contract");
    expect(artifactExists(context, "implementationLog")).toBe(false);
    expect(artifactExists(context, "implementationLogMarkdown")).toBe(false);
  });
});

describe("runReviewTask failures", () => {
  test("preserves provider failures without creating a review artifact", async () => {
    const context = await createContext();
    await writeReadyThroughPlan(context);
    await writeArtifact(context, "implementationLog", JSON.stringify(changeReport()));
    await writeArtifact(context, refinementLogRef(0), JSON.stringify(changeReport()));

    let thrown: unknown;
    try {
      await runReviewTask(context, async () => {
        await noopAsync();
        throw new Error("provider quota exhausted");
      }, reviewATask);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AgentTaskRunError);
    expect((thrown as AgentTaskRunError).phase).toBe("agent-error");
    expect(artifactExists(context, reviewARef(0))).toBe(false);
  });

  test("classifies a missing structured submission without creating a review artifact", async () => {
    const context = await createContext();
    await writeReadyThroughPlan(context);
    await writeArtifact(context, "implementationLog", JSON.stringify(changeReport()));
    await writeArtifact(context, refinementLogRef(0), JSON.stringify(changeReport()));

    let thrown: unknown;
    try {
      await runReviewTask(context, async () => {
        await noopAsync();
        return "Looks good.";
      }, reviewATask);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AgentTaskRunError);
    expect((thrown as AgentTaskRunError).phase).toBe("output-contract");
    expect(artifactExists(context, reviewARef(0))).toBe(false);
  });
});

async function writeReadyThroughPlan(context: Awaited<ReturnType<typeof createContext>>) {
  await writeJsonArtifact(context, "triage", triageResult());
  await writeJsonArtifact(context, "implementationPlanDraft", implementationPlanResult());
  await writeJsonArtifact(context, "implementationPlan", implementationPlanResult());
  await writeArtifact(context, "preImplementationBaseline", JSON.stringify({ head: "abc123", capturedAt: "now", excludes: [".roark"] }));
}

async function writeReadyThroughReviews(context: Awaited<ReturnType<typeof createContext>>) {
  await writeReadyThroughPlan(context);
  await writeArtifact(context, "implementationLog", JSON.stringify(changeReport()));
  await writeArtifact(context, refinementLogRef(0), JSON.stringify(changeReport()));
  await writeArtifact(context, reviewARef(0), JSON.stringify(reviewResult()));
  await writeArtifact(context, reviewBRef(0), JSON.stringify(reviewResult()));
}

describe("runAgentTask transient agent retry", () => {
  test("retries transient connection errors before writing the phase artifact", async () => {
        await noopAsync();
    const context = await createContext();
    const validTriage = triageResult();
    let calls = 0;
    const sleeps: number[] = [];
    const runner: AgentRunner = async (request) => {
      await noopAsync();
      calls++;
      if (calls === 1) throw new Error("openai-codex/gpt-5.5 failed: WebSocket closed 1006 Connection ended");
      return submitTriage(request, validTriage);
    };

    const result = await runTriageTask(context, runner, {
      delaysMs: [0, 60_000, 180_000],
      sleep: async (ms) => {
        await noopAsync();
        sleeps.push(ms);
      },
    });

    expect(result).toEqual(validTriage);
    expect(calls).toBe(2);
    expect(sleeps).toEqual([]);
    expect(JSON.parse(await readArtifact(context, "triage"))).toEqual(validTriage);
  });

  test("adds partial-edit guidance when file-editing tools are enabled", async () => {
    const context = await createContext();
    await writeJsonArtifact(context, "triage", triageResult());
    await writeJsonArtifact(context, "implementationPlan", implementationPlanResult());
    const prompts: string[] = [];
    const runner: AgentRunner = async (request) => {
      await noopAsync();
      prompts.push(request.prompt);
      if (prompts.length === 1) throw new Error("openai-codex/gpt-5.5 failed: WebSocket closed 1006 Connection ended");
      return submitChangeReport(request, changeReport());
    };

    expect(runChangeReportTask(context, runner, implementationTask, {
      delaysMs: [0, 60_000, 180_000],
      sleep: async () => {
        await noopAsync();},
    })).resolves.toEqual(changeReport());

    expect(prompts).toHaveLength(2);
    expect(prompts[0]).not.toContain("<transient_connection_retry>");
    expect(prompts[1]).toContain("<transient_connection_retry>");
    expect(prompts[1]).toContain("It may have already modified files in the working tree.");
    expect(prompts[1]).toContain("Inspect the current diff before editing");
  });

  test("does not write diagnostic artifacts while transient retries remain", async () => {
    const context = await createContext();
    const validTriage = triageResult();
    let calls = 0;
    const runner: AgentRunner = async (request) => {
      await noopAsync();
      calls++;
      expect(artifactExists(context, "triage")).toBe(false);
      if (calls < 4) throw new Error("openai-codex/gpt-5.5 failed: WebSocket closed 1006 Connection ended");
      return submitTriage(request, validTriage);
    };

    expect(runTriageTask(context, runner, {
      delaysMs: [0, 1, 2],
      sleep: async () => {
        await noopAsync();},
    })).resolves.toEqual(validTriage);

    expect(calls).toBe(4);
    expect(JSON.parse(await readArtifact(context, "triage"))).toEqual(validTriage);
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

    expect(runTriageTask(context, runner, {
      delaysMs: [0, 60_000, 180_000],
      sleep: async (ms) => {
        await noopAsync();
        sleeps.push(ms);
      },
    })).rejects.toThrow(AgentTaskRunError);

    expect(calls).toBe(4);
    expect(sleeps).toEqual([60_000, 180_000]);
    expect(artifactExists(context, "triage")).toBe(false);
  });
});
