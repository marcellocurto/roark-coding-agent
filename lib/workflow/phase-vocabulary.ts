export const standaloneWorkflowPhases = [
  "fetch",
  "triage",
  "plan-draft",
  "plan",
  "capture-baseline",
  "implement",
  "refine-code",
  "fix",
  "reset-baseline",
] as const;

export type StandaloneWorkflowPhase = (typeof standaloneWorkflowPhases)[number];

export const workflowRunPhases = [
  ...standaloneWorkflowPhases,
  "review-a",
  "review-b",
] as const;

export type WorkflowRunPhase = (typeof workflowRunPhases)[number];

export const singlePhaseCommands = [
  ...standaloneWorkflowPhases,
  "review",
  "readiness",
  "curate-issues",
  "create-issues",
] as const;

export type SinglePhaseCommand = (typeof singlePhaseCommands)[number];
