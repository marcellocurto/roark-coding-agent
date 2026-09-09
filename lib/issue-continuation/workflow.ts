import { createHash } from "node:crypto";
import path from "node:path";
import { Effect, FileSystem } from "effect";
import { GitHub } from "../github/service.ts";
import type { GitHubIssueSnapshot } from "../github/issue.ts";
import { runProcess } from "../cli/process.ts";
import type { AttemptOutcome } from "../autorun/attempts.ts";
import { planContinuation } from "../autorun/continue-plan.ts";
import { parseChangeReportJson } from "../change-report/result.ts";
import { parseTriageResultJson } from "../triage/result.ts";
import {
  parseImplementationPlanResultJson,
  formatImplementationPlanMarkdown,
} from "../implementation-plan/result.ts";
import { parseReviewResultJson } from "../review/result.ts";
import { runStructuredArtifact } from "../structured-output/runner.ts";
import { ArtifactContractError } from "../structured-output/contract.ts";
import { formatGitHubIssueArtifact } from "../prompts/github-issue-artifact.ts";
import { sharedSystemPrompt } from "../prompts/workflow-prompts.ts";
import { runPresentedPhase } from "../presentation/phase.ts";
import { effectiveModelForStage } from "../workflow/model-routing.ts";
import {
  artifactFilename,
  writeArtifact,
  writeJsonArtifact,
  type WorkflowContext,
} from "../workflow/artifacts.ts";
import { readExecutionStop } from "../workflow/execution-stop.ts";
import {
  archiveContinuation,
  applyContinuation,
  artifactFromFilename,
  continuationHistoryDir,
  invalidatedArtifacts,
  readContinuationState,
  writeContinuationState,
  type ContinuationState,
} from "./checkpoint.ts";
import {
  continuationDefinition,
  parseContinuationResult,
  type ContinuationQuestion,
} from "./result.ts";
import { continuationPrompt } from "./prompt.ts";
import { backupRestartWork, restoreRestartBaseline } from "./restart.ts";

