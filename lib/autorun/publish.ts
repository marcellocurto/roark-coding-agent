import type { AutoCliOptions } from "../cli/args.ts";
import { readFileSync } from "node:fs";
import { runProcess, runProcessOrThrow } from "../cli/process.ts";
import { runPiAgent } from "../pi/agent.ts";
import { prBodyUpdatePrompt, prCreatePrompt, prPublishingSystemPrompt } from "../prompts/pr-publishing-prompt.ts";
import type { AgentRunner } from "../workflow/agent-runner.ts";
import { effectiveModelForStage } from "../workflow/model-routing.ts";
import { buildRemoveLabelArgv } from "./failure.ts";
import {
  artifactExists,
  artifactPath,
  artifactRelativePath,
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

export const defaultAutorunSuccessLabel = "roark-pr-opened";
export const defaultAutorunRemote = "origin";

export interface CommitArgvOptions { message: string }
export interface PushArgvOptions { remote: string; branchName: string }
export interface SuccessLabelArgvOptions {
  repo?: string | undefined  ;
  issueNumber: number;
  label: string;
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
>;

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
  return ["gh", "issue", "edit", String(options.issueNumber), "--add-label", options.label, ...repoArgs];
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
  const planMarkdown = readArtifactTextIfExists(context, "implementationPlan");
  const implementationMarkdown = readArtifactTextIfExists(context, "implementationLog");

  const issueTitle = issueMarkdown ? extractIssueTitle(issueMarkdown) : undefined;
  const workClassification = firstItem(summarizeMarkdownSection(planMarkdown, "Work Classification", 1));
  const goal = summarizeMarkdownSection(planMarkdown, "Goal", 2);
  const currentFindings = summarizeMarkdownSection(planMarkdown, "Current Code Findings", 4);
  const proposedChanges = summarizeMarkdownSection(planMarkdown, "Proposed Changes", 8);
  const nonGoals = summarizeMarkdownSection(planMarkdown, "Non-Goals", 4);
  const risks = summarizeMarkdownSection(planMarkdown, "Risks", 4);
  const implementationSummary = summarizeMarkdownSection(implementationMarkdown, "Summary", 4);
  const changedFiles = summarizeMarkdownSection(implementationMarkdown, "Changed Files", 20).map(extractFileReference);

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
  const verificationNotes = buildVerificationNotes(changedFiles);

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

function buildVerificationNotes(changedFiles: string[]): string[] {
  const validationFiles = changedFiles.filter((file) => /(^scripts\/|check|test|spec)/i.test(file));
  if (validationFiles.length === 0) return [];
  return [`Validation updates cover ${validationFiles.map((file) => `\`${file}\``).join(", ")}.`];
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

function firstItem(items: string[]): string | undefined {
  return items[0];
}

function extractFileReference(value: string): string {
  const codePath = /`([^`]+)`/.exec(value)?.[1];
  if (codePath) return codePath.trim();
  return value
    .replace(/^`(.+)`$/, "$1")
    .split(/\s+[—–-]\s+|:\s+/)[0]
    ?.trim() ?? value.trim();
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

function extractIssueTitle(markdown: string): string | undefined {
  const xmlTitle = /<title>([\s\S]*?)<\/title>/i.exec(markdown)?.[1];
  const title = xmlTitle !== undefined
    ? decodeXmlText(xmlTitle.trim())
    : /^#\s+GitHub Issue\s+#\d+(?:\s*[-:]\s*(.+))?\s*$/im.exec(markdown)?.[1]?.trim();
  return normalizePrItem(title);
}

function summarizeMarkdownSection(markdown: string | undefined, heading: string, maxItems: number): string[] {
  if (!markdown) return [];
  const section = extractMarkdownSection(markdown, heading);
  if (!section) return [];
  const bulletItems = section
    .split(/\r?\n/)
    .map((line) => stripMarkdownListMarker(line.trim()))
    .filter((line) => line !== undefined);
  const rawItems = bulletItems.length > 0
    ? bulletItems
    : section
      .split(/\n\s*\n/)
      .map((paragraph) => paragraph.replace(/\s*\r?\n\s*/g, " ").trim());
  return compactItems(rawItems).slice(0, maxItems);
}

function extractMarkdownSection(markdown: string, heading: string): string | undefined {
  const lines = markdown.split(/\r?\n/);
  const headingPattern = new RegExp(`^##\\s+${escapeRegExp(heading)}\\s*$`, "i");
  const start = lines.findIndex((line) => headingPattern.test(line.trim()));
  if (start === -1) return undefined;
  const endOffset = lines.slice(start + 1).findIndex((line) => /^##\s+\S/.test(line.trim()));
  const end = endOffset === -1 ? lines.length : start + 1 + endOffset;
  return lines.slice(start + 1, end).join("\n").trim();
}

function stripMarkdownListMarker(line: string): string | undefined {
  const match = /^(?:[-*+]\s+|\d+[.)]\s+)(.+)$/.exec(line);
  return match?.[1]?.trim();
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
  const { options, issue, branchPlan, workflowContext, verification, attemptMetadata, attemptMetadataPath, agentRunner = runPiAgent } = input;
  const agentCwd = workflowContext.agentCwd;
  const controlCwd = workflowContext.controlCwd;

  console.log(`\n=== Publish #${issue.number} ===`);

  if (await hasUncommittedChanges({ cwd: agentCwd })) {
    console.log("- Committing worktree changes");
    await runProcessOrThrow(buildStageAllArgv(), { cwd: agentCwd, label: "git add -A" });
    await runProcess(["git", "reset", "-q", "--", ".roark"], { cwd: agentCwd });
    await runProcessOrThrow(
      buildCommitArgv({ message: formatCommitMessage({ issueNumber: issue.number }) }),
      { cwd: agentCwd, label: "git commit" },
    );
  } else {
    console.log("- No uncommitted changes; skipping commit.");
  }

  console.log(`- Pushing ${branchPlan.branchName} to ${options.remote}`);
  await runProcessOrThrow(
    buildPushArgv({ remote: options.remote, branchName: branchPlan.branchName }),
    { cwd: agentCwd, label: `git push ${options.remote}` },
  );

  await writePrNarrativeArtifact(workflowContext);

  console.log("- Authoring and creating pull request");
  const publishedPr = await publishPullRequestWithAgent({
    options,
    issue,
    branchPlan,
    workflowContext,
    verification,
    attemptMetadata,
    attemptMetadataPath,
    agentRunner,
  });
  const prUrl = publishedPr.url;
  if (prUrl) console.log(`- PR: ${prUrl}`);

  try {
    await runProcessOrThrow(
      buildSuccessLabelArgv({ repo: options.repo, issueNumber: issue.number, label: options.successLabel }),
      { cwd: controlCwd, label: "gh issue edit --add-label (success)" },
    );
  } catch (error) {
    console.warn(
      `Failed to apply success label '${options.successLabel}': ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  for (const label of [options.inProgressLabel, options.failureLabel].filter((label) => label !== options.successLabel)) {
    try {
      await runProcessOrThrow(
        buildRemoveLabelArgv({ repo: options.repo, issueNumber: issue.number, label }),
        { cwd: controlCwd, label: "gh issue edit --remove-label (success cleanup)" },
      );
    } catch (error) {
      console.warn(
        `Failed to remove label '${label}': ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return prUrl === "" ? undefined : prUrl;
}

interface PublishedPullRequest {
  url: string;
  title?: string | undefined;
  number?: number | undefined;
  stdout?: string | undefined;
}

async function publishPullRequestWithAgent(input: PublishAutorunResultInput & { agentRunner: AgentRunner }): Promise<PublishedPullRequest> {
  const output = await input.agentRunner({
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
    phase: "pr-publishing",
  });
  const parsed = parsePrPublishingAgentResponse(output);
  if (!parsed.url) throw new Error("PR publishing agent response did not include a non-empty url.");
  return parsed;
}

export async function updatePrBodyWithAgent(input: {
  cwd: string;
  repo?: string | undefined;
  pr: string;
  issueNumber: number;
  issueTitle: string;
  issueUrl?: string | undefined;
  workflowContext: WorkflowContext;
  verification?: VerificationResult | undefined;
  attemptMetadata?: AttemptMetadata | undefined;
  attemptMetadataPath?: string | undefined;
  followUpIssues?: FormatPrBodyFollowUpIssue[] | undefined;
  agentRunner?: AgentRunner | undefined;
}): Promise<void> {
  const agentRunner = input.agentRunner ?? runPiAgent;
  const output = await agentRunner({
    cwd: input.cwd,
    model: effectiveModelForStage(input.workflowContext.model, "issuePublishing"),
    thinkingLevel: input.workflowContext.thinkingConfig.issuePublishing,
    systemPrompt: prPublishingSystemPrompt(),
    prompt: prBodyUpdatePrompt({
      context: input.workflowContext,
      repo: input.repo,
      sourceIssue: { number: input.issueNumber, title: input.issueTitle, ...(input.issueUrl ? { url: input.issueUrl } : {}) },
      branchName: input.attemptMetadata?.branch ?? `issue-${input.issueNumber}`,
      baseBranch: input.attemptMetadata?.baseBranch ?? "unknown",
      prUrl: input.pr,
      verification: input.verification,
      attemptMetadata: input.attemptMetadata,
      attemptMetadataPath: input.attemptMetadataPath,
      followUpIssues: input.followUpIssues,
      artifactPaths: collectPrBodyArtifactPaths(input.workflowContext),
    }),
    fileEditingToolsEnabled: false,
    observer: input.workflowContext.observer,
    phase: "pr-body-update",
  });
  const result = parsePrBodyUpdateAgentResponse(output);
  if (!result.updated) throw new Error(result.message ?? "PR body update agent did not report a successful update.");
}

function parsePrPublishingAgentResponse(output: string): PublishedPullRequest {
  const parsed = parseAgentJson(output);
  const url = asNonEmptyString(parsed["url"]);
  const number = asInteger(parsed["number"]);
  return {
    ...(url ? { url } : { url: "" }),
    ...(asNonEmptyString(parsed["title"]) ? { title: asNonEmptyString(parsed["title"]) } : {}),
    ...(number !== undefined ? { number } : {}),
    ...(asNonEmptyString(parsed["stdout"]) ? { stdout: asNonEmptyString(parsed["stdout"]) } : {}),
  };
}

function parsePrBodyUpdateAgentResponse(output: string): { updated: boolean; message?: string | undefined } {
  const parsed = parseAgentJson(output);
  return {
    updated: parsed["updated"] === true,
    ...(asNonEmptyString(parsed["message"]) ? { message: asNonEmptyString(parsed["message"]) } : {}),
  };
}

function parseAgentJson(output: string): Record<string, unknown> {
  const trimmed = output.trim();
  const jsonText = trimmed.startsWith("```") ? extractFencedJson(trimmed) : trimmed;
  const parsed = JSON.parse(jsonText) as unknown;
  if (!isRecord(parsed)) throw new Error("Agent response was not a JSON object.");
  return parsed;
}

function extractFencedJson(output: string): string {
  const match = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(output);
  if (!match?.[1]) throw new Error("Agent response was fenced but did not contain JSON.");
  return match[1];
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function asInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
