import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { runProcess, runProcessOrThrow } from "../cli/process.ts";
import type { RevisePrCliOptions } from "../cli/args.ts";
import type { WorkflowThinkingStage } from "../workflow/thinking.ts";
import { buildCommitArgv } from "../autorun/publish.ts";
import {
  classifyVerificationFailure,
  formatVerificationArtifact,
  runVerification,
  verificationFailureReason,
  type VerificationResult,
  type VerificationRunner,
} from "../autorun/verification.ts";
import { fetchPullRequestFeedback, type PullRequestFeedback } from "../github/pr.ts";
import { runPiAgent } from "../pi/agent.ts";
import { sharedSystemPrompt } from "../prompts/workflow-prompts.ts";
import { noopAsync } from "../utils/async.ts";
import type { AgentRunner } from "../workflow/agent-runner.ts";
import { assertCleanGitTree, gitDirtyLines } from "../workflow/git.ts";
import {
  createPrRevisionContext,
  formatPrFeedbackMarkdown,
  inferIssueFromPrBody,
  prRevisionArtifactRelativePath,
  removeAgentPrRevisionArtifacts,
  type PrRevisionContext,
  writePrRevisionArtifact,
  writePrRevisionJsonArtifact,
} from "./artifacts.ts";
import {
  defaultLifecycleHooks,
  defaultWorkspaceConfig,
  preparePrRevisionWorkspace,
  runLifecycleHook,
  type PreparedPrRevisionWorkspace,
} from "../autorun/workspace.ts";
import { validatePrBranchSafety } from "./branch.ts";
import type { checkoutPrHeadBranch } from "./branch.ts";
import { postPrRevisionSummaryComment } from "./comments.ts";
import { revisionImplementationPrompt, revisionPlanPrompt, revisionReviewPrompt } from "./prompts.ts";

export type PrRevisionOutcome =
  | "no-action-needed"
  | "needs-human"
  | "review-blocked"
  | "verification-failed"
  | "no-code-changes"
  | "published";

export interface PrRevisionResult {
  outcome: PrRevisionOutcome;
  context: PrRevisionContext;
  planStatus?: RevisionPlanStatus | undefined;
  reviewVerdict?: RevisionReviewVerdict | undefined;
  verification?: VerificationResult | undefined;
}

type RevisionPlanStatus = "revise" | "needs-human" | "no-action-needed";
type RevisionReviewVerdict = "approve" | "fixes-required" | "blocked";

export interface RunPrRevisionDependencies {
  fetchFeedback?: typeof fetchPullRequestFeedback | undefined;
  checkout?: typeof checkoutPrHeadBranch | undefined;
  prepareWorkspace?: typeof preparePrRevisionWorkspace | undefined;
  runLifecycleHook?: typeof runLifecycleHook | undefined;
  agentRunner?: AgentRunner | undefined;
  verificationRunner?: VerificationRunner | undefined;
  postSummaryComment?: typeof postPrRevisionSummaryComment | undefined;
}

