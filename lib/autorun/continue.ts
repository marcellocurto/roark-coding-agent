import { decodeGitHubResponse } from "../github/errors.ts";
import { Workspace } from "./workspace-service.ts";
import { GitHub } from "../github/service.ts";
import { Presentation } from "../runtime/services.ts";
import { DateTime, Effect, FileSystem, Schema } from "effect";
import { runAutorunAttemptLifecycle } from "./attempt-lifecycle.ts";

import path from "node:path";
import type { ContinueCliOptions, IssueCliOptions } from "../cli/args.ts";
import { parseIssueRef, type GitHubIssue } from "../github/issue.ts";
import {
  createWorkflowContext,
  type WorkflowContext,
} from "../workflow/artifacts.ts";
import { ensureRunDir, readArtifact } from "../workflow/artifacts.ts";

import {
  formatAttemptMetadata,
  type AttemptMetadata,
  type Clock,
} from "./attempts.ts";
import { AttemptStore } from "./attempts.ts";
import { autorunWorktreePath, type AutorunBranchPlan } from "./branch.ts";
import { checkoutExistingIssueBranch } from "./branch.ts";
import {
  formatContinuationPlan,
  type ContinuePlanStep,
} from "./continue-plan.ts";
import { planContinuation } from "./continue-plan.ts";
import type { AutorunGateOptions } from "./publish-flow.ts";
import { formatContinueCommand } from "./recovery.ts";
import { type AutorunAttemptResult } from "./attempt-lifecycle.ts";
import { labelsToRemoveForAutorunTransition } from "./labels.ts";
import { ensureAutorunLabelContract } from "./labels.ts";
import { withAutorunIssueLock } from "./lock.ts";
import type { AutorunIssueCandidate } from "./selection.ts";
import {
  defaultLifecycleHooks,
  defaultWorkspaceConfig,
  type PreparedWorkspace,
} from "./workspace.ts";

