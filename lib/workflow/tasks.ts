import {
  isChangeReportArtifact,
  isReviewArtifact,
  artifactMarkdownSibling,
  artifactIdentity,
  formatArtifactRef,
} from "./artifact-catalog.ts";
import { ArtifactContractError } from "../structured-output/contract.ts";
import { Presentation } from "../runtime/services.ts";
import { Cause, Effect, Exit, Schema, type PlatformError } from "effect";
import { type ArtifactStore } from "./artifact-store.ts";
import { RunObservation } from "../observability/observer.ts";
import type { WorkflowThinkingStage } from "./thinking.ts";
import { phaseNameForArtifact } from "../observability/observer.ts";
import {
  createAgentRunRequest,
  type AgentRetryOptions,
} from "./agent-runner.ts";
import {
  artifactRelativePath,
  artifactAgentPath,
  type ArtifactRef,
  baselineResetLogRef,
  fixLogRef,
  implementationRestartLogRef,
  refinementLogRef,
  reviewARef,
  reviewBRef,
  type WorkflowContext,
} from "./artifacts.ts";
import { artifactExists, requireArtifacts } from "./artifacts.ts";
import { readArtifact, writeArtifact } from "./artifacts.ts";
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
import {
  normalizeReviewPair,
  parseReviewResultJson,
  type ReviewFindingSource,
} from "../review/result.ts";
import { reviewArtifactDefinition } from "../review/artifact.ts";
import {
  parseTriageResultJson,
  triageArtifactDefinition,
  type TriageResult,
} from "../triage/result.ts";
import {
  implementationPlanArtifactDefinition,
  parseImplementationPlanResultJson,
  type ImplementationPlanKind,
  requireImplementationPlanSource,
} from "../implementation-plan/result.ts";
import {
  changeReportArtifactDefinition,
  parseChangeReportJson,
  requireAddressedFindingIds,
  type ChangeReport,
  changeReportStopsExecution,
} from "../change-report/result.ts";
import {
  runStructuredArtifact,
  type StructuredArtifactDefinition,
} from "../structured-output/runner.ts";
import {
  type AgentDisplayContext,
  type AgentOperation,
} from "../presentation/presenter.ts";
import { runPresentedPhase } from "../presentation/phase.ts";
import { readContinuationState } from "../issue-continuation/checkpoint.ts";
import {
  readExecutionStop,
  recordExecutionStop,
  type ExecutionStopArtifact,
} from "./execution-stop.ts";
export interface AgentTask {
  artifact: ArtifactRef;
  label: string;
  fileEditingToolsEnabled: boolean;
  thinkingStage: WorkflowThinkingStage;
  prerequisites: ArtifactRef[];
  prompt: (
    context: WorkflowContext,
  ) => Effect.Effect<string, PlatformError.PlatformError, ArtifactStore>;
}
export type AgentTaskFailurePhase = "agent-error" | "output-contract";
export interface ChangeReportRunOptions {
  reassessExecutionStop?: boolean;
}
export type CodeRefinementSource = "initial" | "fix" | "restart";
export class AgentTaskRunError extends Schema.TaggedError<AgentTaskRunError>()(
  "AgentTaskRunError",
  {
    artifact: Schema.declare(
      (input: unknown): input is ArtifactRef =>
        typeof input === "string" ||
        (typeof input === "object" &&
          input !== null &&
          "name" in input &&
          "pass" in input),
    ),
    label: Schema.String,
    phase: Schema.Literals(["agent-error", "output-contract"]),
    originalError: Schema.Unknown,
  },
) {
  get originalMessage(): string {
    return formatError(this.originalError);
  }
  override get message(): string {
    return `${this.label} failed: ${this.originalMessage}`;
  }
}
const triageTask: AgentTask = {
  artifact: "triage",
  label: "Triage",
  fileEditingToolsEnabled: false,
  thinkingStage: "triage",
  prerequisites: ["issue"],
  prompt: (context) => Effect.succeed(triagePrompt(context)),
};
const planDraftTask: AgentTask = {
  artifact: "implementationPlanDraft",
  label: "Implementation plan draft",
  fileEditingToolsEnabled: false,
  thinkingStage: "plan",
  prerequisites: ["issue", "triage"],
  prompt: (context) => Effect.succeed(planDraftPrompt(context)),
};
function planTask(triage: TriageResult): AgentTask {
  return {
    artifact: "implementationPlan",
    label: "Implementation plan acceptance",
    fileEditingToolsEnabled: false,
    thinkingStage: "plan",
    prerequisites:
      triage.planAction === "draft"
        ? ["issue", "triage", "implementationPlanDraft"]
        : ["issue", "triage"],
    prompt: (context) => Effect.succeed(planPrompt(context, triage.planAction)),
  };
}
export function implementationTaskForPass(restartPass = 0): AgentTask {
  return {
    artifact: "implementationLog",
    label:
      restartPass > 0
        ? `Implementation restart pass ${restartPass}`
        : "Implementation",
    fileEditingToolsEnabled: true,
    thinkingStage: "implement",
    prerequisites:
      restartPass > 0
        ? [
            "issue",
            "triage",
            "implementationPlan",
            reviewARef(restartPass - 1),
            reviewBRef(restartPass - 1),
          ]
        : ["issue", "triage", "implementationPlan"],
    prompt: (context) =>
      Effect.succeed(implementationPrompt(context, restartPass)),
  };
}
export function codeRefinementTask(
  pass: number,
  source: CodeRefinementSource = pass === 0 ? "initial" : "fix",
): AgentTask {
  return {
    artifact: refinementLogRef(pass),
    label: `Code refinement pass ${pass}`,
    fileEditingToolsEnabled: true,
    thinkingStage: "codeRefinement",
    prerequisites: codeRefinementPrerequisites(pass, source),
    prompt: Effect.fnUntraced(function* (context) {
      return yield* codeRefinementPrompt(context, pass, source);
    }),
  };
}
function codeRefinementPrerequisites(
  pass: number,
  source: CodeRefinementSource,
): ArtifactRef[] {
  if (pass === 0 || source === "initial")
    return ["issue", "triage", "implementationPlan", "implementationLog"];
  const shared: ArtifactRef[] = [
    "issue",
    "triage",
    "implementationPlan",
    "implementationLog",
    reviewARef(pass - 1),
    reviewBRef(pass - 1),
  ];
  if (source === "restart")
    return [
      ...shared,
      baselineResetLogRef(pass),
      implementationRestartLogRef(pass),
    ];
  return [...shared, fixLogRef(pass)];
}
export function reviewATaskForPass(pass = 0): AgentTask {
  return {
    artifact: reviewARef(pass),
    label: `Review A pass ${pass}`,
    fileEditingToolsEnabled: false,
    thinkingStage: "reviewA",
    prerequisites: [
      "issue",
      "triage",
      "implementationPlan",
      "preImplementationBaseline",
      "implementationLog",
      refinementLogRef(pass),
    ],
    prompt: Effect.fnUntraced(function* (context) {
      return yield* reviewAPrompt(context, pass);
    }),
  };
}
export function reviewBTaskForPass(pass = 0): AgentTask {
  return {
    artifact: reviewBRef(pass),
    label: `Review B pass ${pass}`,
    fileEditingToolsEnabled: false,
    thinkingStage: "reviewB",
    prerequisites: [
      "issue",
      "triage",
      "implementationPlan",
      "preImplementationBaseline",
      "implementationLog",
      refinementLogRef(pass),
    ],
    prompt: Effect.fnUntraced(function* (context) {
      return yield* reviewBPrompt(context, pass);
    }),
  };
}
export function fixTask(pass: number): AgentTask {
  return {
    artifact: fixLogRef(pass),
    label: `Fix pass ${pass}`,
    fileEditingToolsEnabled: true,
    thinkingStage: "fix",
    prerequisites: [
      "issue",
      "implementationPlan",
      "implementationLog",
      reviewARef(pass - 1),
      reviewBRef(pass - 1),
    ],
    prompt: Effect.fnUntraced(function* (context) {
      return yield* fixPrompt(context, pass);
    }),
  };
}
export const runReviewTask = Effect.fn("runReviewTask")(function* (
  context: WorkflowContext,
  task: AgentTask,
  retryOptions: AgentRetryOptions = {},
) {
  const presentation = reviewPresentation(task.artifact, task.label);
  return yield* runStructuredArtifactTask(context, task, retryOptions, {
    parse: (content) => parseReviewResultJson(content, { allowRestart: true }),
    definition: reviewArtifactDefinition({
      allowRestart: true,
      title: task.label,
      source: presentation.source,
    }),
    markdownArtifact: presentation.markdownArtifact,
  });
});
export const runTriageTask = Effect.fn("runTriageTask")(function* (
  context: WorkflowContext,
  retryOptions: AgentRetryOptions = {},
) {
  return yield* runStructuredArtifactTask(context, triageTask, retryOptions, {
    parse: parseTriageResultJson,
    definition: triageArtifactDefinition,
    markdownArtifact: "triageMarkdown",
  });
});
const requireProceedingTriage = Effect.fn("requireProceedingTriage")(function* (
  context: WorkflowContext,
) {
  const triage = yield* parseTriageResultJson(
    yield* readArtifact(context, "triage"),
  );
  if (triage.verdict !== "proceed")
    return yield* Effect.fail(
      new ArtifactContractError({
        artifact: "Triage",
        message: `Triage stopped with ${triage.verdict}. Resolve the issue and rerun triage before continuing.`,
      }),
    );
  return triage;
});
export const runPlanDraftTask = Effect.fn("runPlanDraftTask")(function* (
  context: WorkflowContext,
  retryOptions: AgentRetryOptions = {},
) {
  yield* requireProceedingTriage(context);
  return yield* runImplementationPlanTask(
    context,
    planDraftTask,
    "draft",
    retryOptions,
  );
});
export const runPlanTask = Effect.fn("runPlanTask")(function* (
  context: WorkflowContext,
  retryOptions: AgentRetryOptions = {},
) {
  const triage = yield* requireProceedingTriage(context);
  if (triage.planAction === "draft") {
    const draft = yield* parseImplementationPlanResultJson(
      yield* readArtifact(context, "implementationPlanDraft"),
    );
    if (!draft.readyForImplementation)
      return yield* Effect.fail(
        new ArtifactContractError({
          artifact: "Implementation plan draft",
          message:
            "Draft planning stopped. Resolve its questions or blockers in the issue and run continue.",
        }),
      );
  }
  return yield* runImplementationPlanTask(
    context,
    planTask(triage),
    "final",
    retryOptions,
  );
});
export const runChangeReportTask = Effect.fn("runChangeReportTask")(function* (
  context: WorkflowContext,
  task: AgentTask,
  retryOptions: AgentRetryOptions = {},
  options: ChangeReportRunOptions = {},
) {
  const continuation = yield* readContinuationState(context);
  if (continuation && continuation.status !== "ready")
    return yield* Effect.fail(
      new ArtifactContractError({
        artifact: "Continuation",
        message:
          "Run continue to finish checking the current issue feedback before changing code.",
      }),
    );
  const reassessExecutionStop =
    task.artifact === "implementationLog" &&
    options.reassessExecutionStop === true;
  const activeStop = yield* readExecutionStop(context);
  if (!reassessExecutionStop && activeStop !== undefined)
    return yield* Effect.fail(
      new ArtifactContractError({
        artifact: "Execution",
        message:
          "Execution is stopped. Answer the recorded questions or resolve blockers in the issue, then run continue to check the latest discussion.",
      }),
    );
  const triage = yield* requireProceedingTriage(context);
  const plan = yield* parseImplementationPlanResultJson(
    yield* readArtifact(context, "implementationPlan"),
  );
  if (!plan.readyForImplementation)
    return yield* Effect.fail(
      new ArtifactContractError({
        artifact: "Implementation plan",
        message:
          "Implementation is not authorized by a ready plan. Resolve its questions or blockers and rerun planning.",
      }),
    );
  yield* requireImplementationPlanSource(plan, triage);
  if (triage.planAction === "draft") {
    const draft = yield* parseImplementationPlanResultJson(
      yield* readArtifact(context, "implementationPlanDraft"),
    );
    if (!draft.readyForImplementation)
      return yield* Effect.fail(
        new ArtifactContractError({
          artifact: "Implementation plan draft",
          message:
            "Draft planning stopped. Resolve its questions or blockers before implementation.",
        }),
      );
  }
  for (const artifact of task.prerequisites) {
    if (isChangeReportArtifact(artifact)) {
      const report = yield* parseChangeReportJson(
        yield* readArtifact(context, artifact),
      );
      if (
        report.blockingQuestions.length > 0 ||
        report.externalBlockers.length > 0
      )
        return yield* Effect.fail(
          new ArtifactContractError({
            artifact: "Execution",
            message:
              "A prerequisite phase stopped for a question or external blocker. Resolve it in the issue and run continue.",
          }),
        );
    }
  }
  const presentation = changeReportPresentation(task.artifact);
  const expectedFindingIds = yield* requiredFixFindingIds(
    context,
    task.artifact,
  );
  const validateForTask = Effect.fnUntraced(function* (report: ChangeReport) {
    if (expectedFindingIds !== undefined)
      return yield* requireAddressedFindingIds(report, expectedFindingIds);
    if (report.addressedFindingIds.length > 0) {
      return yield* Effect.fail(
        new ArtifactContractError({
          artifact: "Change report",
          message: "Only fix reports may contain addressedFindingIds.",
        }),
      );
    }
    return report;
  });
  const report = yield* runStructuredArtifactTask(context, task, retryOptions, {
    parse: (content) =>
      parseChangeReportJson(content).pipe(Effect.flatMap(validateForTask)),
    definition: changeReportArtifactDefinition({
      title: presentation.title,
      validate: validateForTask,
    }),
    markdownArtifact: presentation.markdownArtifact,
    retryCompletionInstruction:
      "finish the phase, run validation, and call submit_change_report with the complete structured report",
    beforePersist: (report) =>
      changeReportStopsExecution(report)
        ? recordExecutionStop(context, presentation.artifact)
        : Effect.void,
  });
  if (
    reassessExecutionStop &&
    activeStop !== undefined &&
    !changeReportStopsExecution(report)
  )
    yield* recordExecutionStop(context, null);
  return report;
});
const runImplementationPlanTask = Effect.fn("runImplementationPlanTask")(
  function* (
    context: WorkflowContext,
    task: AgentTask,
    kind: ImplementationPlanKind,
    retryOptions: AgentRetryOptions,
  ) {
    const triage = yield* requireProceedingTriage(context);
    const definition = implementationPlanArtifactDefinition(kind);
    const validate = Effect.fnUntraced(function* (value: unknown) {
      const plan = yield* definition.validate(value);
      if (kind === "final")
        yield* requireImplementationPlanSource(plan, triage);
      return plan;
    });
    return yield* runStructuredArtifactTask(context, task, retryOptions, {
      parse: (content) =>
        parseImplementationPlanResultJson(content).pipe(
          Effect.flatMap(validate),
        ),
      definition: { ...definition, validate },
      markdownArtifact:
        kind === "draft"
          ? "implementationPlanDraftMarkdown"
          : "implementationPlanMarkdown",
    });
  },
);
const runStructuredArtifactTask = Effect.fn("runStructuredArtifactTask")(
  function* <T>(
    context: WorkflowContext,
    task: AgentTask,
    retryOptions: AgentRetryOptions,
    contract: {
      parse: (content: string) => Effect.Effect<T, ArtifactContractError>;
      definition: StructuredArtifactDefinition<T>;
      markdownArtifact: ArtifactRef;
      retryCompletionInstruction?: string | undefined;
      beforePersist?:
        | ((
            value: T,
          ) => Effect.Effect<void, PlatformError.PlatformError, ArtifactStore>)
        | undefined;
    },
  ) {
    const prepared = yield* prepareTaskRun(context, task);
    const existing = yield* reuseTaskArtifact(
      context,
      task,
      prepared,
      contract.parse,
    );
    if (existing.reused) {
      yield* contract.beforePersist?.(existing.value) ?? Effect.void;
      yield* writeArtifact(
        context,
        contract.markdownArtifact,
        contract.definition.formatMarkdown(existing.value),
      );
      return existing.value;
    }
    return yield* executeTaskLifecycle(context, task, prepared, {
      run: Effect.fnUntraced(function* () {
        const artifact = yield* runStructuredArtifact(
          prepared.request,
          contract.definition,
          {
            writeJson: (content, value) =>
              Effect.gen(function* () {
                yield* contract.beforePersist?.(value) ?? Effect.void;
                yield* writeArtifact(context, task.artifact, content);
              }),
            writeMarkdown: (content) =>
              writeArtifact(context, contract.markdownArtifact, content),
          },
          {
            ...retryOptions,
            completionInstruction: contract.retryCompletionInstruction,
          },
        );
        return artifact.value;
      }),
      failurePhase: (error) =>
        Schema.is(ArtifactContractError)(error)
          ? "output-contract"
          : "agent-error",
    });
  },
);
function reviewPresentation(
  artifact: ArtifactRef,
  title: string,
): {
  markdownArtifact: ArtifactRef;
  source: ReviewFindingSource;
} {
  if (!isReviewArtifact(artifact))
    throw new Error(`${title} does not target a review artifact.`);
  const markdownArtifact = artifactMarkdownSibling(artifact);
  if (markdownArtifact === undefined)
    throw new Error(`${title} has no Markdown companion.`);
  return {
    markdownArtifact,
    source: artifact.name === "reviewA" ? "review-a" : "review-b",
  };
}
function changeReportPresentation(artifact: ArtifactRef): {
  artifact: ExecutionStopArtifact;
  markdownArtifact: ArtifactRef;
  title: string;
} {
  if (!isChangeReportArtifact(artifact))
    throw new Error(
      `Artifact ${formatArtifactRef(artifact)} is not a change report.`,
    );
  const markdownArtifact = artifactMarkdownSibling(artifact);
  if (markdownArtifact === undefined)
    throw new Error(
      `Artifact ${artifactIdentity(artifact).displayName} has no Markdown companion.`,
    );
  return {
    artifact,
    markdownArtifact,
    title: artifactIdentity(artifact).displayName,
  };
}
const requiredFixFindingIds = Effect.fn("requiredFixFindingIds")(function* (
  context: WorkflowContext,
  artifact: ArtifactRef,
) {
  if (typeof artifact === "string" || artifact.name !== "fixLog")
    return undefined;
  const previousCycle = Math.max(0, artifact.pass - 1);
  const [reviewA, reviewB] = yield* Effect.all([
    readArtifact(context, reviewARef(previousCycle)),
    readArtifact(context, reviewBRef(previousCycle)),
  ]);
  return normalizeReviewPair({
    reviewA: yield* parseReviewResultJson(reviewA, {
      allowRestart: true,
    }),
    reviewB: yield* parseReviewResultJson(reviewB, {
      allowRestart: true,
    }),
  })
    .filter(
      (finding) =>
        finding.classification === "must-fix-current" &&
        finding.blockedBy.length === 0,
    )
    .map((finding) => finding.workflowId);
});
const prepareTaskRun = Effect.fn("prepareTaskRun")(function* (
  context: WorkflowContext,
  task: AgentTask,
) {
  yield* requireArtifacts(context, ...task.prerequisites);
  const phase = phaseNameForArtifact(task.artifact);
  const display = displayContextForTask(context, task, phase);
  const prompt = yield* task.prompt(context);
  const continuationContext = (yield* artifactExists(
    context,
    "continuationReviewMarkdown",
  ))
    ? `\n<continuation_context>Read ${artifactAgentPath(context, "continuationReviewMarkdown")} for the latest confirmed answers and ${artifactAgentPath(context, "continuationInput")} for prior phase reports. Keep completed work, inspect the current diff, and finish the remaining steps. Do not repeat completed edits. If replanning, read the saved prior plan in the history directory recorded in ${artifactAgentPath(context, "continuationInput")}; preserve its useful details.</continuation_context>`
    : "";
  const observer = yield* RunObservation;
  const request = createAgentRunRequest(context, task.thinkingStage, {
    cwd: context.agentCwd,
    systemPrompt: sharedSystemPrompt,
    prompt: prompt + continuationContext,
    fileEditingToolsEnabled: task.fileEditingToolsEnabled,
    observer,
    display,
  });
  return {
    phase,
    thinkingLevel: request.thinkingLevel,
    model: request.model,
    display,
    request,
    observer,
  };
});
type PreparedTaskRun = Effect.Success<ReturnType<typeof prepareTaskRun>>;
const reuseTaskArtifact = Effect.fn("reuseTaskArtifact")(function* <T>(
  context: WorkflowContext,
  task: AgentTask,
  prepared: PreparedTaskRun,
  parse: (content: string) => Effect.Effect<T, ArtifactContractError>,
) {
  if (context.force || !(yield* artifactExists(context, task.artifact)))
    return { reused: false } as const;
  const content = yield* readArtifact(context, task.artifact);
  const parsed = yield* parse(content).pipe(Effect.result);
  if (parsed._tag === "Failure") {
    const presentation = yield* Presentation;
    presentation.warning(
      `${task.label}: existing ${artifactRelativePath(context, task.artifact)} is invalid (${parsed.failure.message}); regenerating.`,
    );
    return { reused: false } as const;
  }
  return yield* runPresentedPhase(
    prepared.display,
    () =>
      prepared.observer
        .phaseCompleted({
          phase: prepared.phase,
          label: task.label,
          artifact: task.artifact,
          model: prepared.model,
          thinkingLevel: prepared.thinkingLevel,
          reused: true,
        })
        .pipe(Effect.as({ reused: true as const, value: parsed.success })),
    () => ({
      outcome: "reused",
      artifact: artifactRelativePath(context, task.artifact),
    }),
  );
});
const executeTaskLifecycle = Effect.fn("executeTaskLifecycle")(function* <
  T,
  E,
  R,
>(
  context: WorkflowContext,
  task: AgentTask,
  prepared: PreparedTaskRun,
  options: {
    run: () => Effect.Effect<T, E, R>;
    failurePhase: (error: unknown) => AgentTaskFailurePhase;
  },
) {
  yield* prepared.observer.phaseStarted({
    phase: prepared.phase,
    label: task.label,
    artifact: task.artifact,
    model: prepared.model,
    thinkingLevel: prepared.thinkingLevel,
  });
  return yield* runPresentedPhase(
    prepared.display,
    () =>
      Effect.suspend(options.run).pipe(
        Effect.mapError(
          (error) =>
            new AgentTaskRunError({
              artifact: task.artifact,
              label: task.label,
              phase: options.failurePhase(error),
              originalError: error,
            }),
        ),
        Effect.onExit((exit) =>
          Exit.isSuccess(exit)
            ? prepared.observer.phaseCompleted({
                phase: prepared.phase,
                label: task.label,
                artifact: task.artifact,
                model: prepared.model,
                thinkingLevel: prepared.thinkingLevel,
              })
            : prepared.observer.phaseFailed({
                phase: prepared.phase,
                label: task.label,
                artifact: task.artifact,
                model: prepared.model,
                thinkingLevel: prepared.thinkingLevel,
                error: Cause.squash(exit.cause),
              }),
        ),
      ),
    () => ({
      outcome: "completed",
      artifact: artifactRelativePath(context, task.artifact),
    }),
    {
      failure: (error) => ({
        outcome:
          error instanceof AgentTaskRunError
            ? error.originalMessage
            : formatError(error),
        artifact: artifactRelativePath(context, task.artifact),
      }),
    },
  );
});
function displayContextForTask(
  context: WorkflowContext,
  task: AgentTask,
  phaseId: string,
): AgentDisplayContext {
  const pass =
    typeof task.artifact === "object" ? task.artifact.pass : undefined;
  return {
    command: context.displayCommand ?? "issue-workflow",
    repository: context.repo,
    target: `#${context.issueNumber}`,
    phaseId,
    phaseLabel: task.label,
    ...(pass !== undefined ? { pass } : {}),
    expectedArtifact: artifactRelativePath(context, task.artifact),
    operation: operationForTask(task),
  };
}
function operationForTask(task: AgentTask): AgentOperation {
  if (task.thinkingStage === "reviewA" || task.thinkingStage === "reviewB")
    return "review";
  return task.fileEditingToolsEnabled ? "edit" : "inspect";
}
function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
