import path from "node:path";
import { reviewerIssueClassificationLabels, reviewerIssueHumanLabels, type ReviewerIssueClassificationLabel } from "../issue-curation/labels.ts";
import { ISSUE_CURATION_STATIC_ARTIFACT_REFS } from "./artifact-catalog.ts";
import {
  artifactExists,
  artifactRelativePath,
  fixLogRef,
  latestCompleteReviewCycle,
  readArtifact,
  reviewARef,
  reviewBRef,
  type ArtifactRef,
  type WorkflowContext,
  writeJsonArtifact,
} from "./artifacts.ts";
import {
  escapeReviewMarkdownText,
  type ReviewConcernClassification,
  normalizeReviewBlockers,
  normalizeReviewFindings,
  type NormalizedReviewBlocker,
  type NormalizedReviewerFinding,
  parseReviewResultJson,
  type ReviewFindingSource,
} from "../review/result.ts";

export type IssuePlanClassification = ReviewerIssueClassificationLabel;
type CuratableReviewConcern = NormalizedReviewerFinding | NormalizedReviewBlocker;

export interface IssueCurationPlan {
  version: 2;
  sourceIssue: {
    number: number;
    title: string;
    url?: string | undefined  ;
  };
  run: {
    runDirRelative: string;
    attempt?: number | undefined;
    generatedAt: string;
    artifactPaths: string[];
    prUrl?: string | undefined;
  };
  issuesToCreate: IssuePlanItem[];
  /** Read compatibility for pre-v2 curation plans. New plans do not emit this field. */
  blockingIssuesToCreate?: IssuePlanItem[] | undefined;
  /** Read compatibility for pre-v2 curation plans. New plans do not emit this field. */
  followUpIssuesToCreate?: IssuePlanItem[] | undefined;
  rejectedCandidates: RejectedCandidate[];
  duplicatesMerged: DuplicateGroup[];
  warnings: string[];
}

export interface IssuePlanItem {
  planItemId: string;
  classification: IssuePlanClassification;
  proposedTitle: string;
  proposedBody: string;
  sourceFindingIds: string[];
  reviewerSources: ReviewFindingSource[];
  sourceClassifications: ReviewConcernClassification[];
  severitySummary: string;
  confidenceSummary: string;
  evidence: string[];
  impact: string;
  recommendedHandling: string[];
  whyBlockingOrNonBlocking: string;
  sourceIssueContext: IssueCurationPlan["sourceIssue"];
  runContext: {
    runDirRelative: string;
    attempt?: number | undefined;
    artifactPaths: string[];
    prUrl?: string | undefined;
  };
  proposedLabels: string[];
}

export interface RejectedCandidate {
  sourceFindingIds: string[];
  reviewerSources: ReviewFindingSource[];
  sourceClassifications: string[];
  title?: string | undefined;
  reason: string;
  evidence?: string[] | undefined;
  impact?: string | undefined;
  rawExcerpt?: string | undefined;
}

export interface DuplicateGroup {
  winningPlanItemId: string;
  mergedSourceFindingIds: string[];
  reviewerSources: ReviewFindingSource[];
  reason: string;
}

export interface Clock { now(): Date }

export interface IssueCurationOptions {
  prUrl?: string | undefined;
}

export const issueCurationDefaultClock: Clock = { now: () => new Date() };

export async function issueCurationPhase(
  context: WorkflowContext,
  clock: Clock = issueCurationDefaultClock,
  options: IssueCurationOptions = {},
): Promise<IssueCurationPlan> {
  const plan = await buildIssueCurationPlan(context, clock, options);
  await writeJsonArtifact(context, "issueCurationPlan", plan);
  console.log(`✓ Issue curation: wrote ${artifactRelativePath(context, "issueCurationPlan")}`);
  return plan;
}

