import type { AgentRunner } from "./agent-runner.ts";
import {
  type ArtifactRef,
  finalReviewRef,
  fixLogRef,
  produceArtifact,
  requireArtifacts,
  type WorkflowContext,
} from "./artifacts.ts";
import {
  finalReviewPrompt,
  fixPrompt,
  implementationPrompt,
  planPrompt,
  reviewAPrompt,
  reviewBPrompt,
  sharedSystemPrompt,
  triagePrompt,
} from "../prompts/workflow-prompts.ts";

export type AgentTask = {
  artifact: ArtifactRef;
  label: string;
  writable: boolean;
  prerequisites: ArtifactRef[];
  prompt: (context: WorkflowContext) => string;
};

export const triageTask: AgentTask = {
  artifact: "triage",
  label: "Triage",
  writable: false,
  prerequisites: ["issue"],
  prompt: triagePrompt,
};

export const planTask: AgentTask = {
  artifact: "implementationPlan",
  label: "Implementation plan",
  writable: false,
  prerequisites: ["issue", "triage"],
  prompt: planPrompt,
};

export const implementationTask: AgentTask = {
  artifact: "implementationLog",
  label: "Implementation",
  writable: true,
  prerequisites: ["issue", "triage", "implementationPlan"],
  prompt: implementationPrompt,
};

export const reviewATask: AgentTask = {
  artifact: "reviewA",
  label: "Review A",
  writable: false,
  prerequisites: ["issue", "triage", "implementationPlan", "implementationLog"],
  prompt: reviewAPrompt,
};

export const reviewBTask: AgentTask = {
  artifact: "reviewB",
  label: "Review B",
  writable: false,
  prerequisites: ["issue", "triage", "implementationPlan", "implementationLog"],
  prompt: reviewBPrompt,
};

export function fixTask(pass: number): AgentTask {
  return {
    artifact: fixLogRef(pass),
    label: `Fix pass ${pass}`,
    writable: true,
    prerequisites: pass > 1
      ? ["issue", "implementationPlan", "implementationLog", "reviewA", "reviewB", finalReviewRef(pass - 1)]
      : ["issue", "implementationPlan", "implementationLog", "reviewA", "reviewB"],
    prompt: (context) => fixPrompt(context, pass),
  };
}

export function finalReviewTask(pass: number): AgentTask {
  return {
    artifact: finalReviewRef(pass),
    label: `Final review pass ${pass}`,
    writable: false,
    prerequisites: ["issue", "implementationPlan", "reviewA", "reviewB", fixLogRef(pass)],
    prompt: (context) => finalReviewPrompt(context, pass),
  };
}

export async function runAgentTask(context: WorkflowContext, runner: AgentRunner, task: AgentTask): Promise<string> {
  requireArtifacts(context, ...task.prerequisites);
  return produceArtifact(context, task.artifact, task.label, () =>
    runner({
      cwd: context.cwd,
      model: context.model,
      systemPrompt: sharedSystemPrompt,
      prompt: task.prompt(context),
      writable: task.writable,
    }),
  );
}
