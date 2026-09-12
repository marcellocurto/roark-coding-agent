import { RunObservation } from "../observability/observer.ts";
import { GitHub } from "../github/service.ts";
import { readArtifact } from "../workflow/artifacts.ts";
import { Presentation } from "../runtime/services.ts";
import { Effect, Schema } from "effect";
import type { AutoCliOptions } from "../cli/args.ts";
import { runProcess, runProcessOrThrow } from "../cli/process.ts";
import {
  prCreatePrompt,
  prPublishingSystemPrompt,
} from "../prompts/pr-publishing-prompt.ts";
import { prDraftArtifactDefinition } from "../pr-publishing/artifact.ts";
import {
  formatPrDraftMarkdown,
  parsePrDraftJson,
  type PrDraftRenderingContext,
} from "../pr-publishing/result.ts";
import { type AgentDisplayContext } from "../presentation/presenter.ts";
import { runPresentedPhase } from "../presentation/phase.ts";
import { effectiveModelForStage } from "../workflow/model-routing.ts";
import {
  artifactRelativePath,
  fixLogRef,
  refinementLogRef,
  reviewARef,
  reviewBRef,
  type ArtifactRef,
  type WorkflowContext,
} from "../workflow/artifacts.ts";
import {
  artifactExists,
  latestCompleteReviewCycle,
} from "../workflow/artifacts.ts";
import { writeArtifact } from "../workflow/artifacts.ts";
import type { AttemptMetadata } from "./attempts.ts";
import type { AutorunBranchPlan } from "./branch.ts";
import type { AutorunIssueCandidate } from "./selection.ts";
import type { VerificationResult } from "./verification.ts";
import { sanitizePublicMarkdown } from "./public-output.ts";
import { runStructuredArtifact } from "../structured-output/runner.ts";
import { labelsToRemoveForAutorunTransition } from "./labels.ts";
export const defaultAutorunSuccessLabel = "agent-pr-opened";
export const defaultAutorunRemote = "origin";
export interface CommitArgvOptions {
  message: string;
}
export interface PushArgvOptions {
  remote: string;
  branchName: string;
}
export interface SuccessLabelArgvOptions {
  repo?: string | undefined;
  issueNumber: number;
  label: string;
  removeLabels?: readonly string[] | undefined;
}
export interface FormatPrBodyFollowUpIssue {
  title: string;
  url?: string | undefined;
  number?: number | undefined;
}
export type AutorunPublishOptions = Pick<
  AutoCliOptions,
  | "cwd"
  | "repo"
  | "failureLabel"
  | "successLabel"
  | "inProgressLabel"
  | "remote"
  | "baseBranch"
> &
  Partial<Pick<AutoCliOptions, "readyLabel">>;
