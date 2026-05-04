import type { ThinkingLevel } from "../cli/args.ts";
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
  thinkingLevel: ThinkingLevel;
  prerequisites: ArtifactRef[];
  prompt: (context: WorkflowContext) => string;
};

export const triageTask: AgentTask = {
  artifact: "triage",
  label: "Triage",
  writable: false,
  thinkingLevel: "medium",
  prerequisites: ["issue"],
  prompt: triagePrompt,
};

export const planTask: AgentTask = {
  artifact: "implementationPlan",
  label: "Implementation plan",
  writable: false,
  thinkingLevel: "xhigh",
  prerequisites: ["issue", "triage"],
  prompt: planPrompt,
};

export const implementationTask: AgentTask = {
  artifact: "implementationLog",
  label: "Implementation",
  writable: true,
  thinkingLevel: "high",
  prerequisites: ["issue", "triage", "implementationPlan"],
  prompt: implementationPrompt,
};

export const reviewATask: AgentTask = {
  artifact: "reviewA",
  label: "Review A",
  writable: false,
  thinkingLevel: "xhigh",
  prerequisites: ["issue", "triage", "implementationPlan", "implementationLog"],
  prompt: reviewAPrompt,
};

export const reviewBTask: AgentTask = {
  artifact: "reviewB",
  label: "Review B",
  writable: false,
  thinkingLevel: "xhigh",
  prerequisites: ["issue", "triage", "implementationPlan", "implementationLog"],
  prompt: reviewBPrompt,
};

export function fixTask(pass: number): AgentTask {
  return {
    artifact: fixLogRef(pass),
    label: `Fix pass ${pass}`,
    writable: true,
    thinkingLevel: "high",
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
    thinkingLevel: "high",
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
      thinkingLevel: context.thinkingLevel ?? task.thinkingLevel,
      systemPrompt: sharedSystemPrompt,
      prompt: task.prompt(context),
      writable: task.writable,
    }),
  );
}
