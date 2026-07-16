import type { AutoCliOptions } from "../cli/args.ts";
import { readFileSync } from "node:fs";
import { runProcess, runProcessOrThrow } from "../cli/process.ts";
import { runPiAgent } from "../pi/agent.ts";
import { prCreatePrompt, prPublishingSystemPrompt } from "../prompts/pr-publishing-prompt.ts";
import { prDraftArtifactDefinition } from "../pr-publishing/artifact.ts";
import { formatPrDraftMarkdown, parsePrDraftJson, type PrDraftRenderingContext } from "../pr-publishing/result.ts";
import type { AgentRunner } from "../workflow/agent-runner.ts";
import { presenter, type AgentDisplayContext } from "../presentation/presenter.ts";
import { runPresentedPhase } from "../presentation/phase.ts";
import { effectiveModelForStage } from "../workflow/model-routing.ts";
import {
  artifactExists,
  artifactPath,
  artifactRelativePath,
  fixLogRef,
  latestCompleteReviewCycle,
  refinementLogRef,
  reviewARef,
  reviewBRef,
  writeArtifact,
  type ArtifactRef,
  type WorkflowContext,
} from "../workflow/artifacts.ts";
import type { AttemptMetadata } from "./attempts.ts";
import type { AutorunBranchPlan } from "./branch.ts";
import type { AutorunIssueCandidate } from "./selection.ts";
import type { VerificationResult } from "./verification.ts";
import { sanitizePublicMarkdown } from "./public-output.ts";
import { parseImplementationPlanResultJson } from "../implementation-plan/result.ts";
import { parseChangeReportJson, type ChangeReport } from "../change-report/result.ts";
import { runStructuredArtifact } from "../structured-output/runner.ts";
import { labelsToRemoveForAutorunTransition } from "./labels.ts";

export const defaultAutorunSuccessLabel = "agent-pr-opened";
export const defaultAutorunRemote = "origin";

export interface CommitArgvOptions { message: string }
export interface PushArgvOptions { remote: string; branchName: string }
export interface SuccessLabelArgvOptions {
  repo?: string | undefined  ;
  issueNumber: number;
  label: string;
  removeLabels?: readonly string[] | undefined;
}

export interface FormatPrBodyFollowUpIssue {
  title: string;
  url?: string | undefined;
  number?: number | undefined;
}

export interface FormatPrBodyNarrativeFilesChanged {
  behavior: string[];
  tests: string[];
  plumbing: string[];
  docs: string[];
  other: string[];
}

export interface FormatPrBodyNarrative {
  issueTitle?: string | undefined;
  workClassification?: string | undefined;
  summary?: string | undefined;
  before?: string[] | undefined;
  after?: string[] | undefined;
  rootCause?: string[] | undefined;
  fix?: string[] | undefined;
  acceptanceCriteria?: string[] | undefined;
  reviewPath?: string[] | undefined;
  filesChanged?: FormatPrBodyNarrativeFilesChanged | undefined;
  importantNonChanges?: string[] | undefined;
  verificationNotes?: string[] | undefined;
  manualVerification?: string[] | undefined;
  risks?: string[] | undefined;
  edgeCases?: string[] | undefined;
  reviewerQuestions?: string[] | undefined;
}

export type AutorunPublishOptions = Pick<
  AutoCliOptions,
  "cwd" | "repo" | "failureLabel" | "successLabel" | "inProgressLabel" | "remote" | "baseBranch"
> & Partial<Pick<AutoCliOptions, "readyLabel">>;

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

export function buildSuccessLabelArgv(options: SuccessLabelArgvOptions): string[] {
  const repoArgs = options.repo ? ["--repo", options.repo] : [];
  const removeLabelArgs = (options.removeLabels ?? [])
    .filter((label) => label !== options.label)
    .flatMap((label) => ["--remove-label", label]);
  return ["gh", "issue", "edit", String(options.issueNumber), "--add-label", options.label, ...removeLabelArgs, ...repoArgs];
}

