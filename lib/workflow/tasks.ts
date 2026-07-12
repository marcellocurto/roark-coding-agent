import type { WorkflowThinkingStage } from "./thinking.ts";
import { effectiveModelForStage } from "./model-routing.ts";
import { phaseNameForArtifact } from "../observability/observer.ts";
import type { AgentRunRequest, AgentRunner } from "./agent-runner.ts";
import {
  artifactExists,
  artifactRelativePath,
  type ArtifactRef,
  baselineResetLogRef,
  finalReviewRef,
  fixLogRef,
  implementationRestartLogRef,
  readArtifact,
  refinementLogRef,
  reviewARef,
  reviewBRef,
  requireArtifacts,
  type WorkflowContext,
  writeArtifact,
} from "./artifacts.ts";
import { ArtifactValidationError, validateAgentArtifact } from "./artifact-validation.ts";
import {
  codeRefinementPrompt,
  finalReviewPrompt,
  fixPrompt,
  implementationPrompt,
  planDraftPrompt,
  planPrompt,
  reviewAPrompt,
  reviewBPrompt,
  sharedSystemPrompt,
  triagePrompt,
} from "../prompts/workflow-prompts.ts";
import { isTransientAgentConnectionError } from "./transient-agent-errors.ts";

export interface AgentTask {
  artifact: ArtifactRef;
  label: string;
  fileEditingToolsEnabled: boolean;
  thinkingStage: WorkflowThinkingStage;
  prerequisites: ArtifactRef[];
  prompt: (context: WorkflowContext) => string;
}

export type AgentTaskFailurePhase = "agent-error" | "output-contract";

export interface AgentTaskRetryOptions {
  delaysMs?: readonly number[] | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
}

export type CodeRefinementSource = "initial" | "fix" | "restart";

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
  fileEditingToolsEnabled: false,
  thinkingStage: "triage",
  prerequisites: ["issue"],
  prompt: triagePrompt,
};

export const planDraftTask: AgentTask = {
  artifact: "implementationPlanDraft",
  label: "Implementation plan draft",
  fileEditingToolsEnabled: false,
  thinkingStage: "plan",
  prerequisites: ["issue", "triage"],
  prompt: planDraftPrompt,
};

export const planTask: AgentTask = {
  artifact: "implementationPlan",
  label: "Implementation plan refinement",
  fileEditingToolsEnabled: false,
  thinkingStage: "plan",
  prerequisites: ["issue", "triage", "implementationPlanDraft"],
  prompt: planPrompt,
};

export const implementationTask: AgentTask = implementationTaskForPass(0);

export function implementationTaskForPass(restartPass = 0): AgentTask {
  return {
    artifact: "implementationLog",
    label: restartPass > 0 ? `Implementation restart pass ${restartPass}` : "Implementation",
    fileEditingToolsEnabled: true,
    thinkingStage: "implement",
    prerequisites: restartPass > 0
      ? ["issue", "triage", "implementationPlan", reviewARef(restartPass - 1), reviewBRef(restartPass - 1)]
      : ["issue", "triage", "implementationPlan"],
    prompt: (context) => implementationPrompt(context, restartPass),
  };
}

export function codeRefinementTask(pass: number, source: CodeRefinementSource = pass === 0 ? "initial" : "fix"): AgentTask {
  return {
    artifact: refinementLogRef(pass),
    label: `Code refinement pass ${pass}`,
    fileEditingToolsEnabled: true,
    thinkingStage: "fix",
    prerequisites: codeRefinementPrerequisites(pass, source),
    prompt: (context) => codeRefinementPrompt(context, pass, source),
  };
}

function codeRefinementPrerequisites(pass: number, source: CodeRefinementSource): ArtifactRef[] {
  if (pass === 0 || source === "initial") return ["issue", "triage", "implementationPlan", "implementationLog"];
  const shared: ArtifactRef[] = ["issue", "triage", "implementationPlan", "implementationLog", reviewARef(pass - 1), reviewBRef(pass - 1)];
  if (source === "restart") return [...shared, baselineResetLogRef(pass), implementationRestartLogRef(pass)];
  return [...shared, fixLogRef(pass)];
}

export const reviewATask: AgentTask = reviewATaskForPass(0);
export const reviewBTask: AgentTask = reviewBTaskForPass(0);

