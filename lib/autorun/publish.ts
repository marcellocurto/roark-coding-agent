import { fromLegacyPromise } from "../runtime/application.ts";
import { runApplicationPromise } from "../runtime/application.ts";
import type { ApplicationExecution } from "../runtime/application.ts";
import type { AutoCliOptions } from "../cli/args.ts";
import { readFileSync } from "node:fs";
import {
  runProcessPromise,
  runProcessOrThrowPromise,
} from "../cli/process-promise.ts";
import { runAgentPromise } from "../workflow/agent-runner.ts";
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
import type { AgentRunner } from "../workflow/agent-runner.ts";
import {
  presenter,
  type AgentDisplayContext,
} from "../presentation/presenter.ts";
import { runPresentedPhase } from "../presentation/phase.ts";
import { effectiveModelForStage } from "../workflow/model-routing.ts";
import {
  artifactPath,
  artifactRelativePath,
  fixLogRef,
  refinementLogRef,
  reviewARef,
  reviewBRef,
  type ArtifactRef,
  type WorkflowContext,
} from "../workflow/artifacts.ts";
import {
  artifactExistsPromise as artifactExists,
  latestCompleteReviewCyclePromise as latestCompleteReviewCycle,
} from "../workflow/artifacts-promise.ts";
import { writeArtifactPromise as writeArtifact } from "../workflow/artifacts-promise.ts";
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
  agentRunner?: AgentRunner | undefined;
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

export async function collectPrBodyArtifactPaths(
  context: WorkflowContext,
  application?: ApplicationExecution,
): Promise<string[]> {
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
      if (await artifactExists(context, fix, application)) candidates.push(fix);
    }
    const refinement = refinementLogRef(pass);
    if (await artifactExists(context, refinement, application))
      candidates.push(refinement);
  }

  const latestCycle = await latestCompleteReviewCycle(context, application);
  if (latestCycle !== undefined) {
    candidates.push(reviewARef(latestCycle), reviewBRef(latestCycle));
  }

  candidates.push("readiness", "verification");

  const paths: string[] = [];
  for (const artifact of candidates) {
    if (await artifactExists(context, artifact, application))
      paths.push(artifactRelativePath(context, artifact));
  }

  return paths;
}

export async function collectPrChangedFiles(
  options: { cwd: string; baseBranch: string },
  application?: ApplicationExecution,
): Promise<string[]> {
  if (!application)
    return runApplicationPromise(
      fromLegacyPromise((application) =>
        collectPrChangedFiles(options, application),
      ),
      application,
    );

  const output = await runProcessOrThrowPromise(
    ["git", "diff", "--name-only", "-z", `${options.baseBranch}...HEAD`, "--"],
    { cwd: options.cwd, label: "git diff PR changed files" },
    application,
  );
  return output.split("\0").filter((file) => file.length > 0);
}

export async function hasUncommittedChanges(
  options: { cwd: string },
  application?: ApplicationExecution,
): Promise<boolean> {
  if (!application)
    return runApplicationPromise(
      fromLegacyPromise((application) =>
        hasUncommittedChanges(options, application),
      ),
      application,
    );

  const result = await runProcessPromise(
    ["git", "status", "--porcelain", "--", ".", ":(exclude).roark"],
    { cwd: options.cwd },
    application,
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `git status --porcelain failed with exit code ${result.exitCode}:\n${result.stderr || result.stdout}`,
    );
  }
  return result.stdout.trim() !== "";
}

export async function publishAutorunResult(
  input: PublishAutorunResultInput,
  application?: ApplicationExecution,
): Promise<PublishedPullRequest> {
  if (!application)
    return runApplicationPromise(
      fromLegacyPromise((application) =>
        publishAutorunResult(input, application),
      ),
      application,
    );

  const display: AgentDisplayContext = {
    command: input.workflowContext.displayCommand ?? "auto",
    repository: input.options.repo,
    target: `#${input.issue.number}`,
    phaseId: "pr-publishing",
    phaseLabel: "Publish pull request",
    expectedArtifact: input.attemptMetadataPath,
    operation: "publish",
  };
  return runPresentedPhase(
    display,
    () => performAutorunPublication(input, display, application),
    (pr) => ({ outcome: `published ${pr.url}` }),
    undefined,
    application,
  );
}

