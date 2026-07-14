import { defineTool } from "@earendil-works/pi-coding-agent";
import type { AgentRunRequest, AgentRunner } from "../workflow/agent-runner.ts";
import { reviewResultSchema, validateReviewResult, type ReviewResult } from "./result.ts";

export interface RunReviewAgentOptions {
  allowRestart: boolean;
}

export class ReviewOutputContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewOutputContractError";
  }
}

export async function runReviewAgent(
  request: AgentRunRequest,
  runner: AgentRunner,
  options: RunReviewAgentOptions,
): Promise<ReviewResult> {
  let submitted: ReviewResult | undefined;
  const submitReview = defineTool({
    name: "submit_review",
    label: "Submit Review",
    description: "Submit the final structured review. This is the only valid way to complete a review phase.",
    promptSnippet: "Submit the final schema-validated review result",
    promptGuidelines: [
      "Use submit_review as the final action for this review phase.",
      "Do not return the review as Markdown or prose after calling submit_review.",
    ],
    parameters: reviewResultSchema,
    execute(_toolCallId, params) {
      if (submitted !== undefined) throw new ReviewOutputContractError("The review has already been submitted.");
      try {
        submitted = validateReviewResult(params, options);
      } catch (error) {
        throw new ReviewOutputContractError(error instanceof Error ? error.message : String(error));
      }
      return Promise.resolve({
        content: [{ type: "text" as const, text: "Structured review submitted." }],
        details: submitted,
        terminate: true,
      });
    },
  });

  await runner({
    ...request,
    customTools: [...(request.customTools ?? []), submitReview],
  });

  if (submitted === undefined) {
    throw new ReviewOutputContractError("Review agent completed without calling submit_review; no review result was accepted.");
  }
  return submitted;
}
