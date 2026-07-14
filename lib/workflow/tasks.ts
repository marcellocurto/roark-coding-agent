import type { WorkflowThinkingStage } from "./thinking.ts";
import { effectiveModelForStage } from "./model-routing.ts";
import { phaseNameForArtifact } from "../observability/observer.ts";
import type { AgentRunRequest, AgentRunner } from "./agent-runner.ts";
import {
  artifactExists,
  artifactRelativePath,
  type ArtifactRef,
  baselineResetLogRef,
  fixLogRef,
  fixLogMarkdownRef,
  implementationRestartLogRef,
  readArtifact,
  refinementLogRef,
  refinementLogMarkdownRef,
  reviewARef,
  reviewAMarkdownRef,
  reviewBRef,
  reviewBMarkdownRef,
  requireArtifacts,
  type WorkflowContext,
  writeArtifact,
} from "./artifacts.ts";
import {
  codeRefinementPrompt,
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
import { normalizeReviewPair, parseReviewResultJson, type ReviewFindingSource, type ReviewResult } from "../review/result.ts";
import { ReviewOutputContractError, reviewArtifactDefinition } from "../review/artifact.ts";
import {
  parseTriageResultJson,
  triageArtifactDefinition,
  TriageOutputContractError,
  type TriageResult,
} from "../triage/result.ts";
import {
  implementationPlanArtifactDefinition,
  ImplementationPlanOutputContractError,
  parseImplementationPlanResultJson,
  type ImplementationPlanKind,
  type ImplementationPlanResult,
} from "../implementation-plan/result.ts";
import {
  ChangeReportOutputContractError,
  changeReportArtifactDefinition,
  parseChangeReportJson,
  requireAddressedFindingIds,
  type ChangeReport,
} from "../change-report/result.ts";
import { runStructuredArtifact, type StructuredArtifactDefinition } from "../structured-output/runner.ts";

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

const triageTask: AgentTask = {
  artifact: "triage",
  label: "Triage",
  fileEditingToolsEnabled: false,
  thinkingStage: "triage",
  prerequisites: ["issue"],
  prompt: triagePrompt,
};

const planDraftTask: AgentTask = {
  artifact: "implementationPlanDraft",
  label: "Implementation plan draft",
  fileEditingToolsEnabled: false,
  thinkingStage: "plan",
  prerequisites: ["issue", "triage"],
  prompt: planDraftPrompt,
};

const planTask: AgentTask = {
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
    thinkingStage: "codeRefinement",
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
    prerequisites: ["issue", "triage", "implementationPlan", "preImplementationBaseline", "implementationLog", refinementLogRef(pass)],
    prompt: (context) => reviewAPrompt(context, pass),
  };
}