async function performAutorunPublication(
  input: PublishAutorunResultInput,
  display: AgentDisplayContext,
  application?: ApplicationExecution,
): Promise<PublishedPullRequest> {
  const {
    options,
    issue,
    branchPlan,
    workflowContext,
    verification,
    attemptMetadata,
    attemptMetadataPath,
    agentRunner = runAgentPromise,
  } = input;
  const agentCwd = workflowContext.agentCwd;
  const controlCwd = workflowContext.controlCwd;

  presenter(application).line(`Publishing issue #${issue.number}`);

  if (await hasUncommittedChanges({ cwd: agentCwd }, application)) {
    presenter(application).line("Committing worktree changes");
    await runProcessOrThrowPromise(
      buildStageAllArgv(),
      { cwd: agentCwd, label: "git add -A" },
      application,
    );
    await runProcessPromise(
      ["git", "reset", "-q", "--", ".roark"],
      { cwd: agentCwd },
      application,
    );
    await runProcessOrThrowPromise(
      buildCommitArgv({
        message: formatCommitMessage({ issueNumber: issue.number }),
      }),
      { cwd: agentCwd, label: "git commit" },
      application,
    );
  } else {
    presenter(application).line("No uncommitted changes; skipping commit");
  }

  presenter(application).line(
    `Pushing ${branchPlan.branchName} to ${options.remote}`,
  );
  await runProcessOrThrowPromise(
    buildPushArgv({
      remote: options.remote,
      branchName: branchPlan.branchName,
    }),
    { cwd: agentCwd, label: `git push ${options.remote}` },
    application,
  );

  presenter(application).line("Authoring and creating pull request");
  const publishedPr = await authorAndPublishPullRequest(
    {
      options,
      issue,
      branchPlan,
      workflowContext,
      verification,
      attemptMetadata,
      attemptMetadataPath,
      agentRunner,
    },
    display,
    application,
  );
  const prUrl = publishedPr.url;
  if (prUrl) presenter(application).line(`PR: ${prUrl}`);

  const removeLabels = labelsToRemoveForAutorunTransition({
    issueLabels: issue.labels,
    workflow: options,
    nextLabel: options.successLabel,
    knownPresent: [options.inProgressLabel, options.failureLabel],
  });
  try {
    await runProcessOrThrowPromise(
      buildSuccessLabelArgv({
        repo: options.repo,
        issueNumber: issue.number,
        label: options.successLabel,
        removeLabels,
      }),
      { cwd: controlCwd, label: "gh issue edit --transition-label (success)" },
      application,
    );
  } catch (error) {
    presenter(application).warning(
      `WARNING failed to apply success label '${options.successLabel}': ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return { url: publishedPr.url, number: publishedPr.number };
}

export interface PublishedPullRequest {
  url: string;
  number: number;
}

interface AuthoredPullRequest extends PublishedPullRequest {
  title?: string | undefined;
  stdout?: string | undefined;
}

async function authorAndPublishPullRequest(
  input: PublishAutorunResultInput & { agentRunner: AgentRunner },
  display: AgentDisplayContext,
  application?: ApplicationExecution,
): Promise<AuthoredPullRequest> {
  const renderingContext = prDraftRenderingContext({
    issueNumber: input.issue.number,
  });
  const changedFiles = await collectPrChangedFiles(
    {
      cwd: input.workflowContext.agentCwd,
      baseBranch: input.branchPlan.baseBranch,
    },
    application,
  );
  const artifact = await runStructuredArtifact(
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
        artifactPaths: await collectPrBodyArtifactPaths(
          input.workflowContext,
          application,
        ),
        changedFiles,
      }),
      fileEditingToolsEnabled: false,
      observer: input.workflowContext.observer,
      display,
    },
    input.agentRunner,
    prDraftArtifactDefinition({
      renderingContext,
      localRoots: [
        input.workflowContext.controlCwd,
        input.workflowContext.agentCwd,
      ],
    }),
    {
      writeJson: (content) =>
        writeArtifact(input.workflowContext, "prDraft", content, application),
      writeMarkdown: (content) =>
        writeArtifact(
          input.workflowContext,
          "prDraftMarkdown",
          content,
          application,
        ),
    },
    application,
  );
  const draft = artifact.value;
  const body = artifact.markdown;
  const title = sanitizePublicMarkdown(draft.title, {
    localRoots: [
      input.workflowContext.controlCwd,
      input.workflowContext.agentCwd,
    ],
  });

  const stdout = await runProcessOrThrowPromise(
    buildPrCreateArgv({
      repo: input.options.repo,
      baseBranch: input.options.baseBranch,
      branchName: input.branchPlan.branchName,
      title,
    }),
    {
      cwd: input.workflowContext.controlCwd,
      label: "gh pr create",
      input: body,
    },
    application,
  );
  const url = extractPrUrl(stdout);
  if (!url)
    throw new Error(
      "gh pr create succeeded but did not return a pull request URL.",
    );
  const number = extractIssueNumber(url);
  if (number === undefined)
    throw new Error(
      "gh pr create succeeded but its pull request URL did not include a valid pull request number.",
    );
  return { url, number, title, stdout };
}

export async function updatePrBody(
  input: {
    cwd: string;
    repo?: string | undefined;
    pr: string;
    issueNumber: number;
    workflowContext: WorkflowContext;
    verification?: VerificationResult | undefined;
    attemptMetadata?: AttemptMetadata | undefined;
    followUpIssues?: FormatPrBodyFollowUpIssue[] | undefined;
  },
  application?: ApplicationExecution,
): Promise<void> {
  if (!application)
    return runApplicationPromise(
      fromLegacyPromise((application) => updatePrBody(input, application)),
      application,
    );

  const display: AgentDisplayContext = {
    command: input.workflowContext.displayCommand ?? "auto",
    repository: input.repo,
    target: `#${input.issueNumber}`,
    phaseId: "pr-body-update",
    phaseLabel: "Update PR body",
    operation: "publish",
  };
  await runPresentedPhase(
    display,
    async () => {
      const draft = parsePrDraftJson(
        readFileSync(artifactPath(input.workflowContext, "prDraft"), "utf8"),
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
      await writeArtifact(
        input.workflowContext,
        "prDraftMarkdown",
        body,
        application,
      );
      await runProcessOrThrowPromise(
        [
          "gh",
          "pr",
          "edit",
          input.pr,
          "--title",
          title,
          "--body-file",
          "-",
          ...(input.repo ? ["--repo", input.repo] : []),
        ],
        { cwd: input.cwd, label: "gh pr edit", input: body },
        application,
      );
    },
    () => ({ outcome: "updated" }),
    undefined,
    application,
  );
}

export function buildPrCreateArgv(input: {
  repo?: string | undefined;
  baseBranch: string;
  branchName: string;
  title: string;
}): string[] {
  return [
    "gh",
    "pr",
    "create",
    "--base",
    input.baseBranch,
    "--head",
    input.branchName,
    "--title",
    input.title,
    "--body-file",
    "-",
    ...(input.repo ? ["--repo", input.repo] : []),
  ];
}

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