export function formatCommitMessage(input: { issueNumber: number }): string {
  return `roark: implement issue #${input.issueNumber}`;
}

function nonEmptyItems(items: string[] | undefined): string[] {
  return (items ?? []).map((item) => item.trim()).filter((item) => item.length > 0);
}

function isNoneItem(item: string): boolean {
  return /^(?:none|not applicable|n\/a|not run|unknown)[.!]?$/i.test(item.trim());
}

function stripCheckboxMarker(item: string): string {
  return item.replace(/^\[[ xX]\]\s+/, "");
}

export function collectPrBodyArtifactPaths(context: WorkflowContext): string[] {
  const candidates: ArtifactRef[] = [
    "issue",
    "triage",
    "implementationPlanDraft",
    "implementationPlan",
    "preImplementationBaseline",
    "implementationLog",
    "prNarrative",
  ];

  for (let pass = 0; pass <= context.maxFixPasses; pass++) {
    if (pass > 0) {
      const fix = fixLogRef(pass);
      if (artifactExists(context, fix)) candidates.push(fix);
    }
    const refinement = refinementLogRef(pass);
    if (artifactExists(context, refinement)) candidates.push(refinement);
  }

  const latestCycle = latestCompleteReviewCycle(context);
  if (latestCycle !== undefined) {
    candidates.push(reviewARef(latestCycle), reviewBRef(latestCycle));
  }

  candidates.push("readiness", "verification");

  const paths = candidates
    .filter((artifact) => artifactExists(context, artifact))
    .map((artifact) => artifactRelativePath(context, artifact));

  return paths;
}

export async function writePrNarrativeArtifact(context: WorkflowContext): Promise<FormatPrBodyNarrative> {
  const narrative = buildPrNarrativeFromWorkflowArtifacts(context);
  await writeArtifact(context, "prNarrative", formatPrNarrativeArtifact(narrative));
  return narrative;
}