export function reviewBTaskForPass(pass = 0): AgentTask {
  return {
    artifact: reviewBRef(pass),
    label: `Review B pass ${pass}`,
    fileEditingToolsEnabled: false,
    thinkingStage: "reviewB",
    prerequisites: ["issue", "triage", "implementationPlan", "preImplementationBaseline", "implementationLog", refinementLogRef(pass)],
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

export async function runReviewTask(
  context: WorkflowContext,
  runner: AgentRunner,
  task: AgentTask,
  retryOptions: AgentTaskRetryOptions = {},
): Promise<ReviewResult> {
  const presentation = reviewPresentation(task.artifact, task.label);
  return runStructuredArtifactTask(context, runner, task, retryOptions, {
    parse: (content) => parseReviewResultJson(content, { allowRestart: true }),
    definition: reviewArtifactDefinition({
      allowRestart: true,
      title: task.label,
      source: presentation.source,
    }),
    markdownArtifact: presentation.markdownArtifact,
    isOutputContractError: (error) => error instanceof ReviewOutputContractError,
  });
}

export function runTriageTask(
  context: WorkflowContext,
  runner: AgentRunner,
  retryOptions: AgentTaskRetryOptions = {},
): Promise<TriageResult> {
  return runStructuredArtifactTask(context, runner, triageTask, retryOptions, {
    parse: parseTriageResultJson,
    definition: triageArtifactDefinition,
    markdownArtifact: "triageMarkdown",
    isOutputContractError: (error) => error instanceof TriageOutputContractError,
  });
}

export function runPlanDraftTask(
  context: WorkflowContext,
  runner: AgentRunner,
  retryOptions: AgentTaskRetryOptions = {},
): Promise<ImplementationPlanResult> {
  return runImplementationPlanTask(context, runner, planDraftTask, "draft", retryOptions);
}

export function runPlanTask(
  context: WorkflowContext,
  runner: AgentRunner,
  retryOptions: AgentTaskRetryOptions = {},
): Promise<ImplementationPlanResult> {
  return runImplementationPlanTask(context, runner, planTask, "final", retryOptions);
}

export async function runChangeReportTask(
  context: WorkflowContext,
  runner: AgentRunner,
  task: AgentTask,
  retryOptions: AgentTaskRetryOptions = {},
): Promise<ChangeReport> {
  const presentation = changeReportPresentation(task.artifact);
  const expectedFindingIds = await requiredFixFindingIds(context, task.artifact);
  const validateForTask = (report: ChangeReport) => {
    if (expectedFindingIds !== undefined) return requireAddressedFindingIds(report, expectedFindingIds);
    if (report.addressedFindingIds.length > 0) {
      throw new ChangeReportOutputContractError("Only fix reports may contain addressedFindingIds.");
    }
    return report;
  };

  return runStructuredArtifactTask(context, runner, task, retryOptions, {
    parse: (content) => validateForTask(parseChangeReportJson(content)),
    definition: changeReportArtifactDefinition({ title: presentation.title, validate: validateForTask }),
    markdownArtifact: presentation.markdownArtifact,
    isOutputContractError: (error) => error instanceof ChangeReportOutputContractError,
    retryCompletionInstruction: "finish the phase, run validation, and call submit_change_report with the complete structured report",
  });
}

function runImplementationPlanTask(
  context: WorkflowContext,
  runner: AgentRunner,
  task: AgentTask,
  kind: ImplementationPlanKind,
  retryOptions: AgentTaskRetryOptions,
): Promise<ImplementationPlanResult> {
  return runStructuredArtifactTask(context, runner, task, retryOptions, {
    parse: parseImplementationPlanResultJson,
    definition: implementationPlanArtifactDefinition(kind),
    markdownArtifact: kind === "draft" ? "implementationPlanDraftMarkdown" : "implementationPlanMarkdown",
    isOutputContractError: (error) => error instanceof ImplementationPlanOutputContractError,
  });
}

async function runStructuredArtifactTask<T>(
  context: WorkflowContext,
  runner: AgentRunner,
  task: AgentTask,
  retryOptions: AgentTaskRetryOptions,
  contract: {
    parse: (content: string) => T;
    definition: StructuredArtifactDefinition<T>;
    markdownArtifact: ArtifactRef;
    isOutputContractError: (error: unknown) => boolean;
    retryCompletionInstruction?: string | undefined;
  },
): Promise<T> {
  const prepared = prepareTaskRun(context, task);
  const existing = await reuseTaskArtifact(context, task, prepared, contract.parse);
  if (existing.reused) {
    await writeArtifact(context, contract.markdownArtifact, contract.definition.formatMarkdown(existing.value));
    return existing.value;
  }

  return executeTaskLifecycle(context, task, prepared, {
    run: async () => {
      const artifact = await runStructuredArtifact(
        prepared.createRequest(),
        (agentRequest) => runAgentRequestWithTransientRetries(
          runner,
          agentRequest,
          task,
          retryOptions,
          contract.retryCompletionInstruction,
        ),
        contract.definition,
        {
          writeJson: (content) => writeArtifact(context, task.artifact, content),
          writeMarkdown: (content) => writeArtifact(context, contract.markdownArtifact, content),
        },
      );
      return artifact.value;
    },
    failurePhase: (error) => contract.isOutputContractError(error) ? "output-contract" : "agent-error",
  });
}

function reviewPresentation(
  artifact: ArtifactRef,
  title: string,
): { markdownArtifact: ArtifactRef; source: ReviewFindingSource } {
  if (typeof artifact !== "string" && artifact.name === "reviewA") {
    return { markdownArtifact: reviewAMarkdownRef(artifact.pass), source: "review-a" };
  }
  if (typeof artifact !== "string" && artifact.name === "reviewB") {
    return { markdownArtifact: reviewBMarkdownRef(artifact.pass), source: "review-b" };
  }
  throw new Error(`${title} does not target a review artifact.`);
}

function changeReportPresentation(artifact: ArtifactRef): { markdownArtifact: ArtifactRef; title: string } {
  if (artifact === "implementationLog") {
    return { markdownArtifact: "implementationLogMarkdown", title: "Implementation Log" };
  }
  if (typeof artifact !== "string" && artifact.name === "refinementLog") {
    return { markdownArtifact: refinementLogMarkdownRef(artifact.pass), title: `Refinement Log Pass ${artifact.pass}` };
  }
  if (typeof artifact !== "string" && artifact.name === "fixLog") {
    return { markdownArtifact: fixLogMarkdownRef(artifact.pass), title: `Fix Log Pass ${artifact.pass}` };
  }
  throw new Error(`Artifact ${typeof artifact === "string" ? artifact : `${artifact.name}-${artifact.pass}`} is not a change report.`);
}

async function requiredFixFindingIds(context: WorkflowContext, artifact: ArtifactRef): Promise<string[] | undefined> {
  if (typeof artifact === "string" || artifact.name !== "fixLog") return undefined;
  const previousCycle = Math.max(0, artifact.pass - 1);
  const [reviewA, reviewB] = await Promise.all([
    readArtifact(context, reviewARef(previousCycle)),
    readArtifact(context, reviewBRef(previousCycle)),
  ]);
  return normalizeReviewPair({
    reviewA: parseReviewResultJson(reviewA, { allowRestart: true }),
    reviewB: parseReviewResultJson(reviewB, { allowRestart: true }),
  })
    .filter((finding) => finding.classification === "must-fix-current")
    .map((finding) => finding.workflowId);
}

function prepareTaskRun(context: WorkflowContext, task: AgentTask) {
  requireArtifacts(context, ...task.prerequisites);
  const phase = phaseNameForArtifact(task.artifact);
  const thinkingLevel = thinkingLevelForTask(context, task);
  const model = effectiveModelForStage(context.model, task.thinkingStage);
  const createRequest = (): AgentRunRequest => ({
    cwd: context.agentCwd,
    model,
    thinkingLevel,
    systemPrompt: sharedSystemPrompt,
    prompt: task.prompt(context),
    fileEditingToolsEnabled: task.fileEditingToolsEnabled,
    observer: context.observer,
    phase,
  });
  return { phase, thinkingLevel, model, createRequest };
}

type PreparedTaskRun = ReturnType<typeof prepareTaskRun>;
type ReusedTaskArtifact<T> = { reused: true; value: T } | { reused: false };

async function reuseTaskArtifact<T>(
  context: WorkflowContext,
  task: AgentTask,
  prepared: PreparedTaskRun,
  parse: (content: string) => T,
): Promise<ReusedTaskArtifact<T>> {
  if (context.force || !artifactExists(context, task.artifact)) return { reused: false };
  const content = await readArtifact(context, task.artifact);
  try {
    const value = parse(content);
    console.log(`✓ ${task.label}: using existing ${artifactRelativePath(context, task.artifact)}`);
    await context.observer?.phaseCompleted({
      phase: prepared.phase,
      label: task.label,
      artifact: task.artifact,
      model: prepared.model,
      thinkingLevel: prepared.thinkingLevel,
      reused: true,
    });
    return { reused: true, value };
  } catch (error) {
    console.log(`! ${task.label}: existing ${artifactRelativePath(context, task.artifact)} is invalid (${formatError(error)}); regenerating.`);
    return { reused: false };
  }
}

async function executeTaskLifecycle<T>(
  context: WorkflowContext,
  task: AgentTask,
  prepared: PreparedTaskRun,
  options: {
    run: () => Promise<T>;
    failurePhase: (error: unknown) => AgentTaskFailurePhase;
    persistFailure?: ((phase: AgentTaskFailurePhase, error: unknown) => Promise<void>) | undefined;
  },
): Promise<T> {
  console.log(`\n=== ${task.label} ===`);
  await context.observer?.phaseStarted({
    phase: prepared.phase,
    label: task.label,
    artifact: task.artifact,
    model: prepared.model,
    thinkingLevel: prepared.thinkingLevel,
  });
  try {
    const result = await options.run();
    await context.observer?.phaseCompleted({
      phase: prepared.phase,
      label: task.label,
      artifact: task.artifact,
      model: prepared.model,
      thinkingLevel: prepared.thinkingLevel,
    });
    console.log(`\n✓ ${task.label}: wrote ${artifactRelativePath(context, task.artifact)}`);
    return result;
  } catch (error) {
    const failurePhase = options.failurePhase(error);
    await options.persistFailure?.(failurePhase, error);
    await context.observer?.phaseFailed({
      phase: prepared.phase,
      label: task.label,
      artifact: task.artifact,
      model: prepared.model,
      thinkingLevel: prepared.thinkingLevel,
      error,
    });
    console.log(options.persistFailure
      ? `\n✗ ${task.label}: wrote error details to ${artifactRelativePath(context, task.artifact)}`
      : `\n✗ ${task.label}: ${formatError(error)}`);
    throw new AgentTaskRunError({ artifact: task.artifact, label: task.label, phase: failurePhase, originalError: error });
  }
}

async function runAgentRequestWithTransientRetries(
  runner: AgentRunner,
  request: AgentRunRequest,
  task: AgentTask,
  options: AgentTaskRetryOptions,
  retryCompletionInstruction?: string,
): Promise<string> {
  const delaysMs = options.delaysMs ?? transientAgentRetryDelaysMs;
  const sleep = options.sleep ?? defaultSleep;

  for (let retryIndex = 0; ; retryIndex++) {
    try {
      const attemptRequest = retryIndex === 0
        ? request
        : withTransientConnectionRetryPrompt(request, task, retryCompletionInstruction);
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

function withTransientConnectionRetryPrompt(
  request: AgentRunRequest,
  task: AgentTask,
  completionInstruction?: string,
): AgentRunRequest {
  if (!task.fileEditingToolsEnabled) return request;
  return {
    ...request,
    prompt: `${request.prompt}\n\n<transient_connection_retry>\nA previous invocation of this same phase failed because the provider/harness connection ended.\nIt may have already modified files in the working tree.\nInspect the current diff before editing, preserve useful completed work, avoid duplicate changes, ${completionInstruction ?? "finish the phase and complete its required output contract"}.\n</transient_connection_retry>`,
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

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