export async function runPrRevision(
  options: RevisePrCliOptions,
  deps: RunPrRevisionDependencies = {},
): Promise<PrRevisionResult> {
  const controlCwd = options.cwd;
  await assertCleanGitTree({ cwd: controlCwd, yes: options.yes });

  const fetchFeedback = deps.fetchFeedback ?? fetchPullRequestFeedback;
  const feedback = await fetchFeedback({ cwd: controlCwd, repo: options.repo, prNumber: options.prNumber });
  const repo = feedback.repo;
  validatePrBranchSafety(feedback.pr, repo);

  const preparedWorkspace = await prepareRevisionWorkspace({ options, repo, feedback, deps });
  const hookRunner = deps.runLifecycleHook ?? runLifecycleHook;
  const hooks = options.hooks ?? defaultLifecycleHooks;

  try {
    const context = await createPrRevisionContext({ ...options, repo, controlCwd, agentCwd: preparedWorkspace.path });
    console.log(`Run directory: ${context.revisionDirRelative}`);
    if (context.agentCwd !== context.controlCwd) console.log(`Revision workspace: ${context.agentCwd}`);

    await hookRunner("beforeRun", hooks, context.agentCwd);
    await writeInitialArtifacts(context, feedback);

    const runner = deps.agentRunner ?? runPiAgent;
    const postSummary = deps.postSummaryComment ?? postPrRevisionSummaryComment;

    const plan = await runRevisionAgent(context, runner, {
      label: "Revision plan",
      artifact: "revision-plan.md",
      writable: false,
      thinkingStage: "revisionPlan",
      prompt: revisionPlanPrompt(context),
    });
    const planStatus = parsePlanStatus(plan);
    await updateMetadata(context, feedback, { outcome: "planned", planStatus });

    if (planStatus === "no-action-needed") {
      await updateMetadata(context, feedback, { outcome: "no-action-needed", planStatus, endedAt: new Date().toISOString() });
      console.log("No action needed; not mutating code, committing, pushing, or commenting.");
      await removeAgentPrRevisionArtifacts(context);
      return { outcome: "no-action-needed", context, planStatus };
    }

    if (planStatus === "needs-human") {
      await updateMetadata(context, feedback, { outcome: "needs-human", planStatus, endedAt: new Date().toISOString() });
      await removeAgentPrRevisionArtifacts(context);
      await postSummary({
        context,
        outcome: "needs-human",
        planStatus,
        skipped: extractSectionBullets(plan, "Human Needs"),
        artifactPaths: collectArtifactPaths(context, ["pr-feedback.md", "revision-plan.md", "metadata.json"]),
      });
      return { outcome: "needs-human", context, planStatus };
    }

    const artifactFilenames = ["pr-feedback.md", "revision-plan.md"];

    await runRevisionAgent(context, runner, {
      label: "Revision implementation",
      artifact: "revision-log.md",
      writable: true,
      thinkingStage: "revisionImplementation",
      prompt: revisionImplementationPrompt(context, 0),
    });
    artifactFilenames.push("revision-log.md");

    let review = await runRevisionAgent(context, runner, {
      label: "Revision review",
      artifact: "revision-review.md",
      writable: false,
      thinkingStage: "revisionReview",
      prompt: revisionReviewPrompt(context, 0),
    });
    artifactFilenames.push("revision-review.md");
    let reviewVerdict = parseReviewVerdict(review);
    let fixPassesUsed = 0;
    let verification: VerificationResult | undefined;

    for (;;) {
      if (reviewVerdict === "fixes-required") {
        if (fixPassesUsed >= context.maxFixPasses) {
          await updateMetadata(context, feedback, { outcome: "review-blocked", planStatus, reviewVerdict, fixPassesUsed, endedAt: new Date().toISOString() });
          await removeAgentPrRevisionArtifacts(context);
          await postSummary({
            context,
            outcome: "review-blocked",
            planStatus,
            reviewVerdict,
            skipped: extractSectionBullets(review, "Required Fixes"),
            artifactPaths: collectArtifactPaths(context, [...artifactFilenames, "metadata.json"]),
          });
          return { outcome: "review-blocked", context, planStatus, reviewVerdict };
        }

        const pass = ++fixPassesUsed;
        const logArtifact = `revision-log-fix-pass-${pass}.md`;
        await runRevisionAgent(context, runner, {
          label: `Revision fix pass ${pass}`,
          artifact: logArtifact,
          writable: true,
          thinkingStage: "revisionFix",
          prompt: revisionImplementationPrompt(context, pass),
        });
        artifactFilenames.push(logArtifact);

        const reviewArtifact = `revision-review-pass-${pass}.md`;
        review = await runRevisionAgent(context, runner, {
          label: `Revision review pass ${pass}`,
          artifact: reviewArtifact,
          writable: false,
          thinkingStage: "revisionReview",
          prompt: revisionReviewPrompt(context, pass),
        });
        artifactFilenames.push(reviewArtifact);
        reviewVerdict = parseReviewVerdict(review);
        continue;
      }

      if (reviewVerdict === "blocked") {
        await updateMetadata(context, feedback, { outcome: "review-blocked", planStatus, reviewVerdict, fixPassesUsed, endedAt: new Date().toISOString() });
        await removeAgentPrRevisionArtifacts(context);
        await postSummary({
          context,
          outcome: "review-blocked",
          planStatus,
          reviewVerdict,
          skipped: extractSectionBullets(review, "Required Fixes"),
          artifactPaths: collectArtifactPaths(context, [...artifactFilenames, "metadata.json"]),
        });
        return { outcome: "review-blocked", context, planStatus, reviewVerdict };
      }

      await hookRunner("beforeVerify", hooks, context.agentCwd);
      verification = await runVerification({ command: context.verifyCommand, cwd: context.agentCwd, runner: deps.verificationRunner });
      await writePrRevisionArtifact(context, "verification.md", formatVerificationArtifact(verification));
      addArtifactFilename(artifactFilenames, "verification.md");

      if (verification.ok) break;

      const classification = classifyVerificationFailure(verification);
      const failedReason = classification.repairable
        ? `Verification failed after ${context.maxFixPasses} fix passes: ${verificationFailureReason(verification)}`
        : verificationFailureReason(verification);

      if (!classification.repairable || fixPassesUsed >= context.maxFixPasses) {
        await updateMetadata(context, feedback, {
          outcome: "verification-failed",
          planStatus,
          reviewVerdict,
          verification,
          verificationFailureReason: failedReason,
          fixPassesUsed,
          endedAt: new Date().toISOString(),
        });
        await removeAgentPrRevisionArtifacts(context);
        await postSummary({
          context,
          outcome: "verification-failed",
          planStatus,
          reviewVerdict,
          verification,
          addressed: extractSectionBullets(await safeReadLog(context, "revision-log.md"), "Addressed Must Fix Current Items"),
          skipped: [failedReason, ...extractSectionBullets(await safeReadLog(context, "revision-log.md"), "Skipped Items")],
          artifactPaths: collectArtifactPaths(context, [...artifactFilenames, "metadata.json"]),
        });
        return { outcome: "verification-failed", context, planStatus, reviewVerdict, verification };
      }

      const pass = ++fixPassesUsed;
      const verificationBeforeFixArtifact = `verification-before-fix-${pass}.md`;
      await writePrRevisionArtifact(context, verificationBeforeFixArtifact, formatVerificationArtifact(verification));
      artifactFilenames.push(verificationBeforeFixArtifact);
      console.log(`Archived verification failure: ${prRevisionArtifactRelativePath(context, verificationBeforeFixArtifact)}`);

      const logArtifact = `revision-log-fix-pass-${pass}.md`;
      await runRevisionAgent(context, runner, {
        label: `Revision fix pass ${pass}`,
        artifact: logArtifact,
        writable: true,
        thinkingStage: "revisionFix",
        prompt: revisionImplementationPrompt(context, pass),
      });
      artifactFilenames.push(logArtifact);

      const reviewArtifact = `revision-review-pass-${pass}.md`;
      review = await runRevisionAgent(context, runner, {
        label: `Revision review pass ${pass}`,
        artifact: reviewArtifact,
        writable: false,
        thinkingStage: "revisionReview",
        prompt: revisionReviewPrompt(context, pass),
      });
      artifactFilenames.push(reviewArtifact);
      reviewVerdict = parseReviewVerdict(review);
    }

    if ((await dirtyLinesOutsideRoark(context.agentCwd)).length === 0) {
      await updateMetadata(context, feedback, { outcome: "no-code-changes", planStatus, reviewVerdict, verification, endedAt: new Date().toISOString() });
      await removeAgentPrRevisionArtifacts(context);
      await postSummary({
        context,
        outcome: "no-code-changes",
        planStatus,
        reviewVerdict,
        verification,
        skipped: ["Planner requested a revision, but no non-.roark code changes were present after implementation."],
        artifactPaths: collectArtifactPaths(context, [...artifactFilenames, "metadata.json"]),
      });
      return { outcome: "no-code-changes", context, planStatus, reviewVerdict, verification };
    }

    await updateMetadata(context, feedback, { outcome: "published", planStatus, reviewVerdict, verification, endedAt: new Date().toISOString() });
    await commitAndPushRevision(context, feedback.pr.headRefName);
    await postSummary({
      context,
      outcome: "published",
      planStatus,
      reviewVerdict,
      verification,
      addressed: extractSectionBullets(await safeReadLog(context, "revision-log.md"), "Addressed Must Fix Current Items"),
      skipped: extractSectionBullets(await safeReadLog(context, "revision-log.md"), "Skipped Items"),
      artifactPaths: collectArtifactPaths(context, [...artifactFilenames, "metadata.json"]),
    });

    return { outcome: "published", context, planStatus, reviewVerdict, verification };
  } finally {
    try {
      await hookRunner("afterRun", hooks, preparedWorkspace.path);
    } finally {
      await preparedWorkspace.releaseLock();
    }
  }
}