export function reviewATaskForPass(pass = 0): AgentTask {
  return {
    artifact: reviewARef(pass),
    label: `Review A pass ${pass}`,
    fileEditingToolsEnabled: false,
    thinkingStage: "reviewA",
    prerequisites: ["issue", "triage", "implementationPlan", "implementationLog", refinementLogRef(pass)],
    prompt: (context) => reviewAPrompt(context, pass),
  };
}

export function reviewBTaskForPass(pass = 0): AgentTask {
  return {
    artifact: reviewBRef(pass),
    label: `Review B pass ${pass}`,
    fileEditingToolsEnabled: false,
    thinkingStage: "reviewB",
    prerequisites: ["issue", "triage", "implementationPlan", "implementationLog", refinementLogRef(pass)],
    prompt: (context) => reviewBPrompt(context, pass),
  };
}

export function fixTask(pass: number): AgentTask {
  return {
    artifact: fixLogRef(pass),
    label: `Fix pass ${pass}`,
    fileEditingToolsEnabled: true,
    thinkingStage: "fix",
    prerequisites: ["issue", "implementationPlan", "implementationLog", reviewARef(pass - 1), reviewBRef(pass - 1)],
    prompt: (context) => fixPrompt(context, pass),
  };
}

export function finalReviewTask(pass: number): AgentTask {
  return {
    artifact: finalReviewRef(pass),
    label: `Final review pass ${pass}`,
    fileEditingToolsEnabled: false,
    thinkingStage: "finalReview",
    prerequisites: ["issue", "implementationPlan", reviewARef(Math.max(0, pass - 1)), reviewBRef(Math.max(0, pass - 1)), fixLogRef(pass)],
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
  const thinkingLevel = thinkingLevelForTask(context, task);
  const model = effectiveModelForStage(context.model, task.thinkingStage);

  if (!context.force && artifactExists(context, task.artifact)) {
    const existing = await readArtifact(context, task.artifact);
    const validation = validateAgentArtifact(task.artifact, existing);
    if (validation.ok) {
      console.log(`✓ ${task.label}: using existing ${artifactRelativePath(context, task.artifact)}`);
      await context.observer?.phaseCompleted({ phase, label: task.label, artifact: task.artifact, model, thinkingLevel, reused: true });
      return existing;
    }
    console.log(
      `! ${task.label}: existing ${artifactRelativePath(context, task.artifact)} is invalid (${validation.reason}); regenerating.`,
    );
  }

  console.log(`\n=== ${task.label} ===`);
  await context.observer?.phaseStarted({ phase, label: task.label, artifact: task.artifact, model, thinkingLevel });
  try {
    const content = await runTaskWithOutputContract(context, runner, task, retryOptions);
    await writeArtifact(context, task.artifact, content);
    await context.observer?.phaseCompleted({ phase, label: task.label, artifact: task.artifact, model, thinkingLevel });
    console.log(`\n✓ ${task.label}: wrote ${artifactRelativePath(context, task.artifact)}`);
    return content;
  } catch (error) {
    const failurePhase = error instanceof ArtifactValidationError ? "output-contract" : "agent-error";
    const diagnostic = formatAgentTaskErrorArtifact({ context, task, phase: failurePhase, error });
    await writeArtifact(context, task.artifact, diagnostic);
    await context.observer?.phaseFailed({ phase, label: task.label, artifact: task.artifact, model, thinkingLevel, error });
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
    cwd: context.agentCwd,
    model: effectiveModelForStage(context.model, task.thinkingStage),
    thinkingLevel: thinkingLevelForTask(context, task),
    systemPrompt: sharedSystemPrompt,
    fileEditingToolsEnabled: task.fileEditingToolsEnabled,
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
  if (!task.fileEditingToolsEnabled) return request;
  return {
    ...request,
    prompt: `${request.prompt}\n\n<transient_connection_retry>\nA previous invocation of this same phase failed because the provider/harness connection ended.\nIt may have already modified files in the working tree.\nInspect the current diff before editing, preserve useful completed work, avoid duplicate changes, finish the phase, run validation, and return the complete required Markdown artifact.\n</transient_connection_retry>`,
  };
}

function thinkingLevelForTask(context: WorkflowContext, task: AgentTask) {
  return context.thinkingConfig[task.thinkingStage];
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
    `\`${effectiveModelForStage(context.model, task.thinkingStage)}\``,
    "",
    "## Thinking Level",
    `\`${thinkingLevelForTask(context, task)}\``,
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
