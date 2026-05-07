import path from "node:path";
import { ISSUE_CURATION_STATIC_ARTIFACT_REFS } from "./artifact-catalog.ts";
import {
  artifactExists,
  artifactRelativePath,
  finalReviewRef,
  fixLogRef,
  readArtifact,
  type WorkflowContext,
  writeJsonArtifact,
} from "./artifacts.ts";
import {
  parseReviewPairFindings,
  type FindingClassification,
  type NormalizedReviewerFinding,
  type RejectedReviewerFinding,
  type ReviewFindingSource,
} from "./findings.ts";

export type IssueCurationPlan = {
  version: 1;
  sourceIssue: {
    number: number;
    title: string;
    url?: string;
  };
  run: {
    runDirRelative: string;
    attempt?: number;
    generatedAt: string;
    artifactPaths: string[];
  };
  blockingIssuesToCreate: IssuePlanItem[];
  followUpIssuesToCreate: IssuePlanItem[];
  rejectedCandidates: RejectedCandidate[];
  duplicatesMerged: DuplicateGroup[];
  warnings: string[];
};

export type IssuePlanItem = {
  planItemId: string;
  proposedTitle: string;
  proposedBody: string;
  sourceFindingIds: string[];
  reviewerSources: ReviewFindingSource[];
  sourceClassifications: FindingClassification[];
  severitySummary: string;
  confidenceSummary: string;
  evidence: string[];
  impact: string;
  whyBlockingOrNonBlocking: string;
  sourceIssueContext: IssueCurationPlan["sourceIssue"];
  runContext: {
    runDirRelative: string;
    attempt?: number;
    artifactPaths: string[];
  };
  proposedLabels: string[];
};

export type RejectedCandidate = {
  sourceFindingIds: string[];
  reviewerSources: ReviewFindingSource[];
  sourceClassifications: string[];
  title?: string;
  reason: string;
  evidence?: string;
  impact?: string;
  rawExcerpt?: string;
};

export type DuplicateGroup = {
  winningPlanItemId: string;
  mergedSourceFindingIds: string[];
  reviewerSources: ReviewFindingSource[];
  reason: string;
};

export type Clock = { now(): Date };

export const issueCurationDefaultClock: Clock = { now: () => new Date() };

export async function issueCurationPhase(
  context: WorkflowContext,
  clock: Clock = issueCurationDefaultClock,
): Promise<IssueCurationPlan> {
  const plan = await buildIssueCurationPlan(context, clock);
  await writeJsonArtifact(context, "issueCurationPlan", plan);
  console.log(`✓ Issue curation: wrote ${artifactRelativePath(context, "issueCurationPlan")}`);
  return plan;
}

