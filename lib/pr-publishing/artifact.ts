import { sanitizePublicMarkdown } from "../autorun/public-output.ts";
import type { StructuredArtifactDefinition } from "../structured-output/runner.ts";
import { formatPrDraftMarkdown, prDraftSchema, validatePrDraft, type PrDraft, type PrDraftRenderingContext } from "./result.ts";

export class PrDraftSubmissionError extends Error {
  override readonly name = "PrDraftSubmissionError";
}

export function prDraftArtifactDefinition(input: {
  renderingContext: PrDraftRenderingContext;
  localRoots: readonly string[];
}): StructuredArtifactDefinition<PrDraft> {
  return {
    toolName: "submit_pr_draft",
    label: "PR draft",
    noun: "PR draft",
    parameters: prDraftSchema,
    validate: validatePrDraft,
    formatMarkdown: (draft) => sanitizePublicMarkdown(formatPrDraftMarkdown(draft, input.renderingContext), {
      localRoots: input.localRoots,
    }),
    createError: (message) => new PrDraftSubmissionError(message),
  };
}
