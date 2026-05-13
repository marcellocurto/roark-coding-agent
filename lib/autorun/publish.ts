import type { AutoCliOptions } from "../cli/args.ts";
import { readFileSync } from "node:fs";
import { runProcess, runProcessOrThrow } from "../cli/process.ts";
import { buildRemoveLabelArgv } from "./failure.ts";
import {
  artifactExists,
  artifactPath,
  artifactRelativePath,
  finalReviewRef,
  latestCompleteReviewCycle,
  latestFinalReviewPass,
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
import { parseReadyForImplementationValue, parseVerdict } from "../workflow/verdicts.ts";
import { sanitizePublicMarkdown } from "./public-output.ts";

export const defaultAutorunSuccessLabel = "roark-pr-opened";
export const defaultAutorunRemote = "origin";

export interface CommitArgvOptions { message: string }
export interface PushArgvOptions { remote: string; branchName: string }
export interface PrCreateArgvOptions {
  repo?: string | undefined  ;
  baseBranch: string;
  branchName: string;
  title: string;
  body: string;
}
export interface PrEditBodyArgvOptions {
  repo?: string | undefined;
  pr: string;
  body: string;
}
export interface SuccessLabelArgvOptions {
  repo?: string | undefined  ;
  issueNumber: number;
  label: string;
}

export interface ReviewVerdictSummary {
  reviewA?: string | undefined;
  reviewB?: string | undefined;
}

export interface FormatPrBodyLedgerComment {
  title: string;
  phase: string;
  url?: string | undefined;
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

export interface FormatPrBodyInput {
  issueNumber: number;
  verification?: VerificationResult | undefined;
  runDirRelative: string;
  artifactPaths: string[];
  attemptMetadata?: AttemptMetadata | undefined;
  attemptMetadataPath?: string | undefined;
  reviewVerdicts?: ReviewVerdictSummary | undefined;
  triageVerdict?: string | undefined;
  planReady?: string | undefined;
  readinessStatus?: string | undefined;
  ledgerComments?: FormatPrBodyLedgerComment[] | undefined;
  followUpIssues?: FormatPrBodyFollowUpIssue[] | undefined;
  narrative?: FormatPrBodyNarrative | undefined;
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

export function buildPrCreateArgv(options: PrCreateArgvOptions): string[] {
  const repoArgs = options.repo ? ["--repo", options.repo] : [];
  return [
    "gh",
    "pr",
    "create",
    "--base",
    options.baseBranch,
    "--head",
    options.branchName,
    "--title",
    options.title,
    "--body",
    options.body,
    ...repoArgs,
  ];
}

export function buildPrEditBodyArgv(options: PrEditBodyArgvOptions): string[] {
  const repoArgs = options.repo ? ["--repo", options.repo] : [];
  return ["gh", "pr", "edit", options.pr, "--body", options.body, ...repoArgs];
}

export function buildSuccessLabelArgv(options: SuccessLabelArgvOptions): string[] {
  const repoArgs = options.repo ? ["--repo", options.repo] : [];
  return ["gh", "issue", "edit", String(options.issueNumber), "--add-label", options.label, ...repoArgs];
}

export function formatCommitMessage(input: { issueNumber: number }): string {
  return `roark: implement issue #${input.issueNumber}`;
}

export function formatAutorunPrBody(input: {
  issueNumber: number;
  workflowContext: WorkflowContext;
  verification?: VerificationResult | undefined;
  attemptMetadata?: AttemptMetadata | undefined;
  attemptMetadataPath?: string | undefined;
  followUpIssues?: FormatPrBodyFollowUpIssue[] | undefined;
}): string {
  return formatPrBody({
    issueNumber: input.issueNumber,
    verification: input.verification,
    runDirRelative: input.workflowContext.runDirRelative,
    artifactPaths: collectPrBodyArtifactPaths(input.workflowContext),
    attemptMetadata: input.attemptMetadata,
    attemptMetadataPath: input.attemptMetadataPath,
    reviewVerdicts: collectReviewVerdicts(input.workflowContext),
    triageVerdict: collectArtifactVerdict(input.workflowContext, "triage"),
    planReady: collectPlanReady(input.workflowContext),
    readinessStatus: collectArtifactVerdict(input.workflowContext, "readiness"),
    ledgerComments: collectLedgerCommentSummaries(input.attemptMetadata, input.workflowContext),
    followUpIssues: input.followUpIssues,
    narrative: collectPrBodyNarrative(input.workflowContext),
  });
}

export function formatPrBody(input: FormatPrBodyInput): string {
  const lines: string[] = [];
  const narrative = input.narrative;
  lines.push(`Closes #${input.issueNumber}`);
  lines.push("");
  lines.push(narrative?.summary ?? `This PR addresses #${input.issueNumber}. The available workflow artifacts did not include a fuller reviewer narrative.`);
  lines.push("");
  appendBeforeAfterSection(lines, narrative, input.issueNumber);
  lines.push("");
  appendBulletSection(lines, "## Root cause / Fix", [
    ...prefixedItems("Root cause", narrative?.rootCause),
    ...prefixedItems("Fix", narrative?.fix),
  ], [
    "Root cause: not recorded in the PR narrative artifact.",
    "Fix: review the implementation log artifact to confirm the change.",
  ]);
  lines.push("");
  appendChecklistSection(lines, "## Acceptance criteria", narrative?.acceptanceCriteria, [
    `Implementation satisfies the source issue #${input.issueNumber}.`,
    "Verification completed as recorded below.",
  ]);
  lines.push("");
  appendOrderedSection(lines, "## Suggested review path", narrative?.reviewPath, [
    `Confirm the implementation matches the scope of #${input.issueNumber}.`,
    "Review verification notes below and inspect the listed workflow artifacts if more context is needed.",
  ]);
  lines.push("");
  appendFilesChangedSection(lines, narrative?.filesChanged);
  lines.push("");
  appendBulletSection(lines, "## Important non-changes", narrative?.importantNonChanges, [
    "No explicit non-goals were recorded in the PR narrative artifact.",
  ]);
  lines.push("");
  lines.push("## Verification");
  if (input.verification) {
    lines.push(`- \`${sanitizePublicMarkdown(input.verification.command)}\` — ${input.verification.ok ? "passed" : "failed"}`);
    lines.push(`  - Exit code: ${input.verification.exitCode}`);
  } else {
    lines.push("- Not run.");
  }
  for (const note of nonEmptyItems(narrative?.verificationNotes)) lines.push(`- ${note}`);
  lines.push("");
  const manualVerification = nonEmptyItems(narrative?.manualVerification);
  if (manualVerification.length > 0) {
    appendOrderedSection(lines, "## Manual verification", manualVerification, []);
    lines.push("");
  }
  lines.push("## Risk");
  const risks = nonEmptyItems(narrative?.risks);
  if (risks.length > 0) for (const risk of risks) lines.push(`- ${risk}`);
  else lines.push("- No specific risks were recorded in the PR narrative artifact.");
  const edgeCases = nonEmptyItems(narrative?.edgeCases);
  if (edgeCases.length > 0) {
    lines.push("- Edge cases to review:");
    for (const edgeCase of edgeCases) lines.push(`  - ${edgeCase}`);
  }
  const reviewerQuestions = nonEmptyItems(narrative?.reviewerQuestions);
  if (reviewerQuestions.length > 0) {
    lines.push("");
    appendBulletSection(lines, "## Reviewer questions", reviewerQuestions, []);
  }
  lines.push("");
  lines.push("## Follow-up issues");
  if (input.followUpIssues && input.followUpIssues.length > 0) {
    for (const issue of input.followUpIssues) {
      const label = issue.number !== undefined ? `#${issue.number}` : issue.title;
      lines.push(issue.url ? `- ${label}: ${issue.url}` : `- ${label}`);
    }
  } else {
    lines.push("- None recorded in this PR body at creation time.");
  }
  lines.push("");
  lines.push("<details>");
  lines.push("<summary>Automation details</summary>");
  lines.push("");
  lines.push(`- Triage verdict: ${input.triageVerdict ?? "unknown"}`);
  lines.push(`- Plan ready for implementation: ${input.planReady ?? "unknown"}`);
  lines.push(`- Readiness status: ${input.readinessStatus ?? "unknown"}`);
  lines.push(`- Review A: ${input.reviewVerdicts?.reviewA ?? "unknown"}`);
  lines.push(`- Review B: ${input.reviewVerdicts?.reviewB ?? "unknown"}`);
  if (input.attemptMetadata) {
    const meta = input.attemptMetadata;
    lines.push("");
    lines.push("### Attempt");
    lines.push(`- Attempt: ${meta.attempt}`);
    lines.push(`- Branch: \`${meta.branch}\``);
    lines.push(`- Started: ${meta.startedAt}`);
    if (meta.endedAt) lines.push(`- Ended: ${meta.endedAt}`);
    if (input.attemptMetadataPath) {
      lines.push(`- Metadata: \`${input.attemptMetadataPath}\``);
    }
  }
  lines.push("");
  lines.push("### Run ledger");
  lines.push(`- Full run ledger: issue comments on #${input.issueNumber}`);
  if (input.ledgerComments && input.ledgerComments.length > 0) {
    for (const comment of input.ledgerComments) {
      lines.push(comment.url ? `- ${comment.title}: ${comment.url}` : `- ${comment.title}: phase \`${comment.phase}\``);
    }
  }
  lines.push("");
  lines.push("### Workflow artifacts");
  lines.push("These artifacts are local control-plane state and are not committed to this PR branch.");
  if (input.artifactPaths.length === 0) {
    lines.push(`- \`${input.runDirRelative}/\``);
  } else {
    for (const artifactPath of input.artifactPaths) {
      lines.push(`- \`${artifactPath}\``);
    }
  }
  lines.push("");
  lines.push("</details>");
  lines.push("");
  lines.push("Generated by roark autorun.");
  return `${lines.join("\n")}\n`;
}

function appendBeforeAfterSection(lines: string[], narrative: FormatPrBodyNarrative | undefined, issueNumber: number): void {
  lines.push("## Before / After");
  const before = nonEmptyItems(narrative?.before);
  const after = nonEmptyItems(narrative?.after);
  lines.push("Before:");
  for (const item of before.length > 0 ? before : [`The behavior that prompted #${issueNumber} needed to be corrected.`]) lines.push(`- ${item}`);
  lines.push("");
  lines.push("After:");
  for (const item of after.length > 0 ? after : ["The implementation updates the relevant code path; see the changed files and verification below."]) lines.push(`- ${item}`);
}

function appendBulletSection(lines: string[], heading: string, items: string[] | undefined, fallbackItems: string[]): void {
  lines.push(heading);
  const usableItems = nonEmptyItems(items);
  for (const item of usableItems.length > 0 ? usableItems : fallbackItems) lines.push(`- ${item}`);
}

function appendChecklistSection(lines: string[], heading: string, items: string[] | undefined, fallbackItems: string[]): void {
  lines.push(heading);
  const usableItems = nonEmptyItems(items);
  for (const item of usableItems.length > 0 ? usableItems : fallbackItems) lines.push(`- [x] ${stripCheckboxMarker(item)}`);
}

function appendOrderedSection(lines: string[], heading: string, items: string[] | undefined, fallbackItems: string[]): void {
  lines.push(heading);
  const usableItems = nonEmptyItems(items);
  (usableItems.length > 0 ? usableItems : fallbackItems).forEach((item, index) => lines.push(`${index + 1}. ${item}`));
}

function appendFilesChangedSection(lines: string[], filesChanged: FormatPrBodyNarrativeFilesChanged | undefined): void {
  lines.push("## Files changed");
  if (!filesChanged || allFilesChangedEmpty(filesChanged)) {
    lines.push("- See the workflow artifacts for the changed file list.");
    return;
  }
  appendFileCategory(lines, "Behavior", filesChanged.behavior);
  appendFileCategory(lines, "Tests", filesChanged.tests);
  appendFileCategory(lines, "Plumbing", filesChanged.plumbing);
  appendFileCategory(lines, "Docs", filesChanged.docs);
  appendFileCategory(lines, "Other", filesChanged.other);
}

function appendFileCategory(lines: string[], label: string, files: string[]): void {
  const usableFiles = nonEmptyItems(files);
  if (usableFiles.length === 0) return;
  lines.push(`${label}:`);
  for (const file of usableFiles) lines.push(`- \`${file}\``);
}

function allFilesChangedEmpty(filesChanged: FormatPrBodyNarrativeFilesChanged): boolean {
  return [filesChanged.behavior, filesChanged.tests, filesChanged.plumbing, filesChanged.docs, filesChanged.other]
    .every((files) => files.length === 0);
}

function prefixedItems(prefix: string, items: string[] | undefined): string[] {
  return nonEmptyItems(items).map((item) => `${prefix}: ${item}`);
}

function nonEmptyItems(items: string[] | undefined): string[] {
  return (items ?? []).map((item) => item.trim()).filter((item) => item.length > 0);
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
  if (latestCycle === undefined) {
    candidates.push("reviewA", "reviewB");
  } else {
    candidates.push(reviewARef(latestCycle), reviewBRef(latestCycle));
  }

  candidates.push("readiness", "verification");

  const paths = candidates
    .filter((artifact) => artifactExists(context, artifact))
    .map((artifact) => artifactRelativePath(context, artifact));

  const latestFinalReview = latestFinalReviewPass(context);
  if (latestFinalReview !== undefined) {
    paths.push(artifactRelativePath(context, finalReviewRef(latestFinalReview)));
  }

  return paths;
}

export async function writePrNarrativeArtifact(context: WorkflowContext): Promise<FormatPrBodyNarrative> {
  const narrative = buildPrNarrativeFromWorkflowArtifacts(context);
  await writeArtifact(context, "prNarrative", formatPrNarrativeArtifact(narrative));
  return narrative;
}

export function collectPrBodyNarrative(context: WorkflowContext): FormatPrBodyNarrative {
  const narrativeMarkdown = readArtifactTextIfExists(context, "prNarrative");
  if (narrativeMarkdown) return parsePrNarrativeArtifact(narrativeMarkdown);
  return buildPrNarrativeFromWorkflowArtifacts(context);
}

function buildPrNarrativeFromWorkflowArtifacts(context: WorkflowContext): FormatPrBodyNarrative {
  const issueMarkdown = readArtifactTextIfExists(context, "issue");
  const planMarkdown = readArtifactTextIfExists(context, "implementationPlan");
  const implementationMarkdown = readArtifactTextIfExists(context, "implementationLog");

  const issueTitle = issueMarkdown ? extractIssueTitle(issueMarkdown) : undefined;
  const goal = summarizeMarkdownSection(planMarkdown, "Goal", 2);
  const currentFindings = summarizeMarkdownSection(planMarkdown, "Current Code Findings", 4);
  const proposedChanges = summarizeMarkdownSection(planMarkdown, "Proposed Changes", 5);
  const nonGoals = summarizeMarkdownSection(planMarkdown, "Non-Goals", 4);
  const risks = summarizeMarkdownSection(planMarkdown, "Risks", 4);
  const implementationSummary = summarizeMarkdownSection(implementationMarkdown, "Summary", 4);
  const changedFiles = summarizeMarkdownSection(implementationMarkdown, "Changed Files", 20).map(extractFileReference);

  const summary = buildSummary({ issueTitle, currentFindings, implementationSummary, proposedChanges, goal });
  const before = compactItems([
    ...currentFindings,
    ...(currentFindings.length === 0 && issueTitle ? [`The source issue reported: ${issueTitle}.`] : []),
  ]);
  const after = compactItems([
    ...implementationSummary,
    ...(implementationSummary.length === 0 ? proposedChanges : []),
  ]);
  const rootCause = compactItems(currentFindings);
  const fix = compactItems([...implementationSummary, ...(implementationSummary.length === 0 ? proposedChanges : [])]);
  const acceptanceCriteria = compactItems([...goal, ...proposedChanges]).slice(0, 6);
  const reviewPath = compactItems([
    changedFiles.length > 0 ? `Start with ${changedFiles.slice(0, 4).map((file) => `\`${file}\``).join(", ")} to verify the core change.` : undefined,
    goal[0] ? `Confirm the behavior satisfies the issue goal: ${goal[0]}` : undefined,
    nonGoals.length > 0 ? `Confirm scope stayed inside the important non-changes: ${nonGoals.join("; ")}.` : undefined,
    "Check the verification result and any edge cases listed below.",
  ]);
  const verificationNotes = [
    "Confirms the configured repository check command completed successfully when the status below is passed.",
    "Does not replace reviewer judgment on product behavior, edge cases, or production data assumptions.",
  ];

  return {
    issueTitle,
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
    risks: risks.length > 0 ? risks : ["No specific risks were recorded in the implementation plan."],
    edgeCases: compactItems([...risks, ...nonGoals]).slice(0, 4),
    reviewerQuestions: [],
  };
}

function parsePrNarrativeArtifact(markdown: string): FormatPrBodyNarrative {
  return {
    issueTitle: firstItem(summarizeMarkdownSection(markdown, "Issue Title", 1)),
    summary: firstItem(summarizeMarkdownSection(markdown, "Summary", 1)),
    before: summarizeMarkdownSection(markdown, "Before", 6),
    after: summarizeMarkdownSection(markdown, "After", 6),
    rootCause: summarizeMarkdownSection(markdown, "Root Cause", 6),
    fix: summarizeMarkdownSection(markdown, "Fix", 6),
    acceptanceCriteria: summarizeMarkdownSection(markdown, "Acceptance Criteria", 10).map(stripCheckboxMarker),
    reviewPath: summarizeMarkdownSection(markdown, "Suggested Review Path", 10),
    filesChanged: {
      behavior: summarizeMarkdownSection(markdown, "Files Changed: Behavior", 20).map(extractFileReference),
      tests: summarizeMarkdownSection(markdown, "Files Changed: Tests", 20).map(extractFileReference),
      plumbing: summarizeMarkdownSection(markdown, "Files Changed: Plumbing", 20).map(extractFileReference),
      docs: summarizeMarkdownSection(markdown, "Files Changed: Docs", 20).map(extractFileReference),
      other: summarizeMarkdownSection(markdown, "Files Changed: Other", 20).map(extractFileReference),
    },
    importantNonChanges: summarizeMarkdownSection(markdown, "Important Non-Changes", 10),
    verificationNotes: summarizeMarkdownSection(markdown, "Verification Notes", 10),
    manualVerification: summarizeMarkdownSection(markdown, "Manual Verification", 10),
    risks: summarizeMarkdownSection(markdown, "Risks", 10),
    edgeCases: summarizeMarkdownSection(markdown, "Edge Cases To Review", 10),
    reviewerQuestions: summarizeMarkdownSection(markdown, "Reviewer Questions", 10),
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
    ...markdownBulletSection("Files Changed: Behavior", filesChanged.behavior),
    "",
    ...markdownBulletSection("Files Changed: Tests", filesChanged.tests),
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
  const subject = input.issueTitle ? `The source issue was ${input.issueTitle}` : "The source issue described behavior that needed correction";
  const cause = input.currentFindings[0] ? ` ${input.currentFindings[0]}` : "";
  const fix = input.implementationSummary[0] ?? input.proposedChanges[0] ?? input.goal[0];
  if (!fix) return ensureSentence(subject);
  return normalizePrItem(`${ensureSentence(subject)}${cause ? ` The likely cause/context was: ${ensureSentence(cause)}` : ""} The fix is: ${ensureSentence(fix)}`);
}

function categorizeChangedFiles(files: string[]): FormatPrBodyNarrativeFilesChanged {
  const categorized = emptyFilesChanged();
  for (const file of files) {
    if (/(__tests__|\.test\.|\.spec\.)/i.test(file)) categorized.tests.push(file);
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
  if (!normalized || /^(?:none|not applicable|n\/a|not run|unknown)$/i.test(normalized)) return undefined;
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
  const { options, issue, branchPlan, workflowContext, verification, attemptMetadata, attemptMetadataPath } = input;
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

  const body = formatAutorunPrBody({
    issueNumber: issue.number,
    workflowContext,
    verification,
    attemptMetadata,
    attemptMetadataPath,
  });

  console.log("- Creating pull request");
  const prStdout = await runProcessOrThrow(
    buildPrCreateArgv({
      repo: options.repo,
      baseBranch: options.baseBranch,
      branchName: branchPlan.branchName,
      title: issue.title,
      body,
    }),
    { cwd: controlCwd, label: "gh pr create" },
  );
  const prUrl = prStdout.trim();
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

  return prUrl || undefined;
}

export async function updatePrBody(input: {
  cwd: string;
  repo?: string | undefined;
  pr: string;
  body: string;
}): Promise<void> {
  await runProcessOrThrow(
    buildPrEditBodyArgv({ repo: input.repo, pr: input.pr, body: input.body }),
    { cwd: input.cwd, label: "gh pr edit --body" },
  );
}

export function collectReviewVerdicts(context: WorkflowContext): ReviewVerdictSummary {
  const latestCycle = latestCompleteReviewCycle(context);
  return latestCycle === undefined
    ? {
      reviewA: readVerdictIfExists(context, "reviewA"),
      reviewB: readVerdictIfExists(context, "reviewB"),
    }
    : {
      reviewA: readVerdictIfExists(context, reviewARef(latestCycle)),
      reviewB: readVerdictIfExists(context, reviewBRef(latestCycle)),
    };
}

function collectArtifactVerdict(context: WorkflowContext, artifact: ArtifactRef): string | undefined {
  return readVerdictIfExists(context, artifact);
}

function collectPlanReady(context: WorkflowContext): string | undefined {
  if (!artifactExists(context, "implementationPlan")) return undefined;
  try {
    return parseReadyForImplementationValue(readFileSync(artifactPath(context, "implementationPlan"), "utf8"));
  } catch {
    return undefined;
  }
}

function collectLedgerCommentSummaries(attemptMetadata: AttemptMetadata | undefined, context: WorkflowContext): FormatPrBodyLedgerComment[] | undefined {
  const issueComments = attemptMetadata?.githubComments?.issue;
  if (!issueComments) return undefined;
  const latestCycle = latestCompleteReviewCycle(context);
  const reviewAPhases = latestCycle === undefined ? ["review-a"] : [`review-a-${latestCycle}`, "review-a"];
  const reviewBPhases = latestCycle === undefined ? ["review-b"] : [`review-b-${latestCycle}`, "review-b"];
  const phases: { phases: string[]; title: string }[] = [
    { phases: ["triage"], title: "Triage" },
    { phases: ["implementation-plan"], title: "Implementation plan" },
    { phases: ["readiness"], title: "Readiness" },
    { phases: reviewAPhases, title: "Review A" },
    { phases: reviewBPhases, title: "Review B" },
  ];
  return phases
    .map(({ phases, title }) => {
      const phase = phases.find((candidate) => issueComments[candidate]?.url !== undefined) ?? phases[0] ?? title;
      return { phase, title, url: issueComments[phase]?.url };
    })
    .filter((summary) => summary.url !== undefined);
}

function readVerdictIfExists(context: WorkflowContext, artifact: ArtifactRef): string | undefined {
  if (!artifactExists(context, artifact)) return undefined;
  try {
    return parseVerdict(readFileSync(artifactPath(context, artifact), "utf8")) ?? "unknown";
  } catch {
    return undefined;
  }
}
