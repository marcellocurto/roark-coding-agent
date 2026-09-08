import { Cause, Deferred, Effect, Exit, Schema, Semaphore } from "effect";
import { AgentExecution } from "../runtime/services.ts";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { ArtifactContractError } from "./contract.ts";
import type { AgentRunRequest } from "../workflow/agent-runner.ts";

export interface StructuredArtifactDefinition<T> {
  toolName: string;
  label: string;
  noun: string;
  parameters: Schema.Constraint;
  validate: (value: unknown) => Effect.Effect<T, ArtifactContractError>;
  formatMarkdown: (value: T) => string;
}

export interface StructuredArtifactWriters<E = never, R = never> {
  writeJson: (content: string) => Effect.Effect<void, E, R>;
  writeMarkdown: (content: string) => Effect.Effect<void, E, R>;
}

export interface StructuredArtifactResult<T> {
  value: T;
  markdown: string;
}

export const runStructuredArtifact = Effect.fn("runStructuredArtifact")(
  function* <T, E, R>(
    request: AgentRunRequest,
    definition: StructuredArtifactDefinition<T>,
    writers: StructuredArtifactWriters<E, R>,
  ) {
    const agent = yield* AgentExecution;
    let submitted: T | undefined;
    const defect = yield* Deferred.make<never, ArtifactContractError>();
    const submission = yield* Semaphore.make(1);
    const document = Schema.toJsonSchemaDocument(definition.parameters);
    const submit = defineTool({
      name: definition.toolName,
      label: `Submit ${definition.label}`,
      description: `Submit the final structured ${definition.noun}. This is the only valid way to complete this phase.`,
      promptSnippet: `Submit the final schema-validated ${definition.noun}`,
      promptGuidelines: [
        `Use ${definition.toolName} as the final action for this phase.`,
        `Do not return the ${definition.noun} as Markdown or prose after calling ${definition.toolName}.`,
      ],
      parameters: { ...document.schema, $defs: document.definitions },
      async execute(_toolCallId, params, signal) {
        const exit = await Effect.runPromiseExit(
          submission.withPermit(
            Effect.gen(function* () {
              if (submitted !== undefined) {
                return yield* Effect.fail(
                  new ArtifactContractError({
                    artifact: definition.noun,
                    message: `The ${definition.noun} has already been submitted.`,
                  }),
                );
              }
              const value = yield* definition.validate(params);
              submitted = value;
              return value;
            }),
          ),
          { signal },
        );
        if (Exit.isFailure(exit)) {
          if (Cause.hasDies(exit.cause) || Cause.hasInterrupts(exit.cause)) {
            Deferred.doneUnsafe(defect, Exit.failCause(exit.cause));
          }
          throw Cause.squash(exit.cause);
        }
        return {
          content: [
            {
              type: "text" as const,
              text: `Structured ${definition.noun} submitted.`,
            },
          ],
          details: exit.value,
          terminate: true,
        };
      },
    });

    yield* agent
      .run({
        ...request,
        customTools: [...(request.customTools ?? []), submit],
      })
      .pipe(Effect.raceFirst(Deferred.await(defect)));
    if (submitted === undefined) {
      return yield* Effect.fail(
        new ArtifactContractError({
          artifact: definition.noun,
          message: `Agent completed without calling ${definition.toolName}; no ${definition.noun} was accepted.`,
        }),
      );
    }
    const markdown = definition.formatMarkdown(submitted);
    const json = JSON.stringify(submitted, null, 2);
    yield* writers.writeMarkdown(markdown);
    yield* writers.writeJson(json);
    return { value: submitted, markdown };
  },
);
