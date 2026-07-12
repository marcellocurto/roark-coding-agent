import { describe, expect, test } from "bun:test";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { defaultRoarkModel } from "../workflow/model-routing.ts";
import { assertNoResourceLoadErrors, assertRequestedSkillsLoaded, buildRoarkResourceLoaderSecurityOptions, extractAgentErrorMessage, requestedModelSpec, resolveModel, roarkPiSettings, toolsForFileEditingMode } from "./agent.ts";

describe("Pi agent settings", () => {
  test("forces SSE transport for automated Roark sessions", () => {
    expect(roarkPiSettings.transport).toBe("sse");
  });

  test("defaults to no skills, extensions, or prompt templates", () => {
    expect(buildRoarkResourceLoaderSecurityOptions()).toEqual({
      noExtensions: true,
      noPromptTemplates: true,
      noSkills: true,
      additionalSkillPaths: [],
    });
  });

  test("shell inspection mode retains bash without dedicated file-editing tools", () => {
    expect(toolsForFileEditingMode(false)).toEqual(["read", "bash", "grep", "find", "ls"]);
    expect(toolsForFileEditingMode(false)).not.toContain("edit");
    expect(toolsForFileEditingMode(false)).not.toContain("write");
  });

  test("explicit skill paths do not re-enable ambient skill discovery", () => {
    expect(buildRoarkResourceLoaderSecurityOptions(["/repo/skills/example-skill"])).toEqual({
      noExtensions: true,
      noPromptTemplates: true,
      noSkills: true,
      additionalSkillPaths: ["/repo/skills/example-skill"],
    });
  });

  test("surfaces resource loading errors before an agent session starts", () => {
    expect(() => { assertNoResourceLoadErrors([{ type: "error", message: "missing skill", path: "/repo/skills/example-skill" }], "skill"); })
      .toThrow("Pi skill loading failed: error: missing skill (/repo/skills/example-skill)");
  });

  test("fails before an agent session starts when a requested skill path did not load", () => {
    expect(() => { assertRequestedSkillsLoaded([], ["/repo/skills/example-skill"], [{
      type: "warning",
      message: "Flow sequence in block collection must be sufficiently indented",
      path: "/repo/skills/example-skill/SKILL.md",
    }]); }).toThrow("requested skill path(s) did not load: /repo/skills/example-skill");
  });

  test("accepts requested skill paths that loaded at least one skill", () => {
    expect(() => { assertRequestedSkillsLoaded([{
      name: "example-skill",
      description: "Example skill.",
      filePath: "/repo/skills/example-skill/SKILL.md",
      baseDir: "/repo/skills/example-skill",
      sourceInfo: {} as never,
      disableModelInvocation: false,
    }], ["/repo/skills/example-skill"]); }).not.toThrow();
  });
});

describe("Pi agent model selection", () => {
  test("defaults to the built-in GPT-5.6 Sol catalog entry", () => {
    expect(defaultRoarkModel).toBe("openai-codex/gpt-5.6-sol");
    expect(requestedModelSpec()).toBe("openai-codex/gpt-5.6-sol");
    const registry = ModelRegistry.create(AuthStorage.create());
    expect(resolveModel(registry, requestedModelSpec()).id).toBe("gpt-5.6-sol");
  });

  test("fails clearly for an unavailable model", () => {
    const registry = ModelRegistry.create(AuthStorage.create());
    expect(() => resolveModel(registry, "openai-codex/not-a-real-model")).toThrow("Model not found");
  });

  test("still honors an explicit model override", () => {
    expect(requestedModelSpec("openrouter/deepseek/deepseek-v4-pro")).toBe("openrouter/deepseek/deepseek-v4-pro");
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
    expect(extractAgentErrorMessage([{ role: "assistant", stopReason: "end_turn", content: "ok" }])).toBeUndefined();
  });
});
