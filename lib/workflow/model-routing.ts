import type { WorkflowThinkingStage } from "./thinking.ts";

export const models = {
  gpt56Sol: "openai-codex/gpt-5.6-sol",
  gpt56Terra: "openai-codex/gpt-5.6-terra",
  gpt56Luna: "openai-codex/gpt-5.6-luna",
} as const;

export const defaultRoarkModel = models.gpt56Sol;

export const workflowModelRoutes: Record<WorkflowThinkingStage, string> = {
  triage: models.gpt56Sol,
  plan: models.gpt56Sol,
  implement: models.gpt56Sol,
  codeRefinement: models.gpt56Sol,
  reviewA: models.gpt56Sol,
  reviewB: models.gpt56Sol,
  fix: models.gpt56Sol,
  issuePublishing: models.gpt56Sol,
  revisionPlan: models.gpt56Sol,
  revisionImplementation: models.gpt56Sol,
  revisionReview: models.gpt56Sol,
  revisionFix: models.gpt56Sol,
};

export function effectiveModelForStage(explicitModel: string | undefined, stage: WorkflowThinkingStage): string {
  return explicitModel ?? workflowModelRoutes[stage];
}
