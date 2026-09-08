import type { WorkflowThinkingStage } from "./thinking.ts";

export const models = {
  gpt6Astra: "openai-codex/gpt-6-astra",
} as const;

export const defaultRoarkModel = models.gpt6Astra;

export const workflowModelRoutes: Record<WorkflowThinkingStage, string> = {
  triage: models.gpt6Astra,
  plan: models.gpt6Astra,
  implement: models.gpt6Astra,
  codeRefinement: models.gpt6Astra,
  reviewA: models.gpt6Astra,
  reviewB: models.gpt6Astra,
  fix: models.gpt6Astra,
  issuePublishing: models.gpt6Astra,
  revisionPlan: models.gpt6Astra,
  revisionImplementation: models.gpt6Astra,
  revisionReview: models.gpt6Astra,
  revisionFix: models.gpt6Astra,
};

export function effectiveModelForStage(
  explicitModel: string | undefined,
  stage: WorkflowThinkingStage,
): string {
  return explicitModel ?? workflowModelRoutes[stage];
}