export async function buildIssueCurationPlan(
  context: WorkflowContext,
  clock: Clock = issueCurationDefaultClock,
): Promise<IssueCurationPlan> {
  const warnings: string[] = [];
  const sourceIssue = await loadSourceIssueContext(context, warnings);
  const artifactPaths = collectAvailableArtifactPaths(context);
  const reviewA = await readOptionalArtifact(context, "reviewA", warnings);
  const reviewB = await readOptionalArtifact(context, "reviewB", warnings);
  const parsed = parseReviewPairFindings({ reviewA: reviewA ?? "", reviewB: reviewB ?? "" });

  warnings.push(...parsed.reviewA.warnings, ...parsed.reviewB.warnings);
  if (!parsed.reviewA.hasLedger && reviewA !== undefined) warnings.push("review-a.md does not contain a Findings Ledger.");
  if (!parsed.reviewB.hasLedger && reviewB !== undefined) warnings.push("review-b.md does not contain a Findings Ledger.");

  const rejectedCandidates: RejectedCandidate[] = [
    ...parsed.reviewA.rejected.map(rejectedParserFindingToCandidate),
    ...parsed.reviewB.rejected.map(rejectedParserFindingToCandidate),
  ];

  const findings = [...parsed.reviewA.findings, ...parsed.reviewB.findings];
  const accepted: NormalizedReviewerFinding[] = [];

  for (const finding of findings) {
    const rejectionReason = issueCandidateRejectionReason(finding);
    if (rejectionReason) {
      rejectedCandidates.push(normalizedFindingToRejectedCandidate(finding, rejectionReason));
    } else {
      accepted.push(finding);
    }
  }

  const duplicateGroups: DuplicateGroup[] = [];
  const blockingGroups = groupDuplicateFindings(accepted.filter((finding) => finding.classification === "external-blocker"));
  const followUpGroups = groupDuplicateFindings(accepted.filter((finding) => finding.classification === "follow-up"));

  const blockingIssuesToCreate = buildIssuePlanItems({
    groups: blockingGroups,
    kind: "blocking",
    sourceIssue,
    context,
    artifactPaths,
    duplicateGroups,
  });
  const followUpIssuesToCreate = buildIssuePlanItems({
    groups: followUpGroups,
    kind: "follow-up",
    sourceIssue,
    context,
    artifactPaths,
    duplicateGroups,
  });

  return {
    version: 1,
    sourceIssue,
    run: {
      runDirRelative: toPosix(context.runDirRelative),
      ...(context.attempt !== undefined ? { attempt: context.attempt } : {}),
      generatedAt: clock.now().toISOString(),
      artifactPaths,
    },
    blockingIssuesToCreate,
    followUpIssuesToCreate,
    rejectedCandidates,
    duplicatesMerged: duplicateGroups,
    warnings,
  };
}

