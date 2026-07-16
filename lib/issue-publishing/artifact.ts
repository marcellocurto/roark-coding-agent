import type { StructuredArtifactDefinition } from "../structured-output/runner.ts";
import { issueDraftCollectionSchema, validateIssueDraftCollection, type IssueDraftCollection } from "./result.ts";

export class IssueDraftSubmissionError extends Error {
  override readonly name = "IssueDraftSubmissionError";
}

export function issueDraftArtifactDefinition(input: {
  expectedPlanItemIds: readonly string[];
  formatMarkdown: (drafts: IssueDraftCollection) => string;
}): StructuredArtifactDefinition<IssueDraftCollection> {
  return {
    toolName: "submit_issue_drafts",
    label: "issue drafts",
    noun: "issue drafts",
    parameters: issueDraftCollectionSchema,
    validate: (value) => validateIssueDraftCollection(value, input.expectedPlanItemIds),
    formatMarkdown: input.formatMarkdown,
    createError: (message) => new IssueDraftSubmissionError(message),
  };
}
