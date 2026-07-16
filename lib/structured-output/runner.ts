import { defineTool } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import type { AgentRunRequest, AgentRunner } from "../workflow/agent-runner.ts";

export interface StructuredArtifactDefinition<T> {
  toolName: string;
  label: string;
  noun: string;
  parameters: TSchema;
  validate: (value: unknown) => T;
  formatMarkdown: (value: T) => string;
  createError: (message: string) => Error;
}

export interface StructuredArtifactWriters {
  writeJson: (content: string) => Promise<void>;
  writeMarkdown: (content: string) => Promise<void>;
}

export interface StructuredArtifactResult<T> {
  value: T;
  markdown: string;
}

export async function runStructuredArtifact<T>(
  request: AgentRunRequest,
  runner: AgentRunner,
  definition: StructuredArtifactDefinition<T>,
  writers: StructuredArtifactWriters,
): Promise<StructuredArtifactResult<T>> {
  let submitted: T | undefined;
  const submit = defineTool({
    name: definition.toolName,
    label: `Submit ${definition.label}`,
    description: `Submit the final structured ${definition.noun}. This is the only valid way to complete this phase.`,
    promptSnippet: `Submit the final schema-validated ${definition.noun}`,
    promptGuidelines: [
      `Use ${definition.toolName} as the final action for this phase.`,
      `Do not return the ${definition.noun} as Markdown or prose after calling ${definition.toolName}.`,
    ],
    parameters: definition.parameters,
    execute(_toolCallId, params) {
      if (submitted !== undefined) {
        throw definition.createError(`The ${definition.noun} has already been submitted.`);
      }
      try {
        submitted = definition.validate(params);
      } catch (error) {
        throw definition.createError(error instanceof Error ? error.message : String(error));
      }
      return Promise.resolve({
        content: [{ type: "text" as const, text: `Structured ${definition.noun} submitted.` }],
        details: submitted,
        terminate: true,
      });
    },
  });

  await runner({
    ...request,
    customTools: [...(request.customTools ?? []), submit],
  });
  if (submitted === undefined) {
    throw definition.createError(
      `Agent completed without calling ${definition.toolName}; no ${definition.noun} was accepted.`,
    );
  }
  const markdown = definition.formatMarkdown(submitted);
  const json = JSON.stringify(submitted, null, 2);
  await writers.writeMarkdown(markdown);
  await writers.writeJson(json);
  return { value: submitted, markdown };
}
