import type { ThinkingLevel } from "../cli/args.ts";
import type { AgentRunner } from "./agent-runner.ts";
import {
  artifactExists,
  artifactRelativePath,
  type ArtifactRef,
  finalReviewRef,
  fixLogRef,
  readArtifact,
  requireArtifacts,
  type WorkflowContext,
  writeArtifact,
} from "./artifacts.ts";
import { ArtifactValidationError, validateAgentArtifact } from "./artifact-validation.ts";
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

  if (!context.force && artifactExists(context, task.artifact)) {
    const existing = await readArtifact(context, task.artifact);
    const validation = validateAgentArtifact(task.artifact, existing);
    if (validation.ok) {
      console.log(`✓ ${task.label}: using existing ${artifactRelativePath(context, task.artifact)}`);
      return existing;
    }
    console.log(
      `! ${task.label}: existing ${artifactRelativePath(context, task.artifact)} is invalid (${validation.reason}); regenerating.`,
    );
  }

  console.log(`\n=== ${task.label} ===`);
  const content = await runTaskWithOutputContract(context, runner, task);
  await writeArtifact(context, task.artifact, content);
  console.log(`\n✓ ${task.label}: wrote ${artifactRelativePath(context, task.artifact)}`);
  return content;
}

async function runTaskWithOutputContract(
  context: WorkflowContext,
  runner: AgentRunner,
  task: AgentTask,
): Promise<string> {
  const request = {
    cwd: context.cwd,
    model: context.model,
    thinkingLevel: context.thinkingLevel ?? task.thinkingLevel,
    systemPrompt: sharedSystemPrompt,
    writable: task.writable,
  };
  const prompt = task.prompt(context);

  const first = await runner({ ...request, prompt });
  const firstValidation = validateAgentArtifact(task.artifact, first);
  if (firstValidation.ok) return first;

  console.log(`! ${task.label}: output invalid (${firstValidation.reason}); retrying once.`);
  const second = await runner({
    ...request,
    prompt: repairPrompt(prompt, task, firstValidation.reason, first),
  });
  const secondValidation = validateAgentArtifact(task.artifact, second);
  if (secondValidation.ok) return second;

  throw new ArtifactValidationError(task.artifact, secondValidation.reason);
}

function repairPrompt(originalPrompt: string, task: AgentTask, reason: string, invalidOutput: string): string {
  return `${originalPrompt}\n\n<output_contract_repair>\nThe previous ${task.label} response did not satisfy the required Markdown output contract.\nReason: ${escapeForPrompt(reason)}\nReturn the complete ${task.label} Markdown artifact again, with the exact required sections and a valid verdict/status token. Do not include commentary outside the artifact.\n</output_contract_repair>\n\n<invalid_previous_output>\n${escapeForPrompt(invalidOutput)}\n</invalid_previous_output>`;
}

function escapeForPrompt(value: string): string {
  return value.replaceAll("</", "<\\/");
}
