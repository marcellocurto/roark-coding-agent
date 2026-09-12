import type { ApplicationServices } from "../runtime/application.ts";
import type { Scope } from "effect";
import { Cause, Clock, Deferred, Exit, Effect, Fiber } from "effect";
import { Schema } from "effect";
import { toolContext } from "../testing/tool-context.ts";
import { runApplicationPromise } from "../runtime/application.ts";
import { provideTestAgent, type AgentRunner } from "../testing/agents.ts";
import { fixedWallClock } from "../testing/clock.ts";
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
import { artifactContract } from "./contract.ts";
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
  test.each(["success", "failure", "interrupt"] as const)(
    "waits for the agent after submission before persisting: %s",
    async (outcome) => {
      const writes: string[] = [];
      let agentFinished = false;
      let invocations = 0;
      await runApplicationPromise(
        Effect.gen(function* () {
          const accepted = yield* Deferred.make<undefined>();
          const finish = yield* Deferred.make<undefined>();
          const schema = Schema.Struct({ summary: Schema.String });
          const running = yield* Effect.forkScoped(
            runTestArtifact(
              request,
              Effect.fnUntraced(
                function* (request) {
                  invocations++;
                  const tool = request.customTools?.find(
                    (tool) => tool.name === "submit_example",
                  );
                  if (!tool)
                    return yield* Effect.die(new Error("missing tool"));
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
                  yield* Deferred.succeed(accepted, undefined);
                  yield* Deferred.await(finish);
                  if (outcome === "failure")
                    return yield* Effect.fail(
                      new Error("fetch failed after submission"),
                    );
                  return "";
                },
                Effect.ensuring(
                  Effect.sync(() => {
                    agentFinished = true;
                  }),
                ),
              ),
              {
                toolName: "submit_example",
                label: "Example",
                noun: "example",
                parameters: schema,
                validate: artifactContract("Example", schema).decode,
                formatMarkdown: (value) => value.summary,
              },
              {
                writeMarkdown: () =>
                  Effect.sync(() => {
                    expect(agentFinished).toBe(true);
                    writes.push("markdown");
                  }),
                writeJson: () =>
                  Effect.sync(() => {
                    writes.push("json");
                  }),
              },
            ),
          );
          yield* Deferred.await(accepted);
          expect(agentFinished).toBe(false);
          expect(writes).toEqual([]);
          if (outcome === "interrupt") yield* Fiber.interrupt(running);
          else yield* Deferred.succeed(finish, undefined);
          const exit = yield* Fiber.await(running);
          expect(agentFinished).toBe(true);
          expect(invocations).toBe(1);
          expect(Exit.isSuccess(exit)).toBe(outcome === "success");
          if (Exit.isFailure(exit)) {
            if (outcome === "interrupt")
              expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
            else
              expect(Cause.pretty(exit.cause)).toContain(
                "fetch failed after submission",
              );
          }
          expect(writes).toEqual(
            outcome === "success" ? ["markdown", "json"] : [],
          );
        }).pipe(Effect.scoped),
      );
    },
  );
  test("aborting a tool call interrupts validation and writes no artifacts even when the SDK handles the rejection", async () => {
    const controller = new AbortController();
    let validationFinished = false;
    let writes = 0;
    try {
      await runApplicationPromise(
        Effect.gen(function* () {
          const started = yield* Deferred.make<undefined>();
          const running = yield* Effect.forkScoped(
            runTestArtifact(
              request,
              Effect.fnUntraced(function* (request) {
                const tool = request.customTools?.find(
                  (tool) => tool.name === "submit_example",
                );
                if (!tool) return yield* Effect.die(new Error("missing tool"));
                return yield* Effect.tryPromise({
                  try: () =>
                    tool.execute(
                      "submit",
                      { summary: "accepted" },
                      controller.signal,
                      undefined,
                      toolContext,
                    ),
                  catch: (error) => error,
                }).pipe(
                  Effect.catch(() => Effect.never),
                  Effect.as(""),
                );
              }),
              {
                toolName: "submit_example",
                label: "Example",
                noun: "example",
                parameters: Schema.Struct({ summary: Schema.String }),
                validate: () =>
                  Deferred.succeed(started, undefined).pipe(
                    Effect.andThen(Effect.never),
                    Effect.ensuring(
                      Effect.sync(() => {
                        validationFinished = true;
                      }),
                    ),
                  ),
                formatMarkdown: () => "unused",
              },
              {
                writeMarkdown: () =>
                  Effect.sync(() => {
                    writes++;
                  }),
                writeJson: () =>
                  Effect.sync(() => {
                    writes++;
                  }),
              },
            ),
          );
          yield* Deferred.await(started);
          controller.abort();
          const exit = yield* Fiber.await(running);
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit))
            expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
          expect(validationFinished).toBe(true);
          expect(writes).toBe(0);
        }).pipe(Effect.scoped),
      );
    } finally {
      controller.abort();
    }
  });
  test("validates with the caller's clock and persists matching JSON and Markdown", async () => {
    let validationTime: number | undefined;
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
          parameters: Schema.Struct({ summary: Schema.NonEmptyString }),
          validate: Effect.fnUntraced(function* (value) {
            validationTime = yield* Clock.currentTimeMillis;
            return yield* artifactContract(
              "Example",
              Schema.Struct({ summary: Schema.String }),
            ).decode(value);
          }),
          formatMarkdown: (value) => `# Example\n\n${value.summary}\n`,
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
      ).pipe(Effect.provide(fixedWallClock("2000-01-01T00:00:00.000Z"))),
    );
    expect(validationTime).toBe(946684800000);
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
          parameters: Schema.Struct({ summary: Schema.String }),
          validate: artifactContract(
            "Example",
            Schema.Struct({ summary: Schema.String }),
          ).decode,
          formatMarkdown: (value) => value.summary,
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
          parameters: Schema.Struct({ summary: Schema.String }),
          validate: artifactContract(
            "Example",
            Schema.Struct({ summary: Schema.String }),
          ).decode,
          formatMarkdown: (value) => value.summary,
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