function buildPrNarrativeFromWorkflowArtifacts(context: WorkflowContext): FormatPrBodyNarrative {
  const issueMarkdown = readArtifactTextIfExists(context, "issue");
  const plan = readImplementationPlanIfExists(context);
  const changeReports = readWorkflowChangeReports(context);

  const issueTitle = issueMarkdown ? extractIssueTitle(issueMarkdown) : undefined;
  const workClassification = plan?.workClassification;
  const goal = plan?.goal ? [plan.goal] : [];
  const currentFindings = plan?.currentCodeFindings.slice(0, 4) ?? [];
  const proposedChanges = plan?.proposedChanges.slice(0, 8) ?? [];
  const nonGoals = plan?.nonGoals.slice(0, 4) ?? [];
  const risks = plan?.risks.slice(0, 4) ?? [];
  const implementationSummary = compactItems(changeReports.map((report) => report.summary)).slice(0, 4);
  const changedFiles = compactItems(changeReports.flatMap((report) => report.changedFiles.map((file) => file.path))).slice(0, 20);

  const summary = buildSummary({ issueTitle, currentFindings, implementationSummary, proposedChanges, goal });
  const beforeFindings = selectReviewerBeforeItems(currentFindings);
  const before = compactItems([
    ...beforeFindings,
    ...(beforeFindings.length === 0 && issueTitle ? [`The source issue reported: ${issueTitle}.`] : []),
  ]);
  const after = compactItems([
    ...implementationSummary,
    ...(implementationSummary.length === 0 ? proposedChanges : []),
  ]);
  const rootCause = compactItems(beforeFindings.length > 0 ? beforeFindings : currentFindings.slice(0, 1));
  const fix = compactItems([...implementationSummary, ...(implementationSummary.length === 0 ? proposedChanges : [])]);
  const acceptanceCriteria = buildAcceptanceCriteria(goal, proposedChanges, implementationSummary);
  const reviewPath = compactItems([
    changedFiles.length > 0 ? `Start with ${changedFiles.slice(0, 4).map((file) => `\`${file}\``).join(", ")} to verify the core change.` : undefined,
    goal[0] ? `Confirm the behavior satisfies the issue goal: ${goal[0]}` : undefined,
    nonGoals.length > 0 ? `Confirm scope stayed inside the important non-changes: ${nonGoals.join("; ")}.` : undefined,
    "Check the verification result and any edge cases listed below.",
  ]);
  const verificationNotes = buildVerificationNotes(changedFiles, changeReports);

  return {
    issueTitle,
    workClassification,
    summary,
    before,
    after,
    rootCause,
    fix,
    acceptanceCriteria,
    reviewPath,
    filesChanged: categorizeChangedFiles(changedFiles),
    importantNonChanges: nonGoals,
    verificationNotes,
    manualVerification: [],
    risks: risks.length > 0 ? risks : [],
    edgeCases: [],
    reviewerQuestions: [],
  };
}

function formatPrNarrativeArtifact(narrative: FormatPrBodyNarrative): string {
  const filesChanged = narrative.filesChanged ?? emptyFilesChanged();
  const lines = [
    "# PR Narrative",
    "",
    "## Issue Title",
    narrative.issueTitle ?? "Not recorded.",
    "",
    "## Work Classification",
    narrative.workClassification ?? "unknown",
    "",
    "## Summary",
    narrative.summary ?? "Not recorded.",
    "",
    ...markdownBulletSection("Before", narrative.before),
    "",
    ...markdownBulletSection("After", narrative.after),
    "",
    ...markdownBulletSection("Root Cause", narrative.rootCause),
    "",
    ...markdownBulletSection("Fix", narrative.fix),
    "",
    ...markdownChecklistSection("Acceptance Criteria", narrative.acceptanceCriteria),
    "",
    ...markdownNumberedSection("Suggested Review Path", narrative.reviewPath),
    "",
    ...markdownBulletSection("Files Changed: Primary Output", filesChanged.behavior),
    "",
    ...markdownBulletSection("Files Changed: Validation", filesChanged.tests),
    "",
    ...markdownBulletSection("Files Changed: Plumbing", filesChanged.plumbing),
    "",
    ...markdownBulletSection("Files Changed: Docs", filesChanged.docs),
    "",
    ...markdownBulletSection("Files Changed: Other", filesChanged.other),
    "",
    ...markdownBulletSection("Important Non-Changes", narrative.importantNonChanges),
    "",
    ...markdownBulletSection("Verification Notes", narrative.verificationNotes),
    "",
    ...markdownNumberedSection("Manual Verification", narrative.manualVerification),
    "",
    ...markdownBulletSection("Risks", narrative.risks),
    "",
    ...markdownBulletSection("Edge Cases To Review", narrative.edgeCases),
    "",
    ...markdownBulletSection("Reviewer Questions", narrative.reviewerQuestions),
  ];
  return `${lines.join("\n").trimEnd()}\n`;
}

function buildSummary(input: {
  issueTitle?: string | undefined;
  currentFindings: string[];
  implementationSummary: string[];
  proposedChanges: string[];
  goal: string[];
}): string | undefined {
  const primaryChange = input.implementationSummary[0] ?? input.proposedChanges[0] ?? input.goal[0];
  const before = selectReviewerBeforeItems(input.currentFindings)[0];
  if (!primaryChange) return input.issueTitle ? normalizePrItem(`This PR addresses ${ensureSentence(input.issueTitle)}`) : undefined;
  const sentences = [`This PR ${pastTenseForSummary(primaryChange)}`];
  if (before) sentences.push(`Previously, ${lowercaseFirst(ensureSentence(before))}`);
  return normalizePrItem(sentences.join(" "));
}

function selectReviewerBeforeItems(items: string[]): string[] {
  const meaningful = items.filter((item) => /\b(no|not|missing|without|lacked|lacks|absent|did not|does not|was not|were not)\b/i.test(item));
  return (meaningful.length > 0 ? meaningful : items).filter((item) => !isImplementationTrivia(item)).slice(0, 3);
}

function isImplementationTrivia(item: string): boolean {
  return /\b(public\/ exists|Next serves|middleware matcher|proxy\.ts|lib\/public-site-paths|matcher excludes)\b/i.test(item);
}

function buildAcceptanceCriteria(goal: string[], proposedChanges: string[], implementationSummary: string[]): string[] {
  const raw = compactItems([...goal, ...proposedChanges, ...implementationSummary]);
  const criteria: string[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const item = raw[index] ?? "";
    if (/including:\s*$/i.test(item)) {
      const details: string[] = [];
      for (let detailIndex = index + 1; detailIndex < raw.length && details.length < 5; detailIndex += 1) {
        const detail = raw[detailIndex] ?? "";
        if (isFragmentDetail(detail)) {
          details.push(detail.replace(/[.!]$/, ""));
          index = detailIndex;
          continue;
        }
        break;
      }
      criteria.push(details.length > 0 ? `${item.replace(/:\s*$/, "")}: ${details.join(", ")}.` : item.replace(/:\s*$/, "."));
      continue;
    }
    if (isFragmentDetail(item) && criteria.length > 0) continue;
    criteria.push(item);
  }
  return compactItems(criteria).slice(0, 5);
}

function isFragmentDetail(item: string): boolean {
  return item.length <= 80 && !/[.!?]$/.test(item) && !/^\w+\s+(?:the|a|an|to|for|with|from|in|on)\b/i.test(item);
}

function buildVerificationNotes(changedFiles: string[], reports: readonly ChangeReport[]): string[] {
  const reportedValidation = compactItems(reports.flatMap((report) => report.validation.map((entry) =>
    `\`${entry.command}\` — ${entry.status}: ${entry.details}`,
  ))).slice(0, 8);
  const validationFiles = changedFiles.filter((file) => /(^scripts\/|check|test|spec)/i.test(file));
  return compactItems([
    ...reportedValidation,
    validationFiles.length > 0
      ? `Validation updates cover ${validationFiles.map((file) => `\`${file}\``).join(", ")}.`
      : undefined,
  ]);
}

function pastTenseForSummary(value: string): string {
  const sentence = ensureSentence(value);
  if (/^(added|updated|changed|removed|fixed|published|created)\b/i.test(sentence)) return lowercaseFirst(sentence);
  return `implements ${lowercaseFirst(sentence)}`;
}

function categorizeChangedFiles(files: string[]): FormatPrBodyNarrativeFilesChanged {
  const categorized = emptyFilesChanged();
  for (const file of files) {
    if (/(__tests__|\.test\.|\.spec\.|^scripts\/|check)/i.test(file)) categorized.tests.push(file);
    else if (/^public\//i.test(file)) categorized.behavior.push(file);
    else if (/\.(md|mdx|txt)$/i.test(file)) categorized.docs.push(file);
    else if (/^(app|pages|routes|src\/app|lib\/cli|lib\/autorun|lib\/workflow)\//.test(file)) categorized.plumbing.push(file);
    else if (/^(components|lib|src|server|api)\//.test(file)) categorized.behavior.push(file);
    else categorized.other.push(file);
  }
  return categorized;
}

function emptyFilesChanged(): FormatPrBodyNarrativeFilesChanged {
  return { behavior: [], tests: [], plumbing: [], docs: [], other: [] };
}

function markdownBulletSection(heading: string, items: string[] | undefined): string[] {
  const values = nonEmptyItems(items);
  return [`## ${heading}`, ...(values.length > 0 ? values.map((item) => `- ${item}`) : ["None."])];
}

