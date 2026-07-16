import { describe, expect, test } from "bun:test";
import { Type } from "typebox";
import type { AgentRunRequest } from "../workflow/agent-runner.ts";
import { runStructuredArtifact } from "./runner.ts";

const request: AgentRunRequest = {
  cwd: "/repo",
  model: "openai-codex/gpt-5.6-sol",
  thinkingLevel: "low",
  systemPrompt: "system",
  prompt: "prompt",
  fileEditingToolsEnabled: false,
  display: {
    command: "test",
    target: "example",
    phaseId: "structured-example",
    phaseLabel: "Structured example",
    operation: "inspect",
  },
};

describe("runStructuredArtifact", () => {
  test("accepts one terminating submission and persists matching JSON and Markdown", async () => {
    const written: { json?: string; markdown?: string } = {};
    const writeOrder: string[] = [];
    const result = await runStructuredArtifact(request, async (agentRequest) => {
      const tool = agentRequest.customTools?.find((candidate) => candidate.name === "submit_example");
      if (!tool) throw new Error("missing tool");
      await tool.execute("submit", { summary: "accepted" }, undefined, undefined, {} as never);
      return "ignored agent prose";
    }, {
      toolName: "submit_example",
      label: "Example",
      noun: "example",
      parameters: Type.Object({ summary: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
      validate: (value) => value as { summary: string },
      formatMarkdown: (value) => `# Example\n\n${value.summary}\n`,
      createError: (message) => new Error(message),
    }, {
      writeJson: (content) => { writeOrder.push("json"); written.json = content; return Promise.resolve(); },
      writeMarkdown: (content) => { writeOrder.push("markdown"); written.markdown = content; return Promise.resolve(); },
    });

    expect(result).toEqual({ value: { summary: "accepted" }, markdown: "# Example\n\naccepted\n" });
    expect(written).toEqual({
      json: '{\n  "summary": "accepted"\n}',
      markdown: "# Example\n\naccepted\n",
    });
    expect(writeOrder).toEqual(["markdown", "json"]);
  });

  test("writes nothing when the agent does not submit", async () => {
    let writes = 0;
    const run = runStructuredArtifact(request, () => Promise.resolve('{"summary":"not submitted"}'), {
      toolName: "submit_example",
      label: "Example",
      noun: "example",
      parameters: Type.Object({ summary: Type.String() }),
      validate: (value) => value as { summary: string },
      formatMarkdown: (value) => value.summary,
      createError: (message) => new Error(message),
    }, {
      writeJson: () => { writes += 1; return Promise.resolve(); },
      writeMarkdown: () => { writes += 1; return Promise.resolve(); },
    });

    expect(run).rejects.toThrow("without calling submit_example");
    await run.catch(() => undefined);
    expect(writes).toBe(0);
  });

  test("does not commit canonical JSON when Markdown persistence fails", async () => {
    let jsonWrites = 0;
    const run = runStructuredArtifact(request, async (agentRequest) => {
      const tool = agentRequest.customTools?.find((candidate) => candidate.name === "submit_example");
      if (!tool) throw new Error("missing tool");
      await tool.execute("submit", { summary: "accepted" }, undefined, undefined, {} as never);
      return "";
    }, {
      toolName: "submit_example",
      label: "Example",
      noun: "example",
      parameters: Type.Object({ summary: Type.String() }),
      validate: (value) => value as { summary: string },
      formatMarkdown: (value) => value.summary,
      createError: (message) => new Error(message),
    }, {
      writeJson: () => { jsonWrites += 1; return Promise.resolve(); },
      writeMarkdown: () => Promise.reject(new Error("disk full")),
    });

    expect(run).rejects.toThrow("disk full");
    await run.catch(() => undefined);
    expect(jsonWrites).toBe(0);
  });
});