for (const phase of ["validation", "formatting"] as const) {
  test(`${phase} defects escape even when the SDK handles tool errors`, async () => {
    const defect = new Error(`${phase} bug`);
    let writes = 0;
    const schema = Schema.Struct({ summary: Schema.String });
    const contract = artifactContract(
      "Example",
      schema.check(
        Schema.makeFilter(() => {
          if (phase === "validation") throw defect;
          return true;
        }),
      ),
    );
    const exit = await runApplicationPromise(
      Effect.exit(
        runTestArtifact(
          request,
          Effect.fnUntraced(function* (request) {
            const tool = request.customTools?.find(
              (tool) => tool.name === "submit_example",
            );
            if (!tool) return yield* Effect.die(new Error("missing tool"));
            // Pi reports rejected tool calls to the agent instead of failing the session.
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
            }).pipe(Effect.catch(() => Effect.void));
            return "agent continued after the tool result";
          }),
          {
            toolName: "submit_example",
            label: "Example",
            noun: "example",
            parameters: schema,
            validate: contract.decode,
            formatMarkdown: (value) => {
              if (phase === "formatting") throw defect;
              return value.summary;
            },
          },
          {
            writeJson: () =>
              Effect.sync(() => {
                writes += 1;
              }),
            writeMarkdown: () =>
              Effect.sync(() => {
                writes += 1;
              }),
          },
        ),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.hasDies(exit.cause)).toBe(true);
      expect(Cause.hasFails(exit.cause)).toBe(false);
      expect(Cause.squash(exit.cause)).toBe(defect);
    }
    expect(writes).toBe(0);
  });
}

test("allows correcting invalid output and accepts exactly one concurrent submission", async () => {
  let json = "";
  let writes = 0;
  const schema = Schema.Struct({ summary: Schema.NonEmptyString });
  const contract = artifactContract("Example", schema);
  const result = await runApplicationPromise(
    runTestArtifact(
      request,
      Effect.fnUntraced(function* (request) {
        const tool = request.customTools?.find(
          (tool) => tool.name === "submit_example",
        );
        if (!tool) return yield* Effect.die(new Error("missing tool"));
        const invalid = yield* Effect.tryPromise({
          try: () =>
            tool.execute(
              "invalid",
              { summary: "" },
              undefined,
              undefined,
              toolContext,
            ),
          catch: (error) => error,
        }).pipe(Effect.result);
        expect(invalid._tag).toBe("Failure");
        expect(writes).toBe(0);
        const submitted = yield* Effect.all(
          ["first", "second"].map((summary) =>
            Effect.tryPromise({
              try: () =>
                tool.execute(
                  summary,
                  { summary },
                  undefined,
                  undefined,
                  toolContext,
                ),
              catch: (error) => error,
            }).pipe(Effect.result),
          ),
          { concurrency: "unbounded" },
        );
        expect(
          submitted.filter((result) => result._tag === "Success"),
        ).toHaveLength(1);
        expect(
          submitted.filter((result) => result._tag === "Failure"),
        ).toHaveLength(1);
        return "";
      }),
      {
        toolName: "submit_example",
        label: "Example",
        noun: "example",
        parameters: schema,
        validate: (value) =>
          contract.decode(value).pipe(Effect.delay("1 millis")),
        formatMarkdown: (value) => value.summary,
      },
      {
        writeJson: (content) =>
          Effect.sync(() => {
            json = content;
            writes += 1;
          }),
        writeMarkdown: () => Effect.void,
      },
    ),
  );
  expect(writes).toBe(1);
  expect(JSON.parse(json)).toEqual(result.value);
  expect(["first", "second"]).toContain(result.value.summary);
});
