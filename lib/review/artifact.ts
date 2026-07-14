import type { StructuredArtifactDefinition } from "../structured-output/runner.ts";
import { formatReviewResultMarkdown, reviewResultSchema, validateReviewResult, type ReviewFindingSource, type ReviewResult } from "./result.ts";

export interface RunReviewAgentOptions {
  allowRestart: boolean;
}

export class ReviewOutputContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewOutputContractError";
  }
}

export function reviewArtifactDefinition(
  options: RunReviewAgentOptions & { title: string; source: ReviewFindingSource },
): StructuredArtifactDefinition<ReviewResult> {
  return {
    toolName: "submit_review",
    label: "Review",
    noun: "review",
    parameters: reviewResultSchema,
    validate: (value) => validateReviewResult(value, options),
    formatMarkdown: (result) => formatReviewResultMarkdown(result, options),
    createError: (message) => new ReviewOutputContractError(message),
  };
}
