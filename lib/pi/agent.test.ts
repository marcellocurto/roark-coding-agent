import { runApplicationPromise } from "../runtime/application.ts";
import { AgentExecution } from "../runtime/services.ts";
import {
  AgentExecutionError,
  assertNoResourceLoadErrors,
  assertRequestedSkillsLoaded,
  buildRoarkResourceLoaderSecurityOptions,
  createRoarkResourceLoader,
  extractAgentErrorMessage,
  requestedModelSpec,
  resolveModel,
  roarkPiSettings,
  toolsForFileEditingMode,
} from "./agent.ts";
import { Deferred, Effect } from "effect";
import { applicationLayer, fromLegacyPromise } from "../runtime/application.ts";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, spyOn, test } from "bun:test";
import * as PiCodingAgent from "@earendil-works/pi-coding-agent";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { prPublishingSystemPrompt } from "../prompts/pr-publishing-prompt.ts";
import { sharedSystemPrompt } from "../prompts/workflow-prompts.ts";
import { agentSkillPaths, bundledSkillNames } from "./bundled-skills.ts";
const agentContextSentinel = "AGENT_CONTEXT_SENTINEL";
const ancestorContextSentinel = "ANCESTOR_CONTEXT_SENTINEL";
async function createPromptFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "roark-prompt-test-"));
  const cwd = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  const skillPath = path.join(root, "skills", "prompt-contract-test");
  await mkdir(cwd, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await mkdir(skillPath, { recursive: true });
  await writeFile(
    path.join(cwd, "AGENTS.md"),
    "# Prompt contract project\n\nPROJECT_CONTEXT_SENTINEL\n",
  );
  await writeFile(
    path.join(root, "CLAUDE.md"),
    `# Ancestor context\n\n${ancestorContextSentinel}\n`,
  );
  await writeFile(
    path.join(agentDir, "AGENTS.md"),
    `# Machine-local agent context\n\n${agentContextSentinel}\n`,
  );
  await writeFile(
    path.join(skillPath, "SKILL.md"),
    `---
name: prompt-contract-test
description: PROMPT_SKILL_SENTINEL
---

# Prompt contract test
`,
  );
  return { root, cwd, agentDir, skillPath };
}
async function createPromptTestSession(options: {
  cwd: string;
  agentDir: string;
  skillPath: string;
  systemPrompt: string;
  fileEditingToolsEnabled: boolean;
}) {
  const settingsManager = SettingsManager.inMemory(roarkPiSettings);
  settingsManager.setProjectTrusted(true);
  const loader = createRoarkResourceLoader({
    cwd: options.cwd,
    agentDir: options.agentDir,
    settingsManager,
    skillPaths: [options.skillPath],
    systemPrompt: options.systemPrompt,
  });
  await loader.reload();
  const loadedSkills = loader.getSkills();
  assertNoResourceLoadErrors(loadedSkills.diagnostics, "skill");
  assertRequestedSkillsLoaded(
    loadedSkills.skills,
    [options.skillPath],
    loadedSkills.diagnostics,
  );
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  const model = resolveModel(modelRuntime, requestedModelSpec());
  const { session } = await createAgentSession({
    cwd: options.cwd,
    modelRuntime,
    model,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(options.cwd),
    settingsManager,
    tools: [...toolsForFileEditingMode(options.fileEditingToolsEnabled)],
  });
  return session;
}
function occurrenceCount(value: string, search: string): number {
  return value.split(search).length - 1;
}
describe("Pi agent settings", () => {
  test("forces SSE transport for automated Roark sessions", () => {
    expect(roarkPiSettings.transport).toBe("sse");
  });
  test("disables ambient skills, extensions, and prompt templates", () => {
    expect(buildRoarkResourceLoaderSecurityOptions()).toEqual({
      noExtensions: true,
      noPromptTemplates: true,
      noSkills: true,
      additionalSkillPaths: [],
    });
  });
  test("shell inspection mode retains bash without dedicated file-editing tools", () => {
    expect(toolsForFileEditingMode(false)).toEqual([
      "read",
      "bash",
      "grep",
      "find",
      "ls",
    ]);
    expect(toolsForFileEditingMode(false)).not.toContain("edit");
    expect(toolsForFileEditingMode(false)).not.toContain("write");
  });
  test("explicit skill paths do not re-enable ambient skill discovery", () => {
    expect(
      buildRoarkResourceLoaderSecurityOptions(["/repo/skills/example-skill"]),
    ).toEqual({
      noExtensions: true,
      noPromptTemplates: true,
      noSkills: true,
      additionalSkillPaths: ["/repo/skills/example-skill"],
    });
  });
  test("surfaces resource loading errors before an agent session starts", () => {
    expect(() => {
      assertNoResourceLoadErrors(
        [
          {
            type: "error",
            message: "missing skill",
            path: "/repo/skills/example-skill",
          },
        ],
        "skill",
      );
    }).toThrow(
      "Pi skill loading failed: error: missing skill (/repo/skills/example-skill)",
    );
  });
  test("fails before an agent session starts when a requested skill path did not load", () => {
    expect(() => {
      assertRequestedSkillsLoaded(
        [],
        ["/repo/skills/example-skill"],
        [
          {
            type: "warning",
            message:
              "Flow sequence in block collection must be sufficiently indented",
            path: "/repo/skills/example-skill/SKILL.md",
          },
        ],
      );
    }).toThrow(
      "requested skill path(s) did not load: /repo/skills/example-skill",
    );
  });
  test("accepts requested skill paths that loaded at least one skill", () => {
    expect(() => {
      assertRequestedSkillsLoaded(
        [
          {
            name: "example-skill",
            description: "Example skill.",
            filePath: "/repo/skills/example-skill/SKILL.md",
            baseDir: "/repo/skills/example-skill",
            sourceInfo: {} as never,
            disableModelInvocation: false,
          },
        ],
        ["/repo/skills/example-skill"],
      );
    }).not.toThrow();
  });
  test("loads every bundled skill without enabling ambient discovery", async () => {
    const skillPaths = agentSkillPaths();
    const settingsManager = SettingsManager.inMemory(roarkPiSettings);
    const loader = new DefaultResourceLoader({
      cwd: import.meta.dir,
      agentDir: getAgentDir(),
      settingsManager,
      ...buildRoarkResourceLoaderSecurityOptions(skillPaths),
    });
    await loader.reload();
    const loaded = loader.getSkills();
    assertNoResourceLoadErrors(loaded.diagnostics, "skill");
    assertRequestedSkillsLoaded(loaded.skills, skillPaths, loaded.diagnostics);
    expect(loaded.skills.map((skill) => skill.name).sort()).toEqual(
      [...bundledSkillNames].sort(),
    );
  });
});
describe("Roark effective system prompt", () => {
  test("uses the isolated production loader for read, write, and publishing sessions", async () => {
    const fixture = await createPromptFixture();
    const sessions: Awaited<ReturnType<typeof createPromptTestSession>>[] = [];
    const sessionCases = [
      { systemPrompt: sharedSystemPrompt, fileEditingToolsEnabled: false },
      { systemPrompt: sharedSystemPrompt, fileEditingToolsEnabled: true },
      {
        systemPrompt: prPublishingSystemPrompt(),
        fileEditingToolsEnabled: false,
      },
    ];
    try {
      for (const sessionCase of sessionCases) {
        const session = await createPromptTestSession({
          ...fixture,
          ...sessionCase,
        });
        sessions.push(session);
        const prompt = session.agent.state.systemPrompt;
        const toolNames = session.agent.state.tools.map((tool) => tool.name);
        const readTool = session.agent.state.tools.find(
          (tool) => tool.name === "read",
        );
        expect(prompt.startsWith(sessionCase.systemPrompt)).toBe(true);
        expect(occurrenceCount(prompt, sessionCase.systemPrompt)).toBe(1);
        expect(prompt).toContain("PROJECT_CONTEXT_SENTINEL");
        expect(prompt).not.toContain(ancestorContextSentinel);
        expect(prompt).not.toContain(agentContextSentinel);
        expect(prompt).toContain("<name>prompt-contract-test</name>");
        expect(prompt).toContain(
          "<description>PROMPT_SKILL_SENTINEL</description>",
        );
        expect(prompt).toContain(
          `Current working directory: ${fixture.cwd.replace(/\\/g, "/")}`,
        );
        expect(readTool?.description.length).toBeGreaterThan(0);
        expect(readTool?.parameters).toBeDefined();
        expect(toolNames).toContain("read");
        expect(toolNames.includes("edit")).toBe(
          sessionCase.fileEditingToolsEnabled,
        );
        expect(toolNames.includes("write")).toBe(
          sessionCase.fileEditingToolsEnabled,
        );
      }
    } finally {
      for (const session of sessions) session.dispose();
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
  test("excludes the agent-directory context when it is nested under the project", async () => {
    const fixture = await createPromptFixture();
    const nestedAgentDir = path.join(fixture.cwd, ".pi-agent");
    let session:
      | Awaited<ReturnType<typeof createPromptTestSession>>
      | undefined;
    try {
      await mkdir(nestedAgentDir);
      await writeFile(
        path.join(nestedAgentDir, "AGENTS.md"),
        agentContextSentinel,
      );
      session = await createPromptTestSession({
        ...fixture,
        agentDir: nestedAgentDir,
        systemPrompt: sharedSystemPrompt,
        fileEditingToolsEnabled: false,
      });
      expect(session.agent.state.systemPrompt).toContain(
        "PROJECT_CONTEXT_SENTINEL",
      );
      expect(session.agent.state.systemPrompt).not.toContain(
        agentContextSentinel,
      );
    } finally {
      session?.dispose();
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
  test("does not read project SYSTEM.md and APPEND_SYSTEM.md", async () => {
    const fixture = await createPromptFixture();
    const errorSpy = spyOn(console, "error").mockImplementation(
      () => undefined,
    );
    let session:
      | Awaited<ReturnType<typeof createPromptTestSession>>
      | undefined;
    try {
      await mkdir(path.join(fixture.cwd, ".pi", "SYSTEM.md"), {
        recursive: true,
      });
      await mkdir(path.join(fixture.cwd, ".pi", "APPEND_SYSTEM.md"));
      session = await createPromptTestSession({
        ...fixture,
        systemPrompt: sharedSystemPrompt,
        fileEditingToolsEnabled: false,
      });
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
      session?.dispose();
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
  test("does not read agent-directory SYSTEM.md and APPEND_SYSTEM.md", async () => {
    const fixture = await createPromptFixture();
    const errorSpy = spyOn(console, "error").mockImplementation(
      () => undefined,
    );
    let session:
      | Awaited<ReturnType<typeof createPromptTestSession>>
      | undefined;
    try {
      await mkdir(path.join(fixture.agentDir, "SYSTEM.md"));
      await mkdir(path.join(fixture.agentDir, "APPEND_SYSTEM.md"));
      session = await createPromptTestSession({
        ...fixture,
        systemPrompt: sharedSystemPrompt,
        fileEditingToolsEnabled: false,
      });
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
      session?.dispose();
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});
describe("Pi custom tool boundary", () => {
  test("passes custom tools to the production session factory", async () => {
    const stop = new Error("stop after session options are captured");
    const createSession = spyOn(
      PiCodingAgent,
      "createAgentSession",
    ).mockRejectedValue(stop);
    const submitReview = { name: "submit_review" } as never;
    try {
      let thrown: unknown;
      try {
        await runApplicationPromise(
          Effect.flatMap(AgentExecution, (agent) =>
            agent.run({
              cwd: import.meta.dir,
              thinkingLevel: "minimal",
              systemPrompt: "Review the change.",
              prompt: "Inspect the diff.",
              fileEditingToolsEnabled: false,
              customTools: [submitReview],
              display: {
                command: "review-pr",
                target: "PR #1",
                phaseId: "pr-review-a",
                phaseLabel: "PR review A",
                operation: "review",
              },
            }),
          ),
        );
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AgentExecutionError);
      if (thrown instanceof AgentExecutionError)
        expect(thrown.cause).toBe(stop);
      const options = createSession.mock.calls[0]?.[0];
      expect(options?.customTools).toEqual([submitReview]);
      expect(options?.tools).toContain("submit_review");
    } finally {
      createSession.mockRestore();
    }
  });
});
describe("Pi agent model selection", () => {
  test("defaults to the built-in GPT-6 Astra catalog entry", async () => {
    expect(requestedModelSpec()).toBe("openai-codex/gpt-6-astra");
    const registry = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      refreshOnCreate: false,
    });
    expect(resolveModel(registry, requestedModelSpec()).id).toBe("gpt-6-astra");
  });
  test("fails clearly for an unavailable model", async () => {
    const registry = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      refreshOnCreate: false,
    });
    expect(() =>
      resolveModel(registry, "openai-codex/not-a-real-model"),
    ).toThrow("Model not found");
  });
  test("still honors an explicit model override", () => {
    expect(requestedModelSpec("openrouter/deepseek/deepseek-v4-pro")).toBe(
      "openrouter/deepseek/deepseek-v4-pro",
    );
  });
});
describe("extractAgentErrorMessage", () => {
  test("surfaces provider errors instead of letting them become empty artifacts", () => {
    const error = extractAgentErrorMessage([
      {
        role: "assistant",
        provider: "anthropic",
        model: "claude-opus-4-7",
        stopReason: "error",
        errorMessage: "quota exhausted",
        content: [],
      },
    ]);
    expect(error).toBe("anthropic/claude-opus-4-7 failed: quota exhausted");
  });
  test("returns undefined when the last assistant message did not error", () => {
    expect(
      extractAgentErrorMessage([
        { role: "assistant", stopReason: "end_turn", content: "ok" },
      ]),
    ).toBeUndefined();
  });
});
test("agent interruption waits for SDK abort and session disposal", async () => {
  const fixture = await createPromptFixture();
  const entered = Deferred.makeUnsafe<undefined>();
  const abortEntered = Deferred.makeUnsafe<undefined>();
  const allowAbort = Deferred.makeUnsafe<undefined>();
  const promptDone = Deferred.makeUnsafe<undefined>();
  const order: string[] = [];
  const restorers: (() => void)[] = [];
  const create = PiCodingAgent.createAgentSession;
  const createSession = spyOn(
    PiCodingAgent,
    "createAgentSession",
  ).mockImplementation(async (options) => {
    const created = await create(options);
    const prompt = spyOn(created.session, "prompt").mockImplementation(
      async () => {
        await Effect.runPromise(Deferred.succeed(entered, undefined));
        await Effect.runPromise(Deferred.await(promptDone));
      },
    );
    const abort = spyOn(created.session, "abort").mockImplementation(
      async () => {
        order.push("abort-started");
        await Effect.runPromise(Deferred.succeed(abortEntered, undefined));
        await Effect.runPromise(Deferred.await(allowAbort));
        await Effect.runPromise(Deferred.succeed(promptDone, undefined));
        order.push("abort-completed");
      },
    );
    const dispose = created.session.dispose.bind(created.session);
    const disposal = spyOn(created.session, "dispose").mockImplementation(
      () => {
        order.push("disposed");
        dispose();
      },
    );
    restorers.push(() => {
      prompt.mockRestore();
      abort.mockRestore();
      disposal.mockRestore();
      dispose();
    });
    return created;
  });
  const controller = new AbortController();
  let finished = false;
  const running = Effect.runPromiseExit(
    fromLegacyPromise((application) =>
      runApplicationPromise(
        Effect.flatMap(AgentExecution, (agent) =>
          agent.run({
            cwd: fixture.cwd,
            thinkingLevel: "high",
            systemPrompt: "Cancellation test",
            prompt: "Test only",
            fileEditingToolsEnabled: false,
            display: {
              command: "do",
              target: "#1",
              phaseId: "cancellation",
              phaseLabel: "Cancellation",
              operation: "inspect",
            },
          }),
        ),
        application,
      ),
    ).pipe(Effect.provide(applicationLayer)),
    { signal: controller.signal },
  ).then((exit) => {
    finished = true;
    return exit;
  });
  try {
    await Effect.runPromise(Deferred.await(entered));
    controller.abort();
    await Effect.runPromise(Deferred.await(abortEntered));
    expect(finished).toBe(false);
    expect(order).toEqual(["abort-started"]);
    await Effect.runPromise(Deferred.succeed(allowAbort, undefined));
    await running;
    expect(order).toEqual(["abort-started", "abort-completed", "disposed"]);
  } finally {
    controller.abort();
    await Effect.runPromise(Deferred.succeed(allowAbort, undefined));
    await running;
    createSession.mockRestore();
    for (const restore of restorers) restore();
    await rm(fixture.root, { recursive: true, force: true });
  }
});