function markdownChecklistSection(heading: string, items: string[] | undefined): string[] {
  const values = nonEmptyItems(items);
  return [`## ${heading}`, ...(values.length > 0 ? values.map((item) => `- [x] ${stripCheckboxMarker(item)}`) : ["None."])];
}

function markdownNumberedSection(heading: string, items: string[] | undefined): string[] {
  const values = nonEmptyItems(items);
  return [`## ${heading}`, ...(values.length > 0 ? values.map((item, index) => `${index + 1}. ${item}`) : ["None."])];
}

function lowercaseFirst(value: string): string {
  if (value.length === 0) return value;
  return `${value.charAt(0).toLocaleLowerCase()}${value.slice(1)}`;
}

function ensureSentence(value: string): string {
  const trimmed = value.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function readArtifactTextIfExists(context: WorkflowContext, artifact: ArtifactRef): string | undefined {
  if (!artifactExists(context, artifact)) return undefined;
  try {
    return readFileSync(artifactPath(context, artifact), "utf8");
  } catch {
    return undefined;
  }
}

function readImplementationPlanIfExists(context: WorkflowContext) {
  const content = readArtifactTextIfExists(context, "implementationPlan");
  if (!content) return undefined;
  try {
    return parseImplementationPlanResultJson(content);
  } catch {
    return undefined;
  }
}

function readChangeReportIfExists(context: WorkflowContext, artifact: ArtifactRef) {
  const content = readArtifactTextIfExists(context, artifact);
  if (!content) return undefined;
  try {
    return parseChangeReportJson(content);
  } catch {
    return undefined;
  }
}

function readWorkflowChangeReports(context: WorkflowContext): ChangeReport[] {
  const reports: ChangeReport[] = [];
  const implementation = readChangeReportIfExists(context, "implementationLog");
  if (implementation) reports.push(implementation);
  for (let pass = 0; pass <= context.maxFixPasses; pass++) {
    if (pass > 0) {
      const fix = readChangeReportIfExists(context, fixLogRef(pass));
      if (fix) reports.push(fix);
    }
    const refinement = readChangeReportIfExists(context, refinementLogRef(pass));
    if (refinement) reports.push(refinement);
  }
  return reports;
}

function extractIssueTitle(markdown: string): string | undefined {
  const xmlTitle = /<title>([\s\S]*?)<\/title>/i.exec(markdown)?.[1];
  const title = xmlTitle !== undefined
    ? decodeXmlText(xmlTitle.trim())
    : /^#\s+GitHub Issue\s+#\d+(?:\s*[-:]\s*(.+))?\s*$/im.exec(markdown)?.[1]?.trim();
  return normalizePrItem(title);
}

function compactItems(items: readonly (string | undefined)[]): string[] {
  const seen = new Set<string>();
  const compacted: string[] = [];
  for (const item of items) {
    const normalized = normalizePrItem(item);
    if (!normalized) continue;
    const key = normalized.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    compacted.push(normalized);
  }
  return compacted;
}

function normalizePrItem(item: string | undefined): string | undefined {
  if (!item) return undefined;
  const normalized = sanitizePublicMarkdown(item)
    .replace(/`{3,}/g, "`")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized || isNoneItem(normalized)) return undefined;
  return normalized.length > 360 ? `${normalized.slice(0, 357).trimEnd()}...` : normalized;
}

function decodeXmlText(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal: string) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

export async function hasUncommittedChanges(options: { cwd: string }): Promise<boolean> {
  const result = await runProcess(["git", "status", "--porcelain", "--", ".", ":(exclude).roark"], { cwd: options.cwd });
  if (result.exitCode !== 0) {
    throw new Error(
      `git status --porcelain failed with exit code ${result.exitCode}:\n${result.stderr || result.stdout}`,
    );
  }
  return result.stdout.trim() !== "";
}

export async function publishAutorunResult(input: PublishAutorunResultInput): Promise<string | undefined> {
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
    () => performAutorunPublication(input, display),
    (prUrl) => ({ outcome: prUrl ? `published ${prUrl}` : "published" }),
  );
}

async function performAutorunPublication(input: PublishAutorunResultInput, display: AgentDisplayContext): Promise<string | undefined> {
  const { options, issue, branchPlan, workflowContext, verification, attemptMetadata, attemptMetadataPath, agentRunner = runPiAgent } = input;
  const agentCwd = workflowContext.agentCwd;
  const controlCwd = workflowContext.controlCwd;

  presenter().line(`Publishing issue #${issue.number}`);

  if (await hasUncommittedChanges({ cwd: agentCwd })) {
    presenter().line("Committing worktree changes");
    await runProcessOrThrow(buildStageAllArgv(), { cwd: agentCwd, label: "git add -A" });
    await runProcess(["git", "reset", "-q", "--", ".roark"], { cwd: agentCwd });
    await runProcessOrThrow(
      buildCommitArgv({ message: formatCommitMessage({ issueNumber: issue.number }) }),
      { cwd: agentCwd, label: "git commit" },
    );
  } else {
    presenter().line("No uncommitted changes; skipping commit");
  }

  presenter().line(`Pushing ${branchPlan.branchName} to ${options.remote}`);
  await runProcessOrThrow(
    buildPushArgv({ remote: options.remote, branchName: branchPlan.branchName }),
    { cwd: agentCwd, label: `git push ${options.remote}` },
  );

  await writePrNarrativeArtifact(workflowContext);

  presenter().line("Authoring and creating pull request");
  const publishedPr = await authorAndPublishPullRequest({
    options,
    issue,
    branchPlan,
    workflowContext,
    verification,
    attemptMetadata,
    attemptMetadataPath,
    agentRunner,
  }, display);
  const prUrl = publishedPr.url;
  if (prUrl) presenter().line(`PR: ${prUrl}`);

  const removeLabels = labelsToRemoveForAutorunTransition({
    issueLabels: issue.labels,
    workflow: options,
    nextLabel: options.successLabel,
    knownPresent: [options.inProgressLabel, options.failureLabel],
  });
  try {
    await runProcessOrThrow(
      buildSuccessLabelArgv({
        repo: options.repo,
        issueNumber: issue.number,
        label: options.successLabel,
        removeLabels,
      }),
      { cwd: controlCwd, label: "gh issue edit --transition-label (success)" },
    );
  } catch (error) {
    presenter().warning(
      `WARNING failed to apply success label '${options.successLabel}': ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return prUrl === "" ? undefined : prUrl;
}

interface PublishedPullRequest {
  url: string;
  title?: string | undefined;
  number?: number | undefined;
  stdout?: string | undefined;
}

async function authorAndPublishPullRequest(
  input: PublishAutorunResultInput & { agentRunner: AgentRunner },
  display: AgentDisplayContext,
): Promise<PublishedPullRequest> {
  const renderingContext = prDraftRenderingContext({
    workflowContext: input.workflowContext,
    issueNumber: input.issue.number,
    verification: input.verification,
    attemptMetadata: input.attemptMetadata,
  });
  const artifact = await runStructuredArtifact({
    cwd: input.workflowContext.controlCwd,
    model: effectiveModelForStage(input.workflowContext.model, "issuePublishing"),
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
      artifactPaths: collectPrBodyArtifactPaths(input.workflowContext),
    }),
    fileEditingToolsEnabled: false,
    observer: input.workflowContext.observer,
    display,
  }, input.agentRunner, prDraftArtifactDefinition({
    renderingContext,
    localRoots: [input.workflowContext.controlCwd, input.workflowContext.agentCwd],
  }), {
    writeJson: (content) => writeArtifact(input.workflowContext, "prDraft", content),
    writeMarkdown: (content) => writeArtifact(input.workflowContext, "prDraftMarkdown", content),
  });
  const draft = artifact.value;
  const body = artifact.markdown;
  const title = sanitizePublicMarkdown(draft.title, { localRoots: [input.workflowContext.controlCwd, input.workflowContext.agentCwd] });

  const stdout = await runProcessOrThrow(buildPrCreateArgv({
    repo: input.options.repo,
    baseBranch: input.options.baseBranch,
    branchName: input.branchPlan.branchName,
    title,
  }), {
    cwd: input.workflowContext.controlCwd,
    label: "gh pr create",
    input: body,
  });
  const url = extractPrUrl(stdout);
  if (!url) throw new Error("gh pr create succeeded but did not return a pull request URL.");
  return { url, title, ...(extractIssueNumber(url) !== undefined ? { number: extractIssueNumber(url) } : {}), stdout };
}

export async function updatePrBody(input: {
  cwd: string;
  repo?: string | undefined;
  pr: string;
  issueNumber: number;
  workflowContext: WorkflowContext;
  verification?: VerificationResult | undefined;
  attemptMetadata?: AttemptMetadata | undefined;
  followUpIssues?: FormatPrBodyFollowUpIssue[] | undefined;
}): Promise<void> {
  const display: AgentDisplayContext = {
    command: input.workflowContext.displayCommand ?? "auto",
    repository: input.repo,
    target: `#${input.issueNumber}`,
    phaseId: "pr-body-update",
    phaseLabel: "Update PR body",
    operation: "publish",
  };
  await runPresentedPhase(display, async () => {
    const draft = parsePrDraftJson(readFileSync(artifactPath(input.workflowContext, "prDraft"), "utf8"));
    const body = sanitizePublicMarkdown(formatPrDraftMarkdown(draft, prDraftRenderingContext({
      workflowContext: input.workflowContext,
      issueNumber: input.issueNumber,
      followUpIssues: input.followUpIssues,
      verification: input.verification,
      attemptMetadata: input.attemptMetadata,
    })), { localRoots: [input.workflowContext.controlCwd, input.workflowContext.agentCwd] });
    const title = sanitizePublicMarkdown(draft.title, { localRoots: [input.workflowContext.controlCwd, input.workflowContext.agentCwd] });
    await writeArtifact(input.workflowContext, "prDraftMarkdown", body);
    await runProcessOrThrow([
      "gh", "pr", "edit", input.pr,
      "--title", title,
      "--body-file", "-",
      ...(input.repo ? ["--repo", input.repo] : []),
    ], { cwd: input.cwd, label: "gh pr edit", input: body });
  }, () => ({ outcome: "updated" }));
}

export function buildPrCreateArgv(input: { repo?: string | undefined; baseBranch: string; branchName: string; title: string }): string[] {
  return [
    "gh", "pr", "create",
    "--base", input.baseBranch,
    "--head", input.branchName,
    "--title", input.title,
    "--body-file", "-",
    ...(input.repo ? ["--repo", input.repo] : []),
  ];
}

function prDraftRenderingContext(input: {
  workflowContext: WorkflowContext;
  issueNumber: number;
  followUpIssues?: readonly FormatPrBodyFollowUpIssue[] | undefined;
  verification?: VerificationResult | undefined;
  attemptMetadata?: AttemptMetadata | undefined;
}): PrDraftRenderingContext {
  return {
    sourceIssueNumber: input.issueNumber,
    followUpIssues: input.followUpIssues,
    runDirectory: input.workflowContext.runDirRelative,
    artifactPaths: collectPrBodyArtifactPaths(input.workflowContext),
    ...(input.attemptMetadata ? {
      attemptSummary: `${input.attemptMetadata.attempt}; branch ${input.attemptMetadata.branch}`,
    } : {}),
    ...(input.verification ? {
      verificationSummary: `${input.verification.ok ? "passed" : "failed"}: ${input.verification.command} (exit ${input.verification.exitCode})`,
    } : {}),
  };
}

function extractPrUrl(stdout: string): string | undefined {
  return /https?:\/\/\S+\/pull\/\d+/.exec(stdout)?.[0]?.replace(/[),.;]+$/, "");
}

function extractIssueNumber(url: string): number | undefined {
  const value = Number.parseInt(/\/pull\/(\d+)/.exec(url)?.[1] ?? "", 10);
  return Number.isInteger(value) ? value : undefined;
}
