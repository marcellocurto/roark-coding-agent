import type { ThinkingLevel } from "../cli/args.ts";
import { phaseNameForArtifact } from "../observability/observer.ts";
import type { AgentRunRequest, AgentRunner } from "./agent-runner.ts";
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
import { isTransientAgentConnectionError } from "./transient-agent-errors.ts";

export type AgentTask = {
  artifact: ArtifactRef;
  label: string;
  writable: boolean;
  thinkingLevel: ThinkingLevel;
  prerequisites: ArtifactRef[];
  prompt: (context: WorkflowContext) => string;
};

export type AgentTaskFailurePhase = "agent-error" | "output-contract";

export type AgentTaskRetryOptions = {
  delaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
};

export const transientAgentRetryDelaysMs = [0, 60_000, 180_000] as const;

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

export async function runAgentTask(
  context: WorkflowContext,
  runner: AgentRunner,
  task: AgentTask,
  retryOptions: AgentTaskRetryOptions = {},
): Promise<string> {
  requireArtifacts(context, ...task.prerequisites);

  const phase = phaseNameForArtifact(task.artifact);
  const thinkingLevel = context.thinkingLevel ?? task.thinkingLevel;

  if (!context.force && artifactExists(context, task.artifact)) {
    const existing = await readArtifact(context, task.artifact);
    const validation = validateAgentArtifact(task.artifact, existing);
    if (validation.ok) {
      console.log(`✓ ${task.label}: using existing ${artifactRelativePath(context, task.artifact)}`);
      await context.observer?.phaseCompleted({ phase, label: task.label, artifact: task.artifact, model: context.model, thinkingLevel, reused: true });
      return existing;
    }
    console.log(
      `! ${task.label}: existing ${artifactRelativePath(context, task.artifact)} is invalid (${validation.reason}); regenerating.`,
    );
  }

  console.log(`\n=== ${task.label} ===`);
  await context.observer?.phaseStarted({ phase, label: task.label, artifact: task.artifact, model: context.model, thinkingLevel });
  try {
    const content = await runTaskWithOutputContract(context, runner, task, retryOptions);
    await writeArtifact(context, task.artifact, content);
    await context.observer?.phaseCompleted({ phase, label: task.label, artifact: task.artifact, model: context.model, thinkingLevel });
    console.log(`\n✓ ${task.label}: wrote ${artifactRelativePath(context, task.artifact)}`);
    return content;
  } catch (error) {
    const failurePhase = error instanceof ArtifactValidationError ? "output-contract" : "agent-error";
    const diagnostic = formatAgentTaskErrorArtifact({ context, task, phase: failurePhase, error });
    await writeArtifact(context, task.artifact, diagnostic);
    await context.observer?.phaseFailed({ phase, label: task.label, artifact: task.artifact, model: context.model, thinkingLevel, error });
    console.log(`\n✗ ${task.label}: wrote error details to ${artifactRelativePath(context, task.artifact)}`);
    throw new AgentTaskRunError({ artifact: task.artifact, label: task.label, phase: failurePhase, originalError: error });
  }
}

async function runTaskWithOutputContract(
  context: WorkflowContext,
  runner: AgentRunner,
  task: AgentTask,
  retryOptions: AgentTaskRetryOptions,
): Promise<string> {
  const request = {
    cwd: context.cwd,
    model: context.model,
    thinkingLevel: context.thinkingLevel ?? task.thinkingLevel,
    systemPrompt: sharedSystemPrompt,
    writable: task.writable,
    observer: context.observer,
    phase: phaseNameForArtifact(task.artifact),
  };
  const prompt = task.prompt(context);

  const first = await runAgentRequestWithTransientRetries(runner, { ...request, prompt }, task, retryOptions);
  const firstValidation = validateAgentArtifact(task.artifact, first);
  if (firstValidation.ok) return first;

  console.log(`! ${task.label}: output invalid (${firstValidation.reason}); retrying once.`);
  const second = await runAgentRequestWithTransientRetries(runner, {
    ...request,
    prompt: repairPrompt(prompt, task, firstValidation.reason, first),
  }, task, retryOptions);
  const secondValidation = validateAgentArtifact(task.artifact, second);
  if (secondValidation.ok) return second;

  throw new ArtifactValidationError(task.artifact, secondValidation.reason);
}

async function runAgentRequestWithTransientRetries(
  runner: AgentRunner,
  request: AgentRunRequest,
  task: AgentTask,
  options: AgentTaskRetryOptions,
): Promise<string> {
  const delaysMs = options.delaysMs ?? transientAgentRetryDelaysMs;
  const sleep = options.sleep ?? defaultSleep;

  for (let retryIndex = 0; ; retryIndex++) {
    try {
      const attemptRequest = retryIndex === 0 ? request : withTransientConnectionRetryPrompt(request, task);
      return await runner(attemptRequest);
    } catch (error) {
      if (!isTransientAgentConnectionError(error) || retryIndex >= delaysMs.length) throw error;

      const delayMs = delaysMs[retryIndex] ?? 0;
      const retryNumber = retryIndex + 1;
      const retryCount = delaysMs.length;
      console.log(
        `! ${task.label}: transient agent connection error: ${formatError(error)}; retry ${retryNumber}/${retryCount} ${formatRetryDelay(delayMs)}.`,
      );
      if (delayMs > 0) await sleep(delayMs);
    }
  }
}

function withTransientConnectionRetryPrompt(request: AgentRunRequest, task: AgentTask): AgentRunRequest {
  if (!task.writable) return request;
  return {
    ...request,
    prompt: `${request.prompt}\n\n<transient_connection_retry>\nA previous invocation of this same phase failed because the provider/harness connection ended.\nIt may have already modified files in the working tree.\nInspect the current diff before editing, preserve useful completed work, avoid duplicate changes, finish the phase, run validation, and return the complete required Markdown artifact.\n</transient_connection_retry>`,
  };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatRetryDelay(delayMs: number): string {
  if (delayMs <= 0) return "immediately";
  if (delayMs % 60_000 === 0) {
    const minutes = delayMs / 60_000;
    return `in ${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  if (delayMs % 1_000 === 0) {
    const seconds = delayMs / 1_000;
    return `in ${seconds} second${seconds === 1 ? "" : "s"}`;
  }
  return `in ${delayMs}ms`;
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
