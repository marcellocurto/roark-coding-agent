import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { runProcessOrThrow } from "../cli/process.ts";
import type { RevisePrCliOptions } from "../cli/args.ts";
import type { WorkflowThinkingStage } from "../workflow/thinking.ts";
import { buildCommitArgv, buildPushArgv, buildStageAllArgv } from "../autorun/publish.ts";
import {
  formatVerificationArtifact,
  runVerification,
  type VerificationResult,
  type VerificationRunner,
} from "../autorun/verification.ts";
import { fetchPullRequestFeedback, type PullRequestFeedback } from "../github/pr.ts";
import { runPiAgent } from "../pi/agent.ts";
import { sharedSystemPrompt } from "../prompts/workflow-prompts.ts";
import type { AgentRunner } from "../workflow/agent-runner.ts";
import { assertCleanGitTree, gitDirtyLines } from "../workflow/git.ts";
import {
  createPrRevisionContext,
  formatPrFeedbackMarkdown,
  inferIssueFromPrBody,
  prRevisionArtifactRelativePath,
  type PrRevisionContext,
  writePrRevisionArtifact,
  writePrRevisionJsonArtifact,
} from "./artifacts.ts";
import { checkoutPrHeadBranch, validatePrBranchSafety } from "./branch.ts";
import { postPrRevisionSummaryComment } from "./comments.ts";
import { revisionImplementationPrompt, revisionPlanPrompt, revisionReviewPrompt } from "./prompts.ts";

export type PrRevisionOutcome =
  | "no-action-needed"
  | "needs-human"
  | "review-blocked"
  | "verification-failed"
  | "no-code-changes"
  | "published";

export type PrRevisionResult = {
  outcome: PrRevisionOutcome;
  context: PrRevisionContext;
  planStatus?: RevisionPlanStatus;
  reviewVerdict?: RevisionReviewVerdict;
  verification?: VerificationResult;
};

type RevisionPlanStatus = "revise" | "needs-human" | "no-action-needed";
type RevisionReviewVerdict = "approve" | "fixes-required" | "blocked";

export type RunPrRevisionDependencies = {
  fetchFeedback?: typeof fetchPullRequestFeedback;
  checkout?: typeof checkoutPrHeadBranch;
  agentRunner?: AgentRunner;
  verificationRunner?: VerificationRunner;
  postSummaryComment?: typeof postPrRevisionSummaryComment;
};

