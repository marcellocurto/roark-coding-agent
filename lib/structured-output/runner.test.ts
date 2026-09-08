import type { ApplicationServices } from "../runtime/application.ts";
import type { Scope } from "effect";
import { Effect } from "effect";
import { Schema } from "effect";
import { toolContext } from "../testing/tool-context.ts";
import { runApplicationPromise } from "../runtime/application.ts";
import { provideTestAgent, type AgentRunner } from "../testing/agents.ts";
import { type AgentRunRequest } from "../workflow/agent-runner.ts";
import {
  runStructuredArtifact,
  type StructuredArtifactDefinition,
} from "./runner.ts";
interface TestArtifactWriters {
  writeJson: (
    content: string,
  ) => Effect.Effect<void, unknown, ApplicationServices | Scope.Scope>;
  writeMarkdown: (
    content: string,
  ) => Effect.Effect<void, unknown, ApplicationServices | Scope.Scope>;
}
const runTestArtifact = Effect.fnUntraced(function* <T>(
  request: AgentRunRequest,
  runner: AgentRunner,
  definition: StructuredArtifactDefinition<T>,
  writers: TestArtifactWriters,
) {
  return yield* runStructuredArtifact(request, definition, writers).pipe(
    provideTestAgent(runner),
    Effect.scoped,
  );
});
import { describe, expect, test } from "bun:test";
import { Type } from "typebox";
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
    const written: {
      json?: string;
      markdown?: string;
    } = {};
    const writeOrder: string[] = [];
    const result = await runApplicationPromise(
      runTestArtifact<{
        summary: string;
      }>(
        request,
        Effect.fnUntraced(function* (agentRequest) {
          const tool = agentRequest.customTools?.find(
            (candidate) => candidate.name === "submit_example",
          );
          if (!tool) return yield* Effect.fail(new Error("missing tool"));
          yield* Effect.tryPromise({
            try: () =>
              tool.execute(
                "submit",
                { summary: "accepted" },
                undefined,
                undefined,
                toolContext,
              ),
            catch: (error) => error,
          });
          return "ignored agent prose";
        }),
        {
          toolName: "submit_example",
          label: "Example",
          noun: "example",
          parameters: Type.Object(
            { summary: Type.String({ minLength: 1 }) },
            { additionalProperties: false },
          ),
          validate: Schema.decodeUnknownSync(
            Schema.Struct({ summary: Schema.String }),
          ),
          formatMarkdown: (value) => `# Example\n\n${value.summary}\n`,
          createError: (message) => new Error(message),
        },
        {
          writeJson: Effect.fnUntraced(function* (content) {
            writeOrder.push("json");
            written.json = content;
            return yield* Effect.void;
          }),
          writeMarkdown: Effect.fnUntraced(function* (content) {
            writeOrder.push("markdown");
            written.markdown = content;
            return yield* Effect.void;
          }),
        },
      ),
    );
    expect(result).toEqual({
      value: { summary: "accepted" },
      markdown: "# Example\n\naccepted\n",
    });
    expect(written).toEqual({
      json: '{\n  "summary": "accepted"\n}',
      markdown: "# Example\n\naccepted\n",
    });
    expect(writeOrder).toEqual(["markdown", "json"]);
  });
  test("writes nothing when the agent does not submit", async () => {
    let writes = 0;
    const run = runApplicationPromise(
      runTestArtifact<{
        summary: string;
      }>(
        request,
        Effect.fnUntraced(function* () {
          return yield* Effect.succeed('{"summary":"not submitted"}');
        }),
        {
          toolName: "submit_example",
          label: "Example",
          noun: "example",
          parameters: Type.Object({ summary: Type.String() }),
          validate: Schema.decodeUnknownSync(
            Schema.Struct({ summary: Schema.String }),
          ),
          formatMarkdown: (value) => value.summary,
          createError: (message) => new Error(message),
        },
        {
          writeJson: Effect.fnUntraced(function* () {
            writes += 1;
            return yield* Effect.void;
          }),
          writeMarkdown: Effect.fnUntraced(function* () {
            writes += 1;
            return yield* Effect.void;
          }),
        },
      ),
    );
    expect(run).rejects.toThrow("without calling submit_example");
    await run.catch(() => undefined);
    expect(writes).toBe(0);
  });
  test("does not commit canonical JSON when Markdown persistence fails", async () => {
    let jsonWrites = 0;
    const run = runApplicationPromise(
      runTestArtifact<{
        summary: string;
      }>(
        request,
        Effect.fnUntraced(function* (agentRequest) {
          const tool = agentRequest.customTools?.find(
            (candidate) => candidate.name === "submit_example",
          );
          if (!tool) return yield* Effect.fail(new Error("missing tool"));
          yield* Effect.tryPromise({
            try: () =>
              tool.execute(
                "submit",
                { summary: "accepted" },
                undefined,
                undefined,
                toolContext,
              ),
            catch: (error) => error,
          });
          return "";
        }),
        {
          toolName: "submit_example",
          label: "Example",
          noun: "example",
          parameters: Type.Object({ summary: Type.String() }),
          validate: Schema.decodeUnknownSync(
            Schema.Struct({ summary: Schema.String }),
          ),
          formatMarkdown: (value) => value.summary,
          createError: (message) => new Error(message),
        },
        {
          writeJson: Effect.fnUntraced(function* () {
            jsonWrites += 1;
            return yield* Effect.void;
          }),
          writeMarkdown: Effect.fnUntraced(function* () {
            return yield* Effect.tryPromise({
              try: () => Promise.reject(new Error("disk full")),
              catch: (error) => error,
            });
          }),
        },
      ),
    );
    expect(run).rejects.toThrow("disk full");
    await run.catch(() => undefined);
    expect(jsonWrites).toBe(0);
  });
});