async function prepareRevisionWorkspace(input: {
  options: RevisePrCliOptions;
  repo: string;
  feedback: PullRequestFeedback;
  deps: RunPrRevisionDependencies;
}): Promise<PreparedPrRevisionWorkspace> {
  const { options, repo, feedback, deps } = input;
  if (deps.prepareWorkspace) {
    return deps.prepareWorkspace({
      controlCwd: options.cwd,
      repo,
      prNumber: options.prNumber,
      headRefName: feedback.pr.headRefName,
      workspace: options.workspace ?? defaultWorkspaceConfig,
      hooks: options.hooks ?? defaultLifecycleHooks,
    });
  }

  if (deps.checkout) {
    await deps.checkout({ cwd: options.cwd, repo, pr: feedback.pr });
    return {
      path: options.cwd,
      metadata: { path: options.cwd, strategy: "clone", cloneRemote: options.remote, createdNow: false },
      releaseLock: noopAsync,
    };
  }

  return preparePrRevisionWorkspace({
    controlCwd: options.cwd,
    repo,
    prNumber: options.prNumber,
    headRefName: feedback.pr.headRefName,
    workspace: options.workspace ?? defaultWorkspaceConfig,
    hooks: options.hooks ?? defaultLifecycleHooks,
  });
}

async function runRevisionAgent(
  context: PrRevisionContext,
  runner: AgentRunner,
  input: { label: string; artifact: string; writable: boolean; thinkingStage: WorkflowThinkingStage; prompt: string },
): Promise<string> {
  console.log(`\n=== ${input.label} ===`);
  const content = await runner({
    cwd: context.agentCwd,
    model: context.model,
    thinkingLevel: context.thinkingConfig[input.thinkingStage],
    systemPrompt: sharedSystemPrompt,
    prompt: input.prompt,
    writable: input.writable,
  });
  await writePrRevisionArtifact(context, input.artifact, content);
  console.log(`✓ ${input.label}: wrote ${prRevisionArtifactRelativePath(context, input.artifact)}`);
  return content;
}