export async function buildIssueCurationPlan(
  context: WorkflowContext,
  clock: Clock = issueCurationDefaultClock,
  options: IssueCurationOptions = {},
): Promise<IssueCurationPlan> {
  const warnings: string[] = [];
  const sourceIssue = await loadSourceIssueContext(context, warnings);
  const artifactPaths = collectAvailableArtifactPaths(context);
  const reviewArtifacts = latestReviewArtifacts(context);
  const reviewA = reviewArtifacts === undefined ? undefined : await readOptionalArtifact(context, reviewArtifacts.reviewA, warnings);
  const reviewB = reviewArtifacts === undefined ? undefined : await readOptionalArtifact(context, reviewArtifacts.reviewB, warnings);
  const reviewAResult = reviewA === undefined ? undefined : parseReviewResultJson(reviewA, { allowRestart: true });
  const reviewBResult = reviewB === undefined ? undefined : parseReviewResultJson(reviewB, { allowRestart: true });
  const findings = [
    ...(reviewAResult === undefined ? [] : [
      ...normalizeReviewFindings(reviewAResult, "review-a"),
      ...normalizeReviewBlockers(reviewAResult, "review-a"),
    ]),
    ...(reviewBResult === undefined ? [] : [
      ...normalizeReviewFindings(reviewBResult, "review-b"),
      ...normalizeReviewBlockers(reviewBResult, "review-b"),
    ]),
  ];
  const rejectedCandidates: RejectedCandidate[] = [];
  const accepted: CuratableReviewConcern[] = [];

  for (const finding of findings) {
    const rejectionReason = issueCandidateRejectionReason(finding);
    if (rejectionReason) {
      rejectedCandidates.push(normalizedFindingToRejectedCandidate(finding, rejectionReason));
    } else {
      accepted.push(finding);
    }
  }

  const duplicateGroups: DuplicateGroup[] = [];
  const issuesToCreate = reviewerIssueClassificationLabels.flatMap((classification) => buildIssuePlanItems({
    groups: groupDuplicateFindings(accepted.filter((finding) => finding.classification === classification)),
    classification,
    sourceIssue,
    context,
    artifactPaths,
    duplicateGroups,
    prUrl: options.prUrl,
  }));

  return {
    version: 2,
    sourceIssue,
    run: {
      runDirRelative: toPosix(context.runDirRelative),
      ...(context.attempt !== undefined ? { attempt: context.attempt } : {}),
      generatedAt: clock.now().toISOString(),
      artifactPaths,
      ...(options.prUrl ? { prUrl: options.prUrl } : {}),
    },
    issuesToCreate,
    rejectedCandidates,
    duplicatesMerged: duplicateGroups,
    warnings,
  };
}

function issueCandidateRejectionReason(finding: CuratableReviewConcern): string | undefined {
  if (finding.classification === "must-fix-current") return "must-fix-current findings belong to the current issue/fix pass and are not promoted by default";
  if (!finding.evidence.some(hasConcreteContent)) return "missing concrete evidence";
  if (!hasConcreteContent(finding.currentIssueImpact)) return "missing current-issue or future-user impact";
  if (!hasConcreteContent(finding.title) || !hasConcreteContent(finding.recommendedHandling)) return "missing actionable title or recommended handling";
  if (hasVagueOrSpeculativeLanguage(finding)) return "vague or speculative candidate";
  return undefined;
}

function hasConcreteContent(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return false;
  if (/^(unspecified|none|n\/a|not applicable|unknown|unclear|tbd|todo)$/.test(normalized)) return false;
  return true;
}

function hasVagueOrSpeculativeLanguage(finding: CuratableReviewConcern): boolean {
  const value = [finding.title, ...finding.evidence, finding.currentIssueImpact, finding.recommendedHandling]
    .join("\n")
    .toLowerCase();
  return /\b(maybe|perhaps|possibly|speculative|unclear|unknown|not sure|might|seems like|appears to)\b/.test(value);
}

function groupDuplicateFindings(findings: CuratableReviewConcern[]): CuratableReviewConcern[][] {
  const sorted = [...findings].sort(compareFindingsForGrouping);
  const groups: CuratableReviewConcern[][] = [];

  for (const finding of sorted) {
    const existing = groups.find((group) => group.some((candidate) => areDuplicateFindings(candidate, finding)));
    if (existing) existing.push(finding);
    else groups.push([finding]);
  }

  return groups;
}

function compareFindingsForGrouping(left: CuratableReviewConcern, right: CuratableReviewConcern): number {
  const titleComparison = normalizeTitle(left).localeCompare(normalizeTitle(right));
  if (titleComparison !== 0) return titleComparison;
  const sourceComparison = left.source.localeCompare(right.source);
  if (sourceComparison !== 0) return sourceComparison;
  return left.workflowId.localeCompare(right.workflowId);
}

function areDuplicateFindings(left: CuratableReviewConcern, right: CuratableReviewConcern): boolean {
  if (left.classification !== right.classification) return false;
  if (normalizeTitle(left) === normalizeTitle(right)) return true;

  const leftRefs = evidenceReferences(left.evidence);
  const rightRefs = evidenceReferences(right.evidence);
  return leftRefs.some((ref) => rightRefs.includes(ref));
}