function issueCandidateRejectionReason(finding: NormalizedReviewerFinding): string | undefined {
  if (finding.classification === "suggestion") return "suggestions are not issue candidates by default";
  if (finding.classification === "must-fix-current") return "must-fix-current findings belong to the current issue/fix pass and are not promoted by default";
  if (!hasConcreteContent(finding.evidence)) return "missing concrete evidence";
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

function hasVagueOrSpeculativeLanguage(finding: NormalizedReviewerFinding): boolean {
  const value = [finding.title, finding.evidence, finding.currentIssueImpact, finding.recommendedHandling]
    .join("\n")
    .toLowerCase();
  return /\b(maybe|perhaps|possibly|speculative|unclear|unknown|not sure|might|seems like|appears to)\b/.test(value);
}

function groupDuplicateFindings(findings: NormalizedReviewerFinding[]): NormalizedReviewerFinding[][] {
  const sorted = [...findings].sort(compareFindingsForGrouping);
  const groups: NormalizedReviewerFinding[][] = [];

  for (const finding of sorted) {
    const existing = groups.find((group) => group.some((candidate) => areDuplicateFindings(candidate, finding)));
    if (existing) existing.push(finding);
    else groups.push([finding]);
  }

  return groups;
}

function compareFindingsForGrouping(left: NormalizedReviewerFinding, right: NormalizedReviewerFinding): number {
  return normalizeTitle(left).localeCompare(normalizeTitle(right))
    || left.source.localeCompare(right.source)
    || left.workflowId.localeCompare(right.workflowId);
}

function areDuplicateFindings(left: NormalizedReviewerFinding, right: NormalizedReviewerFinding): boolean {
  if (left.classification !== right.classification) return false;
  if (normalizeTitle(left) === normalizeTitle(right)) return true;

  const leftRefs = evidenceReferences(left.evidence);
  const rightRefs = evidenceReferences(right.evidence);
  return leftRefs.some((ref) => rightRefs.includes(ref));
}

function buildIssuePlanItems(input: {
  groups: NormalizedReviewerFinding[][];
  kind: "blocking" | "follow-up";
  sourceIssue: IssueCurationPlan["sourceIssue"];
  context: WorkflowContext;
  artifactPaths: string[];
  duplicateGroups: DuplicateGroup[];
}): IssuePlanItem[] {
  return input.groups.map((group, index) => {
    const representative = group[0];
    if (!representative) throw new Error("empty issue curation group");

    const planItemId = `${input.kind}-${index + 1}`;
    const sourceFindingIds = unique(group.map((finding) => finding.workflowId));
    const reviewerSources = unique(group.map((finding) => finding.source));
    const sourceClassifications = unique(group.map((finding) => finding.classification));
    const evidence = unique(group.map((finding) => finding.evidence));
    const impacts = unique(group.map((finding) => finding.currentIssueImpact));
    const handling = unique(group.map((finding) => finding.recommendedHandling));
    const proposedTitle = representative.suggestedIssueTitle || representative.title;
    const whyBlockingOrNonBlocking = input.kind === "blocking"
      ? "Blocking: the reviewers classified this as an external-blocker needed to explain why the current issue cannot proceed."
      : "Non-blocking follow-up: the reviewers classified this as future work separate from the current issue.";

    const item: IssuePlanItem = {
      planItemId,
      proposedTitle,
      proposedBody: "",
      sourceFindingIds,
      reviewerSources,
      sourceClassifications,
      severitySummary: summarizeField("severity", group.map((finding) => finding.severity)),
      confidenceSummary: summarizeField("confidence", group.map((finding) => finding.confidence)),
      evidence,
      impact: impacts.join("\n\n"),
      whyBlockingOrNonBlocking,
      sourceIssueContext: input.sourceIssue,
      runContext: {
        runDirRelative: toPosix(input.context.runDirRelative),
        ...(input.context.attempt !== undefined ? { attempt: input.context.attempt } : {}),
        artifactPaths: input.artifactPaths,
      },
      proposedLabels: input.kind === "blocking" ? ["needs-triage", "external-blocker"] : ["needs-triage", "follow-up"],
    };
    item.proposedBody = buildProposedIssueBody({ item, handling, kind: input.kind });

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

function buildProposedIssueBody(input: {
  item: IssuePlanItem;
  handling: string[];
  kind: "blocking" | "follow-up";
}): string {
  const issue = input.item.sourceIssueContext;
  const issueLink = issue.url ? ` (${issue.url})` : "";
  const attempt = input.item.runContext.attempt === undefined ? "not specified" : String(input.item.runContext.attempt);
  const classification = input.item.sourceClassifications.join(", ");
  const nonGoals = input.kind === "follow-up"
    ? "\n## Non-goals\n- Do not rework the already-completed source issue beyond this follow-up scope.\n- Do not broaden this into an unrelated repository audit.\n"
    : "";

  return `## Source\n- Source issue: #${issue.number} ${issue.title}${issueLink}\n- Run directory: ${input.item.runContext.runDirRelative}\n- Attempt: ${attempt}\n- Source finding IDs: ${input.item.sourceFindingIds.join(", ")}\n- Reviewer source(s): ${input.item.reviewerSources.join(", ")}\n- Classification: ${classification}\n\n## Why this is ${input.kind === "blocking" ? "blocking" : "non-blocking"}\n${input.item.whyBlockingOrNonBlocking}\n\n## Evidence\n${input.item.evidence.map((evidence) => `- ${evidence}`).join("\n")}\n\n## Impact\n${input.item.impact}\n\n## Recommended handling\n${input.handling.map((handling) => `- ${handling}`).join("\n")}\n\n## Run artifacts\n${input.item.runContext.artifactPaths.map((artifactPath) => `- ${artifactPath}`).join("\n") || "- None recorded"}\n${nonGoals}`;
}

async function readOptionalArtifact(
  context: WorkflowContext,
  artifact: "issue" | "metadata" | "reviewA" | "reviewB",
  warnings: string[],
): Promise<string | undefined> {
  if (!artifactExists(context, artifact)) {
    if (artifact === "reviewA") warnings.push("review-a.md is missing; treating Review Agent A findings as empty.");
    if (artifact === "reviewB") warnings.push("review-b.md is missing; treating Review Agent B findings as empty.");
    return undefined;
  }

  try {
    return await readArtifact(context, artifact);
  } catch (error) {
    warnings.push(`Could not read ${artifactRelativePath(context, artifact)}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
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
        issueNumber?: number | string;
        repo?: string;
        issue?: { number?: number; title?: string; url?: string; html_url?: string; htmlUrl?: string };
      };
      const rawNumber = parsed.issue?.number ?? parsed.issueNumber;
      const parsedNumber = typeof rawNumber === "number" ? rawNumber : Number(rawNumber);
      const number = Number.isInteger(parsedNumber) ? parsedNumber : fallback.number;
      const title = parsed.issue?.title || fallback.title;
      const url = parsed.issue?.html_url || parsed.issue?.htmlUrl || parsed.issue?.url || (parsed.repo ? `https://github.com/${parsed.repo}/issues/${number}` : fallback.url);
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
  const numberMatch = markdown.match(/<github_issue\s+[^>]*number="(\d+)"/i);
  const titleMatch = markdown.match(/<title>([\s\S]*?)<\/title>/i);
  const urlMatch = markdown.match(/<url>([\s\S]*?)<\/url>/i);
  const markdownTitleMatch = markdown.match(/^#\s+GitHub Issue\s+#(\d+)(?:\s*[-:]\s*(.+))?\s*$/im);

  const number = numberMatch?.[1] ? Number(numberMatch[1]) : markdownTitleMatch?.[1] ? Number(markdownTitleMatch[1]) : fallback.number;
  const title = titleMatch?.[1] ? decodeXmlText(titleMatch[1].trim()) : markdownTitleMatch?.[2]?.trim() || fallback.title;
  const url = urlMatch?.[1] ? decodeXmlText(urlMatch[1].trim()) : fallback.url;
  return { number, title, ...(url ? { url } : {}) };
}

function collectAvailableArtifactPaths(context: WorkflowContext): string[] {
  const artifacts: string[] = [];
  for (const artifact of ISSUE_CURATION_STATIC_ARTIFACT_REFS) {
    if (artifactExists(context, artifact)) artifacts.push(toPosix(artifactRelativePath(context, artifact)));
  }

  for (let pass = 1; pass <= Math.max(context.maxFixPasses, 1) || artifactExists(context, fixLogRef(pass)) || artifactExists(context, finalReviewRef(pass)); pass++) {
    const fixLog = fixLogRef(pass);
    const finalReview = finalReviewRef(pass);
    if (artifactExists(context, fixLog)) artifacts.push(toPosix(artifactRelativePath(context, fixLog)));
    if (artifactExists(context, finalReview)) artifacts.push(toPosix(artifactRelativePath(context, finalReview)));
  }

  return artifacts;
}

function rejectedParserFindingToCandidate(finding: RejectedReviewerFinding): RejectedCandidate {
  return {
    sourceFindingIds: [finding.workflowId || finding.sourceLocalId || `${finding.source}:unparseable`],
    reviewerSources: [finding.source],
    sourceClassifications: finding.classification ? [finding.classification] : [],
    reason: finding.reason,
    rawExcerpt: finding.rawExcerpt,
  };
}

function normalizedFindingToRejectedCandidate(finding: NormalizedReviewerFinding, reason: string): RejectedCandidate {
  return {
    sourceFindingIds: [finding.workflowId],
    reviewerSources: [finding.source],
    sourceClassifications: [finding.classification],
    title: finding.suggestedIssueTitle || finding.title,
    reason,
    evidence: finding.evidence,
    impact: finding.currentIssueImpact,
    rawExcerpt: finding.rawExcerpt,
  };
}

function normalizeTitle(finding: NormalizedReviewerFinding): string {
  return normalizeText(finding.suggestedIssueTitle || finding.title);
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function evidenceReferences(value: string): string[] {
  const matches = value.match(/[\w./-]+\.[A-Za-z0-9]+(?::\d+(?:-\d+)?)?/g) ?? [];
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