export interface IssueContinuationOptions {
  restart: boolean;
  priorOutcome?: AttemptOutcome;
}
export const prepareIssueContinuation = Effect.fn("prepareIssueContinuation")(
  function* (
    context: WorkflowContext,
    options: IssueContinuationOptions,
    suppliedSnapshot?: GitHubIssueSnapshot,
  ) {
    const fs = yield* FileSystem.FileSystem;
    let previous = yield* readContinuationState(context);
    const restarting =
      options.restart ||
      (previous?.mode === "restart" && previous.status === "checking");
    if (previous?.status === "applying") {
      if (previous.restartBaseline !== null)
        yield* restoreRestartBaseline(context, previous.restartBaseline);
      yield* applyContinuation(context, previous);
      previous = { ...previous, status: "ready" };
    }
    const snapshot =
      suppliedSnapshot ??
      (yield* (yield* GitHub).fetchGitHubIssue(context.issueInput, {
        cwd: context.controlCwd,
        repo: context.repo,
      }));
    if (snapshot.issueNumber !== context.issueNumber)
      return yield* Effect.fail(
        new Error("Fetched issue does not match the saved run."),
      );
    const issueMarkdown = formatGitHubIssueArtifact(
      snapshot.issue,
      snapshot.relationships,
    );
    const id = (previous?.id ?? 0) + 1;
    const files = yield* archiveContinuation(context, id);
    const saved: Record<string, string> = {};
    for (const filename of files) {
      if (
        filename.startsWith("continuation-") &&
        filename !== "continuation-review.json"
      )
        continue;
      saved[filename] = yield* fs.readFileString(
        path.join(context.runDir, filename),
      );
    }
    const activeStop = yield* readExecutionStop(context);
    const { questions, stoppedFiles } = yield* savedQuestions(
      saved,
      activeStop === undefined ? undefined : artifactFilename(activeStop),
    );
    const replacements: Record<string, string> = {
      "issue.md": issueMarkdown,
      "metadata.json": JSON.stringify(snapshot, null, 2),
    };
    const state: ContinuationState = {
      version: 1,
      id,
      mode: restarting ? "restart" : "continue",
      status: "checking",
      resumeFrom: previous?.resumeFrom ?? "unchanged",
      pass: previous?.pass ?? null,
      invalidated: [],
      replacements,
      restartBaseline: null,
    };
    yield* writeContinuationState(context, state);
    if (restarting) {
      const baseline = yield* backupRestartWork(context, id);
      const restarting: ContinuationState = {
        ...state,
        status: "applying",
        resumeFrom: "triage",
        restartBaseline: baseline,
        invalidated: [
          ...invalidatedArtifacts(files, "triage", null),
          ...files.filter(
            (filename) =>
              filename.startsWith("continuation-") &&
              filename !== "continuation-state.json",
          ),
        ],
        replacements: {
          ...replacements,
          "execution-stop.json": JSON.stringify({ artifact: null }),
        },
      };
      yield* writeContinuationState(context, restarting);
      yield* restoreRestartBaseline(context, baseline);
      yield* applyContinuation(context, restarting);
      return;
    }

    const diff = yield* runProcess(
      ["git", "diff", "--binary", "HEAD", "--", ".", ":(exclude).roark"],
      { cwd: context.agentCwd },
    );
    const status = yield* runProcess(["git", "status", "--short"], {
      cwd: context.agentCwd,
    });
    const hasSavedWork = files.some((filename) =>
      [
        "triage.json",
        "implementation-plan.json",
        "implementation-log.json",
        "implementation-plan-draft.json",
      ].includes(filename),
    );
    const input = {
      previousIssue: saved["issue.md"] ?? null,
      currentIssue: snapshot,
      previousContinuation:
        previous === undefined
          ? null
          : {
              status: previous.status,
              resumeFrom: previous.resumeFrom,
              pass: previous.pass,
            },
      questions,
      savedResults: saved,
      workspace: {
        diff: diff.stdout,
        status: status.stdout,
        inspectionErrors: [diff.stderr, status.stderr].filter(Boolean),
      },
      historyDirectory: path.relative(
        context.agentCwd,
        continuationHistoryDir(context, id),
      ),
    };
    yield* writeJsonArtifact(context, "continuationInput", input);

    if (!hasSavedWork) {
      yield* writeContinuationState(context, { ...state, status: "applying" });
      yield* applyContinuation(context, state);
      return;
    }
    const display = {
      command: "continue",
      repository: context.repo,
      target: `#${context.issueNumber}`,
      phaseId: "continuation-review",
      phaseLabel: "Read new issue feedback",
      expectedArtifact: "continuation-review.json",
      operation: "inspect" as const,
    };
    const definition = continuationDefinition(questions);
    const checkedDefinition = {
      ...definition,
      validate: Effect.fnUntraced(function* (input: unknown) {
        const result = yield* definition.validate(input);
        if (result.pass !== null && result.pass > context.maxFixPasses)
          return yield* Effect.fail(
            new ArtifactContractError({
              artifact: "Continuation review",
              message: "The chosen pass exceeds this run's fix limit.",
            }),
          );
        if (result.status === "continue") {
          if (
            result.resumeFrom === "unchanged" &&
            previous !== undefined &&
            previous.status !== "ready"
          )
            return yield* Effect.fail(
              new ArtifactContractError({
                artifact: "Continuation review",
                message:
                  "A blocked or interrupted continuation needs a concrete phase to resume. Recheck the saved position and choose that phase.",
              }),
            );
          const invalidated = invalidatedArtifacts(
            stoppedFiles,
            result.resumeFrom,
            result.pass,
          );
          if (stoppedFiles.some((filename) => !invalidated.includes(filename)))
            return yield* Effect.fail(
              new ArtifactContractError({
                artifact: "Continuation review",
                message:
                  "Resume the stopped phase or an earlier phase; do not skip unfinished work.",
              }),
            );
        }
        const commentIds = new Set(
          (snapshot.issue.comments ?? [])
            .map((comment) => comment.id)
            .filter((id) => id !== undefined),
        );
        if (
          result.resolutions.some((resolution) =>
            resolution.sources.some(
              (source) =>
                source.startsWith("comment:") &&
                !commentIds.has(source.slice("comment:".length)),
            ),
          )
        )
          return yield* Effect.fail(
            new ArtifactContractError({
              artifact: "Continuation review",
              message:
                "A resolution cites a comment that is not in the fetched discussion.",
            }),
          );
        return result;
      }),
    };
    const assessment = yield* runPresentedPhase(
      display,
      () =>
        runStructuredArtifact(
          {
            cwd: context.agentCwd,
            model: effectiveModelForStage(context.model, "plan"),
            thinkingLevel: context.thinkingConfig.plan,
            systemPrompt: sharedSystemPrompt,
            prompt: continuationPrompt(context),
            fileEditingToolsEnabled: false,
            observer: context.observer,
            display,
          },
          checkedDefinition,
          {
            writeJson: (content) =>
              writeArtifact(context, "continuationReview", content),
            writeMarkdown: (content) =>
              writeArtifact(context, "continuationReviewMarkdown", content),
          },
        ),
      () => ({ outcome: "checked", artifact: "continuation-review.json" }),
    );
    const decision = assessment.value;
    if (decision.status === "blocked") {
      yield* writeArtifact(context, "issue", issueMarkdown);
      yield* writeArtifact(
        context,
        "metadata",
        replacements["metadata.json"] ?? "",
      );
      yield* writeContinuationState(context, {
        ...state,
        status: "blocked",
        resumeFrom:
          decision.resumeFrom === "unchanged"
            ? state.resumeFrom
            : decision.resumeFrom,
        pass: decision.resumeFrom === "unchanged" ? state.pass : decision.pass,
      });
      return;
    }
    // Keep confirmed answers with the accepted plan without asking another agent
    // to rewrite it. Changed requirements go back through planning instead.
    if (
      !decision.requirementsChanged &&
      saved["implementation-plan.json"] !== undefined &&
      !["triage", "plan-draft", "plan"].includes(decision.resumeFrom)
    ) {
      const plan = yield* parseImplementationPlanResultJson(
        saved["implementation-plan.json"],
      );
      const resolvedQuestions = [...plan.resolvedQuestions];
      for (const resolution of decision.resolutions) {
        const question = questions.find(
          (item) => item.id === resolution.questionId,
        );
        if (question && resolution.answer !== null) {
          const answer = {
            question: question.question,
            resolution: resolution.answer,
            evidence: resolution.sources.join("; "),
          };
          const previousIndex = resolvedQuestions.findIndex(
            (item) => item.question === answer.question,
          );
          if (previousIndex === -1) resolvedQuestions.push(answer);
          else resolvedQuestions[previousIndex] = answer;
        }
      }
      const updated = { ...plan, resolvedQuestions };
      replacements["implementation-plan.json"] = JSON.stringify(
        updated,
        null,
        2,
      );
      replacements["implementation-plan.md"] = formatImplementationPlanMarkdown(
        updated,
        "final",
      );
    }
    let ready: ContinuationState = {
      ...state,
      status: "applying",
      resumeFrom:
        decision.resumeFrom === "unchanged"
          ? state.resumeFrom
          : decision.resumeFrom,
      pass: decision.resumeFrom === "unchanged" ? state.pass : decision.pass,
      invalidated: invalidatedArtifacts(
        files,
        decision.resumeFrom,
        decision.pass,
      ),
      replacements: {
        ...replacements,
        "execution-stop.json": JSON.stringify({ artifact: null }),
      },
    };
    // Unchanged feedback can still resume a deterministic verification repair.
    if (
      decision.resumeFrom === "unchanged" &&
      options.priorOutcome === "failed-verification"
    ) {
      yield* writeContinuationState(context, { ...state, status: "ready" });
      const next = (yield* planContinuation(context, {
        attemptOutcome: options.priorOutcome,
      }))[0];
      if (next?.type === "run" && next.phase === "fix") {
        ready = { ...ready, resumeFrom: "fix", pass: next.pass ?? 1 };
      }
    }
    yield* writeContinuationState(context, ready);
    yield* applyContinuation(context, ready);
  },
);