function buildIssuePlanItems(input: {
  groups: CuratableReviewConcern[][];
  classification: IssuePlanClassification;
  sourceIssue: IssueCurationPlan["sourceIssue"];
  context: WorkflowContext;
  artifactPaths: string[];
  duplicateGroups: DuplicateGroup[];
  prUrl?: string | undefined;
}): IssuePlanItem[] {
  return input.groups.map((group, index) => {
    const representative = group[0];
    if (!representative) throw new Error("empty issue curation group");

    const planItemId = `${input.classification}-${index + 1}`;
    const sourceFindingIds = unique(group.map((finding) => finding.workflowId));
    const reviewerSources = unique(group.map((finding) => finding.source));
    const sourceClassifications = unique(group.map((finding) => finding.classification));
    const evidence = unique(group.flatMap((finding) => finding.evidence));
    const impacts = unique(group.map((finding) => finding.currentIssueImpact));
    const handling = unique(group.map((finding) => finding.recommendedHandling));
    const proposedTitle = representative.suggestedIssueTitle ?? representative.title;
    const whyBlockingOrNonBlocking = classificationExplanation(input.classification);

    const item: IssuePlanItem = {
      planItemId,
      classification: input.classification,
      proposedTitle,
      proposedBody: "",
      sourceFindingIds,
      reviewerSources,
      sourceClassifications,
      severitySummary: summarizeField("severity", group.map((finding) => "severity" in finding ? finding.severity : "not applicable")),
      confidenceSummary: summarizeField("confidence", group.map((finding) => "confidence" in finding ? finding.confidence : "not applicable")),
      evidence,
      impact: impacts.join("\n\n"),
      recommendedHandling: handling,
      whyBlockingOrNonBlocking,
      sourceIssueContext: input.sourceIssue,
      runContext: {
        runDirRelative: toPosix(input.context.runDirRelative),
        ...(input.context.attempt !== undefined ? { attempt: input.context.attempt } : {}),
        artifactPaths: input.artifactPaths,
        ...(input.prUrl ? { prUrl: input.prUrl } : {}),
      },
      proposedLabels: unique([...reviewerIssueHumanLabels, input.classification]),
    };
    item.proposedBody = buildProposedIssueBody({ item });

    if (group.length > 1) {
      input.duplicateGroups.push({
        winningPlanItemId: planItemId,
        mergedSourceFindingIds: sourceFindingIds,
        reviewerSources,
        reason: "Merged findings with the same classification and matching normalized title or evidence reference.",
      });
    }

    return item;
  });
}

function classificationExplanation(classification: IssuePlanClassification): string {
  if (classification === "external-blocker") return "A reviewer found prerequisite or external work that may explain why the source issue could not proceed normally.";
  if (classification === "suggestion") return "A reviewer flagged this as optional improvement work that should be triaged by a human before implementation.";
  return "A reviewer found follow-up work that is separate from the completed source issue.";
}

function buildProposedIssueBody(input: { item: IssuePlanItem }): string {
  const issue = input.item.sourceIssueContext;
  const issueLink = issue.url ? ` (${issue.url})` : "";
  const attempt = input.item.runContext.attempt === undefined ? "not specified" : String(input.item.runContext.attempt);
  const prLine = input.item.runContext.prUrl ? `- Related PR: ${input.item.runContext.prUrl}\n` : "";
  const triage = triageRecommendation(input.item.classification);
  const nonGoals = input.item.classification === "follow-up" || input.item.classification === "suggestion"
    ? "\n## Non-goals\n\n- Do not rework the already-completed source issue beyond this issue's scope.\n- Do not broaden this into an unrelated repository audit.\n"
    : "";
  const title = escapeReviewMarkdownText(input.item.proposedTitle);
  const evidence = input.item.evidence.map((value) => `- ${escapeReviewMarkdownText(value)}`).join("\n");
  const impact = escapeReviewMarkdownText(input.item.impact);
  const handling = input.item.recommendedHandling.map((value) => `- ${escapeReviewMarkdownText(value)}`).join("\n");

  return `## Summary\n\n${summarySentence(title)}\n\n## Why this issue exists\n\n${input.item.whyBlockingOrNonBlocking}\n\n## What the reviewer observed\n\n${evidence}\n\n## Impact\n\n${impact}\n\n## Suggested fix\n\n${handling}\n\n## Acceptance criteria\n\n- The behavior described in “What the reviewer observed” is addressed for the cited code paths.\n- The suggested fix above is completed, or the issue is closed with a clear explanation of why no change is needed.\n- Relevant validation is updated or documented so this gap is less likely to recur.\n- Existing relevant checks continue to pass.\n\n## Triage recommendation\n\nPriority: ${triage.priority}  \nType: ${triage.type}  \nRecommended action: ${triage.recommendedAction}\n\n## Context\n\n- Source issue: #${issue.number} ${issue.title}${issueLink}\n${prLine}- Reviewer finding(s): ${input.item.sourceFindingIds.join(", ")}\n- Reviewer source(s): ${input.item.reviewerSources.join(", ")}\n- Classification: ${input.item.classification}\n- Run directory: ${input.item.runContext.runDirRelative}\n- Attempt: ${attempt}\n\n<details>\n<summary>Run artifacts</summary>\n\n${input.item.runContext.artifactPaths.map((artifactPath) => `- ${artifactPath}`).join("\n") || "- None recorded"}\n\n</details>\n${nonGoals}`;
}

