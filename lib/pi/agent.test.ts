import { describe, expect, test } from "bun:test";
import { assertNoResourceLoadErrors, assertRequestedSkillsLoaded, buildRoarkResourceLoaderSecurityOptions, defaultRoarkModel, extractAgentErrorMessage, requestedModelSpec, roarkPiSettings } from "./agent.ts";

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

  test("explicit skill paths do not re-enable ambient skill discovery", () => {
    expect(buildRoarkResourceLoaderSecurityOptions(["/repo/skills/github-issue-create"])).toEqual({
      noExtensions: true,
      noPromptTemplates: true,
      noSkills: true,
      additionalSkillPaths: ["/repo/skills/github-issue-create"],
    });
  });

  test("surfaces resource loading errors before an agent session starts", () => {
    expect(() => { assertNoResourceLoadErrors([{ type: "error", message: "missing skill", path: "/repo/skills/github-issue-create" }], "skill"); })
      .toThrow("Pi skill loading failed: error: missing skill (/repo/skills/github-issue-create)");
  });

  test("fails before an agent session starts when a requested skill path did not load", () => {
    expect(() => { assertRequestedSkillsLoaded([], ["/repo/skills/github-issue-create"], [{
      type: "warning",
      message: "Flow sequence in block collection must be sufficiently indented",
      path: "/repo/skills/github-issue-create/SKILL.md",
    }]); }).toThrow("requested skill path(s) did not load: /repo/skills/github-issue-create");
  });

  test("accepts requested skill paths that loaded at least one skill", () => {
    expect(() => { assertRequestedSkillsLoaded([{
      name: "github-issue-create",
      description: "Create GitHub issues.",
      filePath: "/repo/skills/github-issue-create/SKILL.md",
      baseDir: "/repo/skills/github-issue-create",
      sourceInfo: {} as never,
      disableModelInvocation: false,
    }], ["/repo/skills/github-issue-create"]); }).not.toThrow();
  });
});

describe("Pi agent model selection", () => {
  test("hard defaults to GPT 5.5 when no model override is provided", () => {
    expect(defaultRoarkModel).toBe("openai-codex/gpt-5.5");
    expect(requestedModelSpec()).toBe("openai-codex/gpt-5.5");
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
