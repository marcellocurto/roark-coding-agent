import { adoptLegacyIssueComments } from "./attempts.ts";
import {
  formatAttemptResumedComment,
  publishIssueLedgerComment,
} from "./ledger-comments.ts";
import { latestCompleteReviewCycle } from "../workflow/artifacts.ts";
import { GitHubRequestError } from "../github/errors.ts";
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

import { formatAttemptMetadata, type AttemptMetadata } from "./attempts.ts";
import { AttemptStore } from "./attempts.ts";
import { autorunWorktreePath, type AutorunBranchPlan } from "./branch.ts";
import { checkoutExistingIssueBranch } from "./branch.ts";
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

export const runAutoContinue = Effect.fn("runAutoContinue")(function* (
  options: ContinueCliOptions,
) {
  const workspaces = yield* Workspace;
  const github = yield* GitHub;
  const cwd = path.resolve(options.cwd);
  const parsed = yield* Effect.try({
    try: () => parseIssueRef(options.issue, options.repo),
    catch: (cause) =>
      new GitHubRequestError({
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  });
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
        if (attemptMetadata.outcome === "published") {
          (yield* Presentation).line(
            `Attempt ${attempt} already opened a PR. Issue continuation is finished.`,
          );
          return attemptResult(attemptMetadata);
        }
        const fetched = yield* github.fetchGitHubIssue(options.issue, {
          cwd,
          repo: parsed.repo ?? options.repo,
        });
        yield* ensureAutorunLabelContract({
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
        adoptLegacyIssueComments(
          attemptMetadata,
          yield* latestCompleteReviewCycle(workflowContext),
        );
        yield* (yield* AttemptStore).persist(issueDir, attemptMetadata);
        if (attemptMetadata.workspace) {
          (yield* Presentation).line(
            `Reusing workspace for branch ${branchPlan.branchName}`,
          );
          preparedWorkspace = yield* workspaces.prepareClone({
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
        workflowContext = { ...workflowContext, continuing: !options.restart };
        const currentIssue = toIssueCandidate(fetched.issue);
        yield* github.transitionGitHubIssueLabels({
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
        const result = yield* runAutorunAttemptLifecycle({
          issueDir,
          workflowContext,
          issueSnapshot: fetched,
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
          inProgressOutcomeDetail: `continued at ${DateTime.formatIso(yield* DateTime.now)}`,
          continuation: {
            restart: options.restart,
            priorOutcome: attemptMetadata.outcome,
          },
          beforeWorkflow: (metadata) =>
            publishIssueLedgerComment({
              cwd: workflowContext.controlCwd,
              repo: parsed.repo ?? options.repo,
              issueNumber: metadata.issueNumber,
              attemptMetadata: metadata,
              phase: "attempt-status",
              body: formatAttemptResumedComment({
                issueNumber: metadata.issueNumber,
                attempt: metadata.attempt,
                branchName: metadata.branch,
              }),
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
        });
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
    force: false,
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