const savedQuestions = Effect.fn("savedContinuationQuestions")(function* (
  saved: Readonly<Record<string, string>>,
  activeStop: string | undefined,
) {
  const questions = new Map<string, ContinuationQuestion>();
  const stoppedFiles = new Set<string>(
    activeStop === undefined ? [] : [activeStop],
  );
  const reviewPasses = Object.keys(saved).flatMap((filename) => {
    const artifact = artifactFromFilename(filename);
    return typeof artifact === "object" &&
      (artifact.name === "reviewA" || artifact.name === "reviewB")
      ? [artifact.pass]
      : [];
  });
  const latestReviewPass = Math.max(-1, ...reviewPasses);
  const triageContent = saved["triage.json"];
  const triage =
    triageContent === undefined
      ? undefined
      : yield* parseTriageResultJson(triageContent).pipe(
          Effect.catchTag("ArtifactContractError", () =>
            Effect.succeed(undefined),
          ),
        );
  for (const [filename, content] of Object.entries(saved)) {
    const artifact = artifactFromFilename(filename);
    let texts: readonly string[] = [];
    const parsed = yield* Effect.gen(function* () {
      if (artifact === "continuationReview") {
        const result = yield* parseContinuationResult(content);
        return result.status === "blocked"
          ? [
              ...result.resolutions
                .filter((item) => item.status === "unresolved")
                .map((item) => item.question ?? item.questionId),
              ...result.blockingQuestions,
              ...result.externalBlockers,
            ]
          : [];
      }
      if (artifact === "triage") {
        const result = yield* parseTriageResultJson(content);
        if (result.verdict !== "proceed") stoppedFiles.add(filename);
        return result.verdict === "proceed" ? [] : result.blockingQuestions;
      }
      if (
        artifact === "implementationPlan" ||
        (artifact === "implementationPlanDraft" &&
          triage?.planAction === "draft")
      ) {
        const result = yield* parseImplementationPlanResultJson(content);
        if (!result.readyForImplementation) stoppedFiles.add(filename);
        return result.readyForImplementation
          ? []
          : [...result.blockingQuestions, ...result.externalBlockers];
      }
      if (
        artifact === "implementationLog" ||
        (typeof artifact === "object" &&
          (artifact.name === "fixLog" || artifact.name === "refinementLog"))
      ) {
        if (activeStop !== undefined && activeStop !== filename) return [];
        const result = yield* parseChangeReportJson(content);
        const unresolved = [
          ...result.blockingQuestions,
          ...result.externalBlockers,
        ];
        if (unresolved.length > 0) stoppedFiles.add(filename);
        return unresolved;
      }
      if (
        typeof artifact === "object" &&
        (artifact.name === "reviewA" || artifact.name === "reviewB") &&
        artifact.pass === latestReviewPass
      ) {
        const result = yield* parseReviewResultJson(content, {
          allowRestart: true,
        });
        const unresolved = [
          ...result.findings.flatMap((finding) => finding.blockedBy),
          ...result.limitations
            .filter((limitation) => limitation.blocksApproval)
            .map((limitation) => limitation.description),
        ];
        if (unresolved.length > 0) stoppedFiles.add(filename);
        return unresolved;
      }
      return [];
    }).pipe(Effect.result);
    if (parsed._tag === "Success") texts = parsed.success;
    else if (
      artifact === "triage" ||
      artifact === "implementationPlan" ||
      artifact === "implementationPlanDraft"
    )
      stoppedFiles.add(filename);
    for (const question of texts) {
      const id = `question:${createHash("sha256").update(question).digest("hex").slice(0, 16)}`;
      questions.set(id, { id, question, artifact: filename });
    }
  }
  return {
    questions: [...questions.values()],
    stoppedFiles: [...stoppedFiles],
  };
});
