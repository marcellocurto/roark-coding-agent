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

export type AgentTaskFailurePhase = "agent-error" | "output-contract";

export class AgentTaskRunError extends Error {
  readonly artifact: ArtifactRef;
  readonly label: string;
  readonly phase: AgentTaskFailurePhase;
  readonly originalMessage: string;

  constructor(input: {
    artifact: ArtifactRef;
    label: string;
    phase: AgentTaskFailurePhase;
    originalError: unknown;
  }) {
    const originalMessage = formatError(input.originalError);
    super(`${input.label} failed: ${originalMessage}`);
    this.name = "AgentTaskRunError";
    this.artifact = input.artifact;
    this.label = input.label;
    this.phase = input.phase;
    this.originalMessage = originalMessage;
  }
}

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
  thinkingLevel: "high",
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
  thinkingLevel: "high",
  prerequisites: ["issue", "triage", "implementationPlan", "implementationLog"],
  prompt: reviewAPrompt,
};

export const reviewBTask: AgentTask = {
  artifact: "reviewB",
  label: "Review B",
  writable: false,
  thinkingLevel: "high",
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
  try {
    const content = await runTaskWithOutputContract(context, runner, task);
    await writeArtifact(context, task.artifact, content);
    console.log(`\n✓ ${task.label}: wrote ${artifactRelativePath(context, task.artifact)}`);
    return content;
  } catch (error) {
    const phase = error instanceof ArtifactValidationError ? "output-contract" : "agent-error";
    const diagnostic = formatAgentTaskErrorArtifact({ context, task, phase, error });
    await writeArtifact(context, task.artifact, diagnostic);
    console.log(`\n✗ ${task.label}: wrote error details to ${artifactRelativePath(context, task.artifact)}`);
    throw new AgentTaskRunError({ artifact: task.artifact, label: task.label, phase, originalError: error });
  }
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
  return `${originalPrompt}\n\n<output_contract_repair>\nThe previous ${task.label} response did not satisfy the required Markdown output contract.\nReason: ${escapeForPrompt(reason)}\nReturn the complete ${task.label} Markdown artifact again, with the required heading/verdict/status/ready token needed by the workflow. Do not include commentary outside the artifact.\n</output_contract_repair>\n\n<invalid_previous_output>\n${escapeForPrompt(invalidOutput)}\n</invalid_previous_output>`;
}

function formatAgentTaskErrorArtifact(input: {
  context: WorkflowContext;
  task: AgentTask;
  phase: AgentTaskFailurePhase;
  error: unknown;
}): string {
  const { context, task, phase, error } = input;
  const lines = [
    `# ${task.label} Error`,
    "",
    "## Status",
    "errored",
    "",
    "## Phase",
    phase,
    "",
    "## Artifact",
    `\`${artifactRelativePath(context, task.artifact)}\``,
    "",
    "## Model",
    `\`${context.model ?? "roark default"}\``,
    "",
    "## Thinking Level",
    `\`${context.thinkingLevel ?? task.thinkingLevel}\``,
    "",
    "## Error",
    formatFencedBlock(formatError(error), "text"),
    "",
    "## Recovery",
    "Fix the provider/output-contract error, then rerun the same phase or `continue` the autorun attempt. This diagnostic artifact is intentionally invalid as a workflow phase output so continuation will regenerate it.",
  ];
  return `${lines.join("\n")}\n`;
}

function formatFencedBlock(value: string, language: string): string {
  const fence = value.includes("````") ? "`````" : "````";
  return `${fence}${language}\n${value}\n${fence}`;
}

function escapeForPrompt(value: string): string {
  return value.replaceAll("</", "<\\/");
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