async function writeInitialArtifacts(context: PrRevisionContext, feedback: PullRequestFeedback): Promise<void> {
  await writePrRevisionJsonArtifact(context, "pr-feedback.json", plannerFacingFeedback(feedback));
  await writePrRevisionArtifact(context, "pr-feedback.md", formatPrFeedbackMarkdown(feedback));
  await updateMetadata(context, feedback, { outcome: "started" });
}

function plannerFacingFeedback(feedback: PullRequestFeedback): PullRequestFeedback {
  return {
    ...feedback,
    comments: feedback.plannerComments,
  };
}

async function updateMetadata(
  context: PrRevisionContext,
  feedback: PullRequestFeedback,
  update: Record<string, unknown>,
): Promise<void> {
  await writePrRevisionJsonArtifact(context, "metadata.json", {
    prNumber: context.prNumber,
    revision: context.revision,
    repo: feedback.repo,
    startedAt: feedback.fetchedAt,
    inferredIssue: await inferIssueForRevision(context, feedback),
    pr: feedback.pr,
    excludedRoarkSummaryCommentIds: feedback.excludedRoarkSummaryCommentIds,
    ...update,
  });
}

async function inferIssueForRevision(context: PrRevisionContext, feedback: PullRequestFeedback): Promise<number | undefined> {
  return inferIssueFromPrBody(feedback.pr.body) ?? await inferIssueFromAttemptMetadata(context, feedback.pr.headRefName);
}

async function inferIssueFromAttemptMetadata(context: PrRevisionContext, headRefName: string): Promise<number | undefined> {
  const issueRoot = path.join(context.outDir, "issue");
  let issueDirs: string[];
  try {
    issueDirs = await readdir(issueRoot);
  } catch {
    return undefined;
  }

  for (const issueDir of issueDirs) {
    const attemptsDir = path.join(issueRoot, issueDir, "attempts");
    let attempts: string[];
    try {
      attempts = await readdir(attemptsDir);
    } catch {
      continue;
    }
    for (const attempt of attempts) {
      try {
        const raw = await readFile(path.join(attemptsDir, attempt, "attempt.json"), "utf8");
        const metadata = JSON.parse(raw) as { branch?: unknown; issueNumber?: unknown };
        if (metadata.branch === headRefName && typeof metadata.issueNumber === "number") return metadata.issueNumber;
      } catch {
        // Ignore malformed or missing historical metadata; this inference is best-effort.
      }
    }
  }

  return undefined;
}

function parsePlanStatus(markdown: string): RevisionPlanStatus {
  const status = extractToken(markdown, "Status", ["revise", "needs-human", "no-action-needed"] as const);
  if (!status) throw new Error("Revision plan did not include ## Status with revise, needs-human, or no-action-needed.");
  return status;
}