export interface PublishAutorunResultInput {
  options: AutorunPublishOptions;
  issue: AutorunIssueCandidate;
  branchPlan: AutorunBranchPlan;
  workflowContext: WorkflowContext;
  verification?: VerificationResult | undefined;
  attemptMetadata?: AttemptMetadata | undefined;
  attemptMetadataPath?: string | undefined;
}
export function buildStageAllArgv(): string[] {
  return ["git", "add", "-A", "--", ".", ":(exclude).roark"];
}
export function buildCommitArgv(options: CommitArgvOptions): string[] {
  return ["git", "commit", "-m", options.message];
}
export function buildPushArgv(options: PushArgvOptions): string[] {
  return ["git", "push", "-u", options.remote, options.branchName];
}
export function buildSuccessLabelArgv(
  options: SuccessLabelArgvOptions,
): string[] {
  const repoArgs = options.repo ? ["--repo", options.repo] : [];
  const removeLabelArgs = (options.removeLabels ?? [])
    .filter((label) => label !== options.label)
    .flatMap((label) => ["--remove-label", label]);
  return [
    "gh",
    "issue",
    "edit",
    String(options.issueNumber),
    "--add-label",
    options.label,
    ...removeLabelArgs,
    ...repoArgs,
  ];
}
export function formatCommitMessage(input: { issueNumber: number }): string {
  return `roark: implement issue #${input.issueNumber}`;
}
export const collectPrBodyArtifactPaths = Effect.fn(
  "collectPrBodyArtifactPaths",
)(function* (context: WorkflowContext) {
  const candidates: ArtifactRef[] = [
    "issue",
    "triage",
    "implementationPlanDraft",
    "implementationPlan",
    "preImplementationBaseline",
    "implementationLog",
  ];
  for (let pass = 0; pass <= context.maxFixPasses; pass++) {
    if (pass > 0) {
      const fix = fixLogRef(pass);
      if (yield* artifactExists(context, fix)) candidates.push(fix);
    }
    const refinement = refinementLogRef(pass);
    if (yield* artifactExists(context, refinement)) candidates.push(refinement);
  }
  const latestCycle = yield* latestCompleteReviewCycle(context);
  if (latestCycle !== undefined) {
    candidates.push(reviewARef(latestCycle), reviewBRef(latestCycle));
  }
  candidates.push("readiness", "verification");
  const paths: string[] = [];
  for (const artifact of candidates) {
    if (yield* artifactExists(context, artifact))
      paths.push(artifactRelativePath(context, artifact));
  }
  return paths;
});
export const collectPrChangedFiles = Effect.fn("collectPrChangedFiles")(
  function* (options: { cwd: string; baseBranch: string }) {
    const output = yield* runProcessOrThrow(
      [
        "git",
        "diff",
        "--name-only",
        "-z",
        `${options.baseBranch}...HEAD`,
        "--",
      ],
      { cwd: options.cwd, label: "git diff PR changed files" },
    );
    return output.split("\0").filter((file) => file.length > 0);
  },
);
export const hasUncommittedChanges = Effect.fn("hasUncommittedChanges")(
  function* (options: { cwd: string }) {
    const result = yield* runProcess(
      ["git", "status", "--porcelain", "--", ".", ":(exclude).roark"],
      { cwd: options.cwd },
    );
    if (result.exitCode !== 0) {
      return yield* Effect.fail(
        new AutorunPublishError({
          message: `git status --porcelain failed with exit code ${result.exitCode}:\n${result.stderr || result.stdout}`,
        }),
      );
    }
    return result.stdout.trim() !== "";
  },
);
export const publishAutorunResult = Effect.fn("publishAutorunResult")(
  function* (input: PublishAutorunResultInput) {
    const display: AgentDisplayContext = {
      command: input.workflowContext.displayCommand ?? "auto",
      repository: input.options.repo,
      target: `#${input.issue.number}`,
      phaseId: "pr-publishing",
      phaseLabel: "Publish pull request",
      expectedArtifact: input.attemptMetadataPath,
      operation: "publish",
    };
    return yield* runPresentedPhase(
      display,
      () => performAutorunPublication(input, display),
      (pr) => ({ outcome: `published ${pr.url}` }),
      undefined,
    );
  },
);
const performAutorunPublication = Effect.fn("performAutorunPublication")(
  function* (input: PublishAutorunResultInput, display: AgentDisplayContext) {
    const {
      options,
      issue,
      branchPlan,
      workflowContext,
      verification,
      attemptMetadata,
      attemptMetadataPath,
    } = input;
    const agentCwd = workflowContext.agentCwd;
    const controlCwd = workflowContext.controlCwd;
    (yield* Presentation).line(`Publishing issue #${issue.number}`);
    if (yield* hasUncommittedChanges({ cwd: agentCwd })) {
      (yield* Presentation).line("Committing worktree changes");
      yield* runProcessOrThrow(buildStageAllArgv(), {
        cwd: agentCwd,
        label: "git add -A",
      });
      yield* runProcess(["git", "reset", "-q", "--", ".roark"], {
        cwd: agentCwd,
      });
      yield* runProcessOrThrow(
        buildCommitArgv({
          message: formatCommitMessage({ issueNumber: issue.number }),
        }),
        { cwd: agentCwd, label: "git commit" },
      );
    } else {
      (yield* Presentation).line("No uncommitted changes; skipping commit");
    }
    (yield* Presentation).line(
      `Pushing ${branchPlan.branchName} to ${options.remote}`,
    );
    yield* runProcessOrThrow(
      buildPushArgv({
        remote: options.remote,
        branchName: branchPlan.branchName,
      }),
      { cwd: agentCwd, label: `git push ${options.remote}` },
    );
    (yield* Presentation).line("Authoring and creating pull request");
    const publishedPr = yield* authorAndPublishPullRequest(
      {
        options,
        issue,
        branchPlan,
        workflowContext,
        verification,
        attemptMetadata,
        attemptMetadataPath,
      },
      display,
    );
    const prUrl = publishedPr.url;
    if (prUrl) (yield* Presentation).line(`PR: ${prUrl}`);
    const removeLabels = labelsToRemoveForAutorunTransition({
      issueLabels: issue.labels,
      workflow: options,
      nextLabel: options.successLabel,
      knownPresent: [options.inProgressLabel, options.failureLabel],
    });
    yield* Effect.gen(function* () {
      yield* (yield* GitHub).transitionGitHubIssueLabels({
        cwd: controlCwd,
        repo: options.repo,
        issueNumber: issue.number,
        nextLabel: options.successLabel,
        removeLabels,
      });
    }).pipe(
      Effect.catch(
        Effect.fnUntraced(function* (error) {
          (yield* Presentation).warning(
            `WARNING failed to apply success label '${options.successLabel}': ${error instanceof Error ? error.message : String(error)}`,
          );
        }),
      ),
    );
    return { url: publishedPr.url, number: publishedPr.number };
  },
);
export interface PublishedPullRequest {
  url: string;
  number: number;
}
const authorAndPublishPullRequest = Effect.fn("authorAndPublishPullRequest")(
  function* (input: PublishAutorunResultInput, display: AgentDisplayContext) {
    const renderingContext = prDraftRenderingContext({
      issueNumber: input.issue.number,
    });
    const changedFiles = yield* collectPrChangedFiles({
      cwd: input.workflowContext.agentCwd,
      baseBranch: input.branchPlan.baseBranch,
    });
    const artifact = yield* runStructuredArtifact(
      {
        cwd: input.workflowContext.controlCwd,
        model: effectiveModelForStage(
          input.workflowContext.model,
          "issuePublishing",
        ),
        thinkingLevel: input.workflowContext.thinkingConfig.issuePublishing,
        systemPrompt: prPublishingSystemPrompt(),
        prompt: prCreatePrompt({
          context: input.workflowContext,
          repo: input.options.repo,
          sourceIssue: input.issue,
          branchName: input.branchPlan.branchName,
          baseBranch: input.options.baseBranch,
          verification: input.verification,
          attemptMetadata: input.attemptMetadata,
          attemptMetadataPath: input.attemptMetadataPath,
          artifactPaths: yield* collectPrBodyArtifactPaths(
            input.workflowContext,
          ),
          changedFiles,
        }),
        fileEditingToolsEnabled: false,
        observer: yield* RunObservation,
        display,
      },
      prDraftArtifactDefinition({
        renderingContext,
        localRoots: [
          input.workflowContext.controlCwd,
          input.workflowContext.agentCwd,
        ],
      }),
      {
        writeJson: (content) =>
          writeArtifact(input.workflowContext, "prDraft", content),
        writeMarkdown: (content) =>
          writeArtifact(input.workflowContext, "prDraftMarkdown", content),
      },
    );
    const draft = artifact.value;
    const body = artifact.markdown;
    const title = sanitizePublicMarkdown(draft.title, {
      localRoots: [
        input.workflowContext.controlCwd,
        input.workflowContext.agentCwd,
      ],
    });
    const stdout = yield* (yield* GitHub).createPullRequest({
      cwd: input.workflowContext.controlCwd,
      repo: input.options.repo,
      baseBranch: input.options.baseBranch,
      branchName: input.branchPlan.branchName,
      title,
      body,
    });
    const url = extractPrUrl(stdout);
    if (!url)
      return yield* Effect.fail(
        new AutorunPublishError({
          message:
            "gh pr create succeeded but did not return a pull request URL.",
        }),
      );
    const number = extractIssueNumber(url);
    if (number === undefined)
      return yield* Effect.fail(
        new AutorunPublishError({
          message:
            "gh pr create succeeded but its pull request URL did not include a valid pull request number.",
        }),
      );
    return { url, number, title, stdout };
  },
);
export const updatePrBody = Effect.fn("updatePrBody")(function* (input: {
  cwd: string;
  repo?: string | undefined;
  pr: string;
  issueNumber: number;
  workflowContext: WorkflowContext;
  verification?: VerificationResult | undefined;
  attemptMetadata?: AttemptMetadata | undefined;
  followUpIssues?: FormatPrBodyFollowUpIssue[] | undefined;
}) {
  const display: AgentDisplayContext = {
    command: input.workflowContext.displayCommand ?? "auto",
    repository: input.repo,
    target: `#${input.issueNumber}`,
    phaseId: "pr-body-update",
    phaseLabel: "Update PR body",
    operation: "publish",
  };
  yield* runPresentedPhase(
    display,
    Effect.fnUntraced(function* () {
      const draft = yield* parsePrDraftJson(
        yield* readArtifact(input.workflowContext, "prDraft"),
      );
      const body = sanitizePublicMarkdown(
        formatPrDraftMarkdown(
          draft,
          prDraftRenderingContext({
            issueNumber: input.issueNumber,
            followUpIssues: input.followUpIssues,
          }),
        ),
        {
          localRoots: [
            input.workflowContext.controlCwd,
            input.workflowContext.agentCwd,
          ],
        },
      );
      const title = sanitizePublicMarkdown(draft.title, {
        localRoots: [
          input.workflowContext.controlCwd,
          input.workflowContext.agentCwd,
        ],
      });
      yield* writeArtifact(input.workflowContext, "prDraftMarkdown", body);
      yield* (yield* GitHub).updatePullRequest({
        cwd: input.cwd,
        repo: input.repo,
        pr: input.pr,
        title,
        body,
      });
    }),
    () => ({ outcome: "updated" }),
    undefined,
  );
});
export { buildPrCreateArgv } from "../github/pr-publishing.ts";
function prDraftRenderingContext(input: {
  issueNumber: number;
  followUpIssues?: readonly FormatPrBodyFollowUpIssue[] | undefined;
}): PrDraftRenderingContext {
  return {
    sourceIssueNumber: input.issueNumber,
    followUpIssues: input.followUpIssues,
  };
}
function extractPrUrl(stdout: string): string | undefined {
  return /https?:\/\/\S+\/pull\/\d+/.exec(stdout)?.[0]?.replace(/[),.;]+$/, "");
}
function extractIssueNumber(url: string): number | undefined {
  const value = Number.parseInt(/\/pull\/(\d+)/.exec(url)?.[1] ?? "", 10);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}
export class AutorunPublishError extends Schema.TaggedError<AutorunPublishError>()(
  "AutorunPublishError",
  { message: Schema.String },
) {}
