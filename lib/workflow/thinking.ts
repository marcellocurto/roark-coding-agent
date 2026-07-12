import type { ThinkingLevel } from "../cli/args.ts";

export const thinkingProfileNames = ["default", "fast", "deep"] as const;
export type ThinkingProfileName = (typeof thinkingProfileNames)[number];

export const workflowThinkingStages = [
  "triage",
  "plan",
  "implement",
  "codeRefinement",
  "reviewA",
  "reviewB",
  "fix",
  "finalReview",
  "issuePublishing",
  "revisionPlan",
  "revisionImplementation",
  "revisionReview",
  "revisionFix",
] as const;

export type WorkflowThinkingStage = (typeof workflowThinkingStages)[number];
export type WorkflowThinkingConfig = Record<WorkflowThinkingStage, ThinkingLevel>;

export const workflowThinkingProfiles: Record<ThinkingProfileName, WorkflowThinkingConfig> = {
  default: {
    triage: "high",
    plan: "high",
    implement: "high",
    codeRefinement: "high",
    reviewA: "xhigh",
    reviewB: "xhigh",
    fix: "high",
    finalReview: "high",
    issuePublishing: "high",
    revisionPlan: "high",
    revisionImplementation: "high",
    revisionReview: "xhigh",
    revisionFix: "medium",
  },
  fast: {
    triage: "low",
    plan: "low",
    implement: "low",
    codeRefinement: "low",
    reviewA: "medium",
    reviewB: "medium",
    fix: "low",
    finalReview: "medium",
    issuePublishing: "low",
    revisionPlan: "low",
    revisionImplementation: "low",
    revisionReview: "low",
    revisionFix: "low",
  },
  deep: {
    triage: "xhigh",
    plan: "xhigh",
    implement: "high",
    codeRefinement: "xhigh",
    reviewA: "xhigh",
    reviewB: "xhigh",
    fix: "high",
    finalReview: "xhigh",
    issuePublishing: "high",
    revisionPlan: "high",
    revisionImplementation: "high",
    revisionReview: "xhigh",
    revisionFix: "high",
  },
};

export function getWorkflowThinkingConfig(input: {
  profile?: ThinkingProfileName | undefined  ;
  explicitThinkingLevel?: ThinkingLevel | undefined  ;
} = {}): WorkflowThinkingConfig {
  if (input.explicitThinkingLevel) return uniformWorkflowThinkingConfig(input.explicitThinkingLevel);
  return { ...workflowThinkingProfiles[input.profile ?? "default"] };
}

function uniformWorkflowThinkingConfig(level: ThinkingLevel): WorkflowThinkingConfig {
  return Object.fromEntries(workflowThinkingStages.map((stage) => [stage, level])) as WorkflowThinkingConfig;
}