function parseReviewVerdict(markdown: string): RevisionReviewVerdict {
  const verdict = extractToken(markdown, "Verdict", ["approve", "fixes-required", "blocked"] as const);
  if (!verdict) throw new Error("Revision review did not include ## Verdict with approve, fixes-required, or blocked.");
  return verdict;
}

function extractToken<const T extends readonly string[]>(markdown: string, section: string, allowed: T): T[number] | undefined {
  const match = new RegExp(`##\\s+${escapeRegExp(section)}\\s*\\n\\s*([^\\s]+)`, "i").exec(markdown);
  const token = match?.[1]?.toLowerCase();
  return allowed.find((value) => value === token);
}

function extractSectionBullets(markdown: string, section: string): string[] {
  const match = new RegExp(`##\\s+${escapeRegExp(section)}\\s*\\n([\\s\\S]*?)(?=\\n##\\s+|$)`, "i").exec(markdown);
  if (!match?.[1]) return [];
  return match[1]
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim())
    .filter((line) => line !== "" && !/^none\.?$/i.test(line));
}

async function safeReadLog(context: PrRevisionContext, artifact: string): Promise<string> {
  try {
    const { readPrRevisionArtifact } = await import("./artifacts.ts");
    return await readPrRevisionArtifact(context, artifact);
  } catch {
    return "";
  }
}

async function dirtyLinesOutsideRoark(cwd: string): Promise<string[]> {
  return (await gitDirtyLines(cwd)).filter((line) => !statusLinePaths(line).every(isRoarkPath));
}

function statusLinePaths(line: string): string[] {
  const pathPart = line.slice(3).trim();
  if (!pathPart) return [];
  return pathPart.split(" -> ").map((filePath) => filePath.replace(/^"|"$/g, ""));
}

function isRoarkPath(filePath: string): boolean {
  return filePath === ".roark" || filePath.startsWith(".roark/");
}

async function commitAndPushRevision(context: PrRevisionContext, branchName: string): Promise<void> {
  await ensurePushRemote(context);
  await runProcessOrThrow(["git", "add", "-A", "--", ".", ":(exclude).roark"], { cwd: context.agentCwd, label: "git add revision changes" });
  await runProcessOrThrow(buildCommitArgv({ message: `roark: revise PR #${context.prNumber} (revision ${context.revision})` }), {
    cwd: context.agentCwd,
    label: "git commit",
  });
  await runProcessOrThrow(["git", "push", context.remote, `HEAD:${branchName}`], { cwd: context.agentCwd, label: `git push ${context.remote}` });
}

async function ensurePushRemote(context: PrRevisionContext): Promise<void> {
  const agentRemote = await runProcess(["git", "remote", "get-url", context.remote], { cwd: context.agentCwd });
  if (path.resolve(context.agentCwd) === path.resolve(context.controlCwd)) {
    if (agentRemote.exitCode === 0 && agentRemote.stdout.trim()) return;
    throw new Error(`Git remote '${context.remote}' is not configured in '${context.agentCwd}'.`);
  }

  const fetchUrl = (await runProcessOrThrow(["git", "remote", "get-url", context.remote], {
    cwd: context.controlCwd,
    label: `git remote get-url ${context.remote}`,
  })).trim();
  const pushUrl = (await runProcessOrThrow(["git", "remote", "get-url", "--push", context.remote], {
    cwd: context.controlCwd,
    label: `git remote get-url --push ${context.remote}`,
  })).trim();

  if (agentRemote.exitCode !== 0 || !agentRemote.stdout.trim()) {
    await runProcessOrThrow(["git", "remote", "add", context.remote, fetchUrl], { cwd: context.agentCwd, label: `git remote add ${context.remote}` });
  }

  const agentPushUrl = await runProcess(["git", "remote", "get-url", "--push", context.remote], { cwd: context.agentCwd });
  if (pushUrl && (agentPushUrl.exitCode !== 0 || agentPushUrl.stdout.trim() !== pushUrl)) {
    await runProcessOrThrow(["git", "remote", "set-url", "--push", context.remote, pushUrl], { cwd: context.agentCwd, label: `git remote set-url --push ${context.remote}` });
  }
}

function collectArtifactPaths(context: PrRevisionContext, filenames: string[]): string[] {
  return [...new Set(filenames)].map((filename) => prRevisionArtifactRelativePath(context, filename));
}

function addArtifactFilename(filenames: string[], filename: string): void {
  if (!filenames.includes(filename)) filenames.push(filename);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