import { type prepareCloneWorkspace } from "./workspace.ts";
export const runAutoContinue = Effect.fn("runAutoContinue")(function* (
  options: ContinueCliOptions,
  injected: {
    clock?: Clock | undefined;
    prepareCloneWorkspace?: typeof prepareCloneWorkspace | undefined;
    ensureAutorunLabelContract?: typeof ensureAutorunLabelContract | undefined;
    fetchGitHubIssue?: GitHub["Service"]["fetchGitHubIssue"] | undefined;
    transitionGitHubIssueLabels?:
      | GitHub["Service"]["transitionGitHubIssueLabels"]
      | undefined;
  } = {},
) {
  const clock = injected.clock;
  const workspaces = yield* Workspace;
  const prepareWorkspace =
    injected.prepareCloneWorkspace ?? workspaces.prepareClone;
  const ensureLabels =
    injected.ensureAutorunLabelContract ?? ensureAutorunLabelContract;
  const cwd = path.resolve(options.cwd);
  const parsed = yield* decodeGitHubResponse(() =>
    parseIssueRef(options.issue, options.repo),
  );
  const outDir = path.resolve(cwd, options.outDir);
  const issueDir = path.join(outDir, "issue", parsed.issueNumber);
  const attempt =
    options.attempt ?? (yield* (yield* AttemptStore).latest(issueDir));
  const recoveryCommand = formatContinueCommand({
    issueNumber: parsed.issueNumber,
    cwd,
    repo: parsed.repo,
    attempt,
  });
  (yield* Presentation).transition("Continuation", `#${parsed.issueNumber}`, {
    pass: attempt,
  });
  (yield* Presentation).line("Continue autorun attempt");
  (yield* Presentation).line(`Issue: #${parsed.issueNumber}`);
  (yield* Presentation).line(`Attempt: ${attempt}`);
  (yield* Presentation).recovery(recoveryCommand);
  return yield* withAutorunIssueLock(
    {
      cwd,
      issueNumber: parsed.issueNumber,
      description: `roark continue issue #${parsed.issueNumber} attempt ${attempt}`,
    },
    Effect.suspend(
      Effect.fnUntraced(function* () {
        let attemptMetadata = yield* (yield* AttemptStore).read(
          issueDir,
          attempt,
        );
        yield* assertAttemptMatchesIssue(attemptMetadata, parsed.issueNumber);
        if (attemptMetadata.outcome === "published" && !options.force) {
          (yield* Presentation).line(
            `Attempt ${attempt} is already published. Pass --force to rerun gates anyway.`,
          );
          return attemptResult(attemptMetadata);
        }
        if (attemptMetadata.outcome === "triage-stopped" && !options.force) {
          (yield* Presentation).line(
            `Attempt ${attempt} already stopped after triage. Pass --force to rerun the workflow.`,
          );
          return attemptResult(attemptMetadata);
        }
        yield* ensureLabels({
          cwd,
          repo: parsed.repo ?? options.repo,
          readyLabel: options.readyLabel,
          inProgressLabel: options.inProgressLabel,
          failureLabel: options.failureLabel,
          successLabel: options.successLabel,
        });
        const branchPlan: AutorunBranchPlan = {
          issueNumber: attemptMetadata.issueNumber,
          branchName: attemptMetadata.branch,
          baseBranch: attemptMetadata.baseBranch,
        };
        let preparedWorkspace: PreparedWorkspace | undefined;
        const legacyAgentCwd =
          attemptMetadata.worktreePath &&
          (yield* (yield* FileSystem.FileSystem).exists(
            attemptMetadata.worktreePath,
          ))
            ? attemptMetadata.worktreePath
            : autorunWorktreePath(cwd, attemptMetadata.issueNumber);
        let workflowContext = createWorkflowContext(
          createContinueWorkflowOptions(options, attempt),
          {
            agentCwd: attemptMetadata.workspace?.path ?? legacyAgentCwd,
            displayCommand: "continue",
          },
        );
        yield* ensureRunDir(workflowContext);
        if (attemptMetadata.workspace) {
          (yield* Presentation).line(
            `Reusing workspace for branch ${branchPlan.branchName}`,
          );
          preparedWorkspace = yield* prepareWorkspace({
            controlCwd: cwd,
            repo: parsed.repo ?? options.repo,
            issueNumber: attemptMetadata.issueNumber,
            plan: branchPlan,
            workspace: options.workspace ?? defaultWorkspaceConfig,
            hooks: options.hooks ?? defaultLifecycleHooks,
            mode: "continue",
            workspacePath: attemptMetadata.workspace.path,
          });
          workflowContext = createWorkflowContext(
            createContinueWorkflowOptions(options, attempt),
            { agentCwd: preparedWorkspace.path, displayCommand: "continue" },
          );
          yield* ensureRunDir(workflowContext);
        } else {
          (yield* Presentation).line(
            `Switching to legacy worktree branch ${branchPlan.branchName}`,
          );
          const recoveredAgentCwd = yield* checkoutExistingIssueBranch({
            cwd: workflowContext.controlCwd,
            plan: branchPlan,
            worktreePath: workflowContext.agentCwd,
          });
          if (recoveredAgentCwd !== workflowContext.agentCwd) {
            workflowContext = createWorkflowContext(
              createContinueWorkflowOptions(options, attempt),
              { agentCwd: recoveredAgentCwd, displayCommand: "continue" },
            );
            yield* ensureRunDir(workflowContext);
          }
        }
        attemptMetadata = formatAttemptMetadata({
          ...attemptMetadata,
          worktreePath: workflowContext.agentCwd,
          workspace: preparedWorkspace?.metadata ?? attemptMetadata.workspace,
          runArtifactPath: workflowContext.runDirRelative,
        });
        const continuationPlan = yield* planContinuation(workflowContext, {
          attemptOutcome: attemptMetadata.outcome,
        });
        const initialVerificationRepairPass =
          verificationRepairPassFromPlan(continuationPlan);
        if (isTerminalContinuationNoop(continuationPlan) && !options.force) {
          (yield* Presentation).line("Continuation plan:");
          for (const line of formatContinuationPlan(continuationPlan))
            (yield* Presentation).line(line);
          return attemptResult(attemptMetadata);
        }
        const fetchIssue =
          injected.fetchGitHubIssue ?? (yield* GitHub).fetchGitHubIssue;
        const fetched = yield* fetchIssue(options.issue, {
          cwd,
          repo: parsed.repo ?? options.repo,
        });
        const currentIssue = toIssueCandidate(fetched.issue);
        const transitionLabels =
          injected.transitionGitHubIssueLabels ??
          (yield* GitHub).transitionGitHubIssueLabels;
        yield* transitionLabels({
          cwd,
          repo: parsed.repo ?? options.repo,
          issueNumber: attemptMetadata.issueNumber,
          nextLabel: options.inProgressLabel,
          removeLabels: labelsToRemoveForAutorunTransition({
            issueLabels: currentIssue.labels,
            workflow: options,
            nextLabel: options.inProgressLabel,
          }),
        });
        const result = yield* runAutorunAttemptLifecycle(
          {
            issueDir,
            workflowContext,
            branchPlan,
            gateOptions: createGateOptions(
              options,
              workflowContext.controlCwd,
              branchPlan.baseBranch,
              parsed.repo,
            ),
            attemptMetadata,
            loadIssue: () =>
              loadIssueCandidate({
                context: workflowContext,
                options,
                issueNumber: attemptMetadata.issueNumber,
              }),
            logPrefix: "Continue",
            inProgressOutcomeDetail: `continued at ${clock?.now().toISOString() ?? DateTime.formatIso(yield* DateTime.now)}`,
            initialVerificationRepairPass,
            beforeWorkflow: Effect.fnUntraced(function* () {
              (yield* Presentation).line("Continuation plan:");
              for (const line of formatContinuationPlan(continuationPlan))
                (yield* Presentation).line(line);
            }),
            beforeRun: Effect.fnUntraced(function* () {
              yield* workspaces.refreshCopy({
                controlCwd: workflowContext.controlCwd,
                worktreePath: workflowContext.agentCwd,
                copyToWorktree: options.workspace?.copyToWorktree,
              });
              yield* workspaces.runHook(
                "beforeRun",
                options.hooks,
                workflowContext.agentCwd,
              );
            }),
            afterRun: () =>
              workspaces.runHook(
                "afterRun",
                options.hooks,
                workflowContext.agentCwd,
              ),
          },
          { clock },
        );
        return result;
      }),
    ),
  );
});
function attemptResult(metadata: AttemptMetadata): AutorunAttemptResult {
  return {
    issueNumber: metadata.issueNumber,
    outcome: metadata.outcome,
    outcomeDetail: metadata.outcomeDetail,
  };
}
export function createContinueWorkflowOptions(
  options: ContinueCliOptions,
  attempt: number,
): IssueCliOptions {
  return {
    command: "do",
    issue: options.issue,
    cwd: options.cwd,
    outDir: options.outDir,
    repo: options.repo,
    model: options.model,
    thinkingLevel: options.thinkingLevel,
    thinkingProfile: options.thinkingProfile,
    force: options.force,
    yes: options.yes,
    maxFixPasses: options.maxFixPasses,
    attempt,
  };
}
function createGateOptions(
  options: ContinueCliOptions,
  cwd: string,
  baseBranch: string,
  repo?: string,
): AutorunGateOptions {
  return {
    cwd,
    repo,
    verifyCommand: options.verifyCommand,
    readyLabel: options.readyLabel,
    failureLabel: options.failureLabel,
    successLabel: options.successLabel,
    inProgressLabel: options.inProgressLabel,
    remote: options.remote,
    baseBranch,
    hooks: options.hooks,
    workspace: options.workspace,
  };
}
const loadIssueCandidate = Effect.fn("loadIssueCandidate")(function* (input: {
  context: ReturnType<typeof createWorkflowContext>;
  options: ContinueCliOptions;
  issueNumber: number;
}) {
  const fromMetadata = yield* loadIssueCandidateFromMetadata(input.context);
  if (fromMetadata) return fromMetadata;
  return yield* Effect.gen(function* () {
    const fetched = yield* (yield* GitHub).fetchGitHubIssue(
      input.options.issue,
      { cwd: input.context.controlCwd, repo: input.options.repo },
    );
    return toIssueCandidate(fetched.issue);
  }).pipe(
    Effect.catch(
      Effect.fnUntraced(function* () {
        return {
          number: input.issueNumber,
          title: `Fix issue #${input.issueNumber}`,
        };
      }),
    ),
  );
});
const MetadataIssue = Schema.Struct({
  issue: Schema.Struct({
    number: Schema.Int,
    title: Schema.String.check(Schema.isMinLength(1)),
    url: Schema.optional(Schema.String),
    labels: Schema.optional(
      Schema.Array(Schema.Struct({ name: Schema.String })),
    ),
  }),
});
const decodeMetadataIssue = Schema.decodeUnknownEffect(
  Schema.fromJsonString(MetadataIssue),
);
const loadIssueCandidateFromMetadata = Effect.fnUntraced(function* (
  context: WorkflowContext,
) {
  return yield* readArtifact(context, "metadata").pipe(
    Effect.flatMap(decodeMetadataIssue),
    Effect.map((parsed) =>
      toIssueCandidate({
        ...parsed.issue,
        labels: parsed.issue.labels?.map((label) => ({ ...label })),
      }),
    ),
    Effect.catch(() => Effect.succeed(undefined)),
  );
});
function toIssueCandidate(issue: GitHubIssue): AutorunIssueCandidate {
  return {
    number: issue.number,
    title: issue.title,
    url: issue.url,
    labels: issue.labels,
  };
}
function verificationRepairPassFromPlan(
  steps: readonly ContinuePlanStep[],
): number | undefined {
  const first = steps[0];
  if (first?.type !== "run" || first.phase !== "fix") return undefined;
  return first.reason.includes("verification failed") ? first.pass : undefined;
}
function isTerminalContinuationNoop(
  steps: readonly ContinuePlanStep[],
): boolean {
  const first = steps[0];
  return (
    steps.length === 1 &&
    first?.type === "noop" &&
    first.reason.includes("maximum fix passes reached")
  );
}
const assertAttemptMatchesIssue = Effect.fnUntraced(function* (
  metadata: AttemptMetadata,
  issueNumber: string,
) {
  if (String(metadata.issueNumber) !== issueNumber) {
    return yield* new AutorunContinuationError({
      message: `Attempt metadata issue #${metadata.issueNumber} does not match requested issue #${issueNumber}.`,
    });
  }
});

export class AutorunContinuationError extends Schema.TaggedError<AutorunContinuationError>()(
  "AutorunContinuationError",
  { message: Schema.String },
) {}