function summarySentence(title: string): string {
  const trimmed = title.trim();
  if (!trimmed) return "Address the reviewer finding described below.";
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function triageRecommendation(classification: IssuePlanClassification): { priority: string; type: string; recommendedAction: string } {
  if (classification === "external-blocker") {
    return {
      priority: "High if it is still blocking the source issue; otherwise triage manually",
      type: "External blocker / prerequisite work",
      recommendedAction: "Resolve or explicitly dismiss this prerequisite before relying on the completed source issue work.",
    };
  }

  if (classification === "suggestion") {
    return {
      priority: "Low",
      type: "Optional improvement",
      recommendedAction: "Implement if the added protection or clarity is worth the cost; otherwise close as not planned.",
    };
  }

  return {
    priority: "Medium",
    type: "Non-blocking follow-up",
    recommendedAction: "Implement as a focused follow-up when it fits the roadmap; keep it separate from the completed source issue.",
  };
}

async function readOptionalArtifact(
  context: WorkflowContext,
  artifact: ArtifactRef,
  warnings: string[],
): Promise<string | undefined> {
  if (!artifactExists(context, artifact)) {
    if (isReviewArtifact(artifact, "reviewA")) warnings.push(`${artifactDisplayPath(context, artifact)} is missing; treating Review Agent A findings as empty.`);
    if (isReviewArtifact(artifact, "reviewB")) warnings.push(`${artifactDisplayPath(context, artifact)} is missing; treating Review Agent B findings as empty.`);
    return undefined;
  }

  try {
    return await readArtifact(context, artifact);
  } catch (error) {
    warnings.push(`Could not read ${artifactDisplayPath(context, artifact)}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

function latestReviewArtifacts(context: WorkflowContext): { reviewA: ArtifactRef; reviewB: ArtifactRef } | undefined {
  const latestReviewCycle = latestCompleteReviewCycle(context);
  if (latestReviewCycle === undefined) return undefined;
  return { reviewA: reviewARef(latestReviewCycle), reviewB: reviewBRef(latestReviewCycle) };
}

function isReviewArtifact(artifact: ArtifactRef, name: "reviewA" | "reviewB"): boolean {
  return typeof artifact !== "string" && artifact.name === name;
}

function artifactDisplayPath(context: WorkflowContext, artifact: ArtifactRef): string {
  return toPosix(artifactRelativePath(context, artifact));
}

async function loadSourceIssueContext(
  context: WorkflowContext,
  warnings: string[],
): Promise<IssueCurationPlan["sourceIssue"]> {
  const fallbackNumber = Number(context.issueNumber);
  const fallback: IssueCurationPlan["sourceIssue"] = {
    number: Number.isInteger(fallbackNumber) ? fallbackNumber : 0,
    title: `Issue #${context.issueNumber}`,
    ...(context.repo ? { url: `https://github.com/${context.repo}/issues/${context.issueNumber}` } : {}),
  };

  const metadata = await readOptionalArtifact(context, "metadata", warnings);
  if (metadata) {
    try {
      const parsed = JSON.parse(metadata) as {
        issueNumber?: number | string | undefined;
        repo?: string | undefined  ;
        issue?: { number?: number; title?: string; url?: string | undefined; html_url?: string; htmlUrl?: string };
      };
      const rawNumber = parsed.issue?.number ?? parsed.issueNumber;
      const parsedNumber = typeof rawNumber === "number" ? rawNumber : Number(rawNumber);
      const number = Number.isInteger(parsedNumber) ? parsedNumber : fallback.number;
      const title = parsed.issue?.title ?? fallback.title;
      const url = parsed.issue?.html_url ?? parsed.issue?.htmlUrl ?? parsed.issue?.url ?? (parsed.repo ? `https://github.com/${parsed.repo}/issues/${number}` : fallback.url);
      return { number, title, ...(url ? { url } : {}) };
    } catch (error) {
      warnings.push(`Could not parse ${artifactRelativePath(context, "metadata")}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const issueArtifact = await readOptionalArtifact(context, "issue", warnings);
  if (issueArtifact) return parseIssueArtifact(issueArtifact, fallback);

  warnings.push("Source issue artifact is missing; using issue number from workflow context.");
  return fallback;
}

function parseIssueArtifact(markdown: string, fallback: IssueCurationPlan["sourceIssue"]): IssueCurationPlan["sourceIssue"] {
  const numberMatch = /<github_issue\s+[^>]*number="(\d+)"/i.exec(markdown);
  const titleMatch = /<title>([\s\S]*?)<\/title>/i.exec(markdown);
  const urlMatch = /<url>([\s\S]*?)<\/url>/i.exec(markdown);
  const markdownTitleMatch = /^#\s+GitHub Issue\s+#(\d+)(?:\s*[-:]\s*(.+))?\s*$/im.exec(markdown);

  const number = numberMatch?.[1] !== undefined ? Number(numberMatch[1]) : markdownTitleMatch?.[1] !== undefined ? Number(markdownTitleMatch[1]) : fallback.number;
  const title = titleMatch?.[1] !== undefined ? decodeXmlText(titleMatch[1].trim()) : markdownTitleMatch?.[2]?.trim() ?? fallback.title;
  const url = urlMatch?.[1] ? decodeXmlText(urlMatch[1].trim()) : fallback.url;
  return { number, title, ...(url ? { url } : {}) };
}

function collectAvailableArtifactPaths(context: WorkflowContext): string[] {
  const artifacts: string[] = [];
  for (const artifact of ISSUE_CURATION_STATIC_ARTIFACT_REFS) {
    if (artifactExists(context, artifact)) artifacts.push(toPosix(artifactRelativePath(context, artifact)));
  }

  for (let pass = 0; pass <= Math.max(context.maxFixPasses, 0) || artifactExists(context, reviewARef(pass)) || artifactExists(context, reviewBRef(pass)); pass++) {
    const reviewA = reviewARef(pass);
    const reviewB = reviewBRef(pass);
    if (artifactExists(context, reviewA)) artifacts.push(toPosix(artifactRelativePath(context, reviewA)));
    if (artifactExists(context, reviewB)) artifacts.push(toPosix(artifactRelativePath(context, reviewB)));
  }

  for (let pass = 1; pass <= Math.max(context.maxFixPasses, 1) || artifactExists(context, fixLogRef(pass)); pass++) {
    const fixLog = fixLogRef(pass);
    if (artifactExists(context, fixLog)) artifacts.push(toPosix(artifactRelativePath(context, fixLog)));
  }

  return unique(artifacts);
}

function normalizedFindingToRejectedCandidate(finding: CuratableReviewConcern, reason: string): RejectedCandidate {
  return {
    sourceFindingIds: [finding.workflowId],
    reviewerSources: [finding.source],
    sourceClassifications: [finding.classification],
    title: finding.suggestedIssueTitle ?? finding.title,
    reason,
    evidence: finding.evidence,
    impact: finding.currentIssueImpact,
  };
}

function normalizeTitle(finding: CuratableReviewConcern): string {
  return normalizeText(finding.suggestedIssueTitle ?? finding.title);
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function evidenceReferences(values: readonly string[]): string[] {
  const matches = values.flatMap((value) => value.match(/[\w./-]+\.[A-Za-z0-9]+(?::\d+(?:-\d+)?)?/g) ?? []);
  return unique(matches.map((match) => match.toLowerCase()));
}

function summarizeField(label: "severity" | "confidence", values: string[]): string {
  return `${label}: ${unique(values).join(", ")}`;
}

function unique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values.filter((value) => value.trim() !== ""))];
}

function decodeXmlText(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}