export async function runPrRevision(
  options: RevisePrCliOptions,
  deps: RunPrRevisionDependencies = {},
): Promise<PrRevisionResult> {
  const cwd = options.cwd;
  await assertCleanGitTree({ cwd, yes: options.yes });

  const fetchFeedback = deps.fetchFeedback ?? fetchPullRequestFeedback;
  const feedback = await fetchFeedback({ cwd, repo: options.repo, prNumber: options.prNumber });
  const repo = feedback.repo;
  validatePrBranchSafety(feedback.pr, repo);

  const checkout = deps.checkout ?? checkoutPrHeadBranch;
  await checkout({ cwd, repo, pr: feedback.pr });

  const context = await createPrRevisionContext({ ...options, repo });
  console.log(`Run directory: ${context.revisionDirRelative}`);

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
    return { outcome: "no-action-needed", context, planStatus };
  }

  if (planStatus === "needs-human") {
    await updateMetadata(context, feedback, { outcome: "needs-human", planStatus, endedAt: new Date().toISOString() });
    await postSummary({
      context,
      outcome: "needs-human",
      planStatus,
      skipped: extractSectionBullets(plan, "Human Needs"),
      artifactPaths: collectArtifactPaths(context, ["pr-feedback.md", "revision-plan.md", "metadata.json"]),
    });
    return { outcome: "needs-human", context, planStatus };
  }

  await runRevisionAgent(context, runner, {
    label: "Revision implementation",
    artifact: "revision-log.md",
    writable: true,
    thinkingStage: "revisionImplementation",
    prompt: revisionImplementationPrompt(context, 0),
  });

  let review = await runRevisionAgent(context, runner, {
    label: "Revision review",
    artifact: "revision-review.md",
    writable: false,
    thinkingStage: "revisionReview",
    prompt: revisionReviewPrompt(context, 0),
  });
  let reviewVerdict = parseReviewVerdict(review);

  for (let pass = 1; reviewVerdict === "fixes-required" && pass <= context.maxFixPasses; pass++) {
    await runRevisionAgent(context, runner, {
      label: `Revision fix pass ${pass}`,
      artifact: `revision-log-fix-pass-${pass}.md`,
      writable: true,
      thinkingStage: "revisionFix",
      prompt: revisionImplementationPrompt(context, pass),
    });
    review = await runRevisionAgent(context, runner, {
      label: `Revision review pass ${pass}`,
      artifact: `revision-review-pass-${pass}.md`,
      writable: false,
      thinkingStage: "revisionReview",
      prompt: revisionReviewPrompt(context, pass),
    });
    reviewVerdict = parseReviewVerdict(review);
  }

  if (reviewVerdict !== "approve") {
    await updateMetadata(context, feedback, { outcome: "review-blocked", planStatus, reviewVerdict, endedAt: new Date().toISOString() });
    await postSummary({
      context,
      outcome: "review-blocked",
      planStatus,
      reviewVerdict,
      skipped: extractSectionBullets(review, "Required Fixes"),
      artifactPaths: collectArtifactPaths(context, ["pr-feedback.md", "revision-plan.md", "revision-log.md", "revision-review.md", "metadata.json"]),
    });
    return { outcome: "review-blocked", context, planStatus, reviewVerdict };
  }

  const verification = await runVerification({ command: context.verifyCommand, cwd, runner: deps.verificationRunner });
  await writePrRevisionArtifact(context, "verification.md", formatVerificationArtifact(verification));

  if (!verification.ok) {
    await updateMetadata(context, feedback, { outcome: "verification-failed", planStatus, reviewVerdict, verification, endedAt: new Date().toISOString() });
    await postSummary({
      context,
      outcome: "verification-failed",
      planStatus,
      reviewVerdict,
      verification,
      addressed: extractSectionBullets(await safeReadLog(context, "revision-log.md"), "Addressed Must Fix Current Items"),
      skipped: extractSectionBullets(await safeReadLog(context, "revision-log.md"), "Skipped Items"),
      artifactPaths: collectArtifactPaths(context, ["pr-feedback.md", "revision-plan.md", "revision-log.md", "revision-review.md", "verification.md", "metadata.json"]),
    });
    return { outcome: "verification-failed", context, planStatus, reviewVerdict, verification };
  }

  if ((await dirtyLinesOutsideRoark(cwd)).length === 0) {
    await updateMetadata(context, feedback, { outcome: "no-code-changes", planStatus, reviewVerdict, verification, endedAt: new Date().toISOString() });
    await postSummary({
      context,
      outcome: "no-code-changes",
      planStatus,
      reviewVerdict,
      verification,
      skipped: ["Planner requested a revision, but no non-.roark code changes were present after implementation."],
      artifactPaths: collectArtifactPaths(context, ["pr-feedback.md", "revision-plan.md", "revision-log.md", "revision-review.md", "verification.md", "metadata.json"]),
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
    artifactPaths: collectArtifactPaths(context, ["pr-feedback.md", "revision-plan.md", "revision-log.md", "revision-review.md", "verification.md", "metadata.json"]),
  });

  return { outcome: "published", context, planStatus, reviewVerdict, verification };
}

async function runRevisionAgent(
  context: PrRevisionContext,
  runner: AgentRunner,
  input: { label: string; artifact: string; writable: boolean; thinkingStage: WorkflowThinkingStage; prompt: string },
): Promise<string> {
  console.log(`\n=== ${input.label} ===`);
  const content = await runner({
    cwd: context.cwd,
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
  const match = markdown.match(new RegExp(`##\\s+${escapeRegExp(section)}\\s*\\n\\s*([^\\s]+)`, "i"));
  const token = match?.[1]?.toLowerCase();
  return allowed.find((value) => value === token);
}

function extractSectionBullets(markdown: string, section: string): string[] {
  const match = markdown.match(new RegExp(`##\\s+${escapeRegExp(section)}\\s*\\n([\\s\\S]*?)(?=\\n##\\s+|$)`, "i"));
  if (!match?.[1]) return [];
  return match[1]
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim())
    .filter((line) => line && !/^none\.?$/i.test(line));
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
  await runProcessOrThrow(buildStageAllArgv(), { cwd: context.cwd, label: "git add -A" });
  await runProcessOrThrow(["git", "add", "-f", context.revisionDirRelative], { cwd: context.cwd, label: "git add revision artifacts" });
  await runProcessOrThrow(buildCommitArgv({ message: `roark: revise PR #${context.prNumber} (revision ${context.revision})` }), {
    cwd: context.cwd,
    label: "git commit",
  });
  await runProcessOrThrow(buildPushArgv({ remote: context.remote, branchName }), { cwd: context.cwd, label: `git push ${context.remote}` });
}

function collectArtifactPaths(context: PrRevisionContext, filenames: string[]): string[] {
  return filenames.map((filename) => prRevisionArtifactRelativePath(context, filename));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
