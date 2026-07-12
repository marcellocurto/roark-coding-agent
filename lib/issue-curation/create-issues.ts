import { runPiAgent } from "../pi/agent.ts";
import { issuePublishingPrompt, issuePublishingSystemPrompt } from "../prompts/issue-publishing-prompt.ts";
import type { AgentRunner } from "../workflow/agent-runner.ts";
import { effectiveModelForStage } from "../workflow/model-routing.ts";
import {
  artifactAgentPath,
  artifactExists,
  artifactRelativePath,
  readArtifact,
  type WorkflowContext,
  writeJsonArtifact,
} from "../workflow/artifacts.ts";
import type { DuplicateGroup, IssueCurationPlan, IssuePlanClassification } from "../workflow/issue-curation.ts";
import { ensureReviewerIssueLabels, reviewerIssueClassificationLabels, reviewerIssueHumanLabels } from "./labels.ts";

export interface IssueCreationCreatedEntry {
  planItemId: string;
  kind: IssuePlanKind;
  title: string;
  url?: string | undefined  ;
  number?: number | undefined;
  stdout?: string | undefined;
  source: "current-run" | "existing-result";
}

export interface IssueCreationFailedEntry {
  planItemId: string;
  kind: IssuePlanKind;
  title: string;
  message: string;
}

export interface IssueCreationSkippedEntry {
  planItemId: string;
  kind: IssueCreationSkippedKind;
  title?: string | undefined;
  reason: "already-created" | "malformed";
  message: string;
}

export interface IssueCreationWouldCreateEntry {
  planItemId: string;
  kind: IssuePlanKind;
  title: string;
  labels: string[];
}

export interface IssueCreationRelationshipOutcomeEntry {
  planItemId: string;
  status: string;
  message: string;
  relationship?: string | undefined;
  targetPlanItemId?: string | undefined;
  sourceIssueNumber?: number | undefined;
  targetIssueNumber?: number | undefined;
  url?: string | undefined  ;
}

export interface IssueCreationResults {
  version: 1;
  generatedAt: string;
  dryRun: boolean;
  approved: boolean;
  sourcePlanPath: string;
  resultPath: string;
  repo?: string | undefined  ;
  sourceIssue?: IssueCurationPlan["sourceIssue"] | undefined;
  created: IssueCreationCreatedEntry[];
  failed: IssueCreationFailedEntry[];
  skipped: IssueCreationSkippedEntry[];
  wouldCreate: IssueCreationWouldCreateEntry[];
  relationshipOutcomes: IssueCreationRelationshipOutcomeEntry[];
  counts: {
    acceptedPlanItems: number;
    wouldCreate: number;
    createdCurrentRun: number;
    createdTotalRecorded: number;
    failed: number;
    skippedRejectedCandidates: number;
    skippedDuplicateGroups: number;
    skippedDuplicateSourceFindings: number;
    skippedParserWarnings: number;
    skippedMalformed: number;
    skippedAlreadyCreated: number;
  };
}

export interface CreateIssuesOptions {
  context: WorkflowContext;
  agentRunner?: AgentRunner | undefined;
  clock?: { now(): Date } | undefined;
  approved?: boolean | undefined;
  approvalReason?: string | undefined;
  labelEnsurer?: ((options: { cwd: string; repo?: string | undefined }) => Promise<unknown>) | false | undefined;
}

type IssuePlanKind = IssuePlanClassification | "blocking";
type IssueCreationSkippedKind = IssuePlanKind | "unknown";

interface ValidPlanItem {
  kind: IssuePlanKind;
  planItemId: string;
  title: string;
  labels: string[];
}

const issueCreationDefaultClock = { now: () => new Date() };

export async function createIssuesPhase(context: WorkflowContext, agentRunner: AgentRunner = runPiAgent): Promise<IssueCreationResults> {
  const result = await createIssuesFromCurationPlan({ context, agentRunner });
  if (context.yes && result.failed.length > 0) {
    throw new Error(`Issue creation failed for ${result.failed.length} plan item(s). See ${artifactRelativePath(context, "issueCreationResults")}.`);
  }
  return result;
}

export async function createIssuesFromCurationPlan(options: CreateIssuesOptions): Promise<IssueCreationResults> {
  const { context, agentRunner = runPiAgent, clock = issueCreationDefaultClock } = options;
  const approved = options.approved ?? context.yes;
  const approvalReason = options.approvalReason ?? (context.yes ? "The user passed --yes" : "An internal caller explicitly approved publishing");
  const plan = await readIssueCurationPlan(context);
  const sourcePlanPath = artifactRelativePath(context, "issueCurationPlan");
  const resultPath = artifactRelativePath(context, "issueCreationResults");
  const existingCreated = await readExistingCreatedEntries(context);

  const collected = collectPlanItems(plan);
  const skipped: IssueCreationSkippedEntry[] = [...collected.malformed];
  const existingCreatedIds = new Set(existingCreated.map((entry) => entry.planItemId));
  const creatable = collected.valid.filter((item) => {
    if (!context.force && existingCreatedIds.has(item.planItemId)) {
      skipped.push({
        planItemId: item.planItemId,
        kind: item.kind,
        title: item.title,
        reason: "already-created",
        message: "Skipped because issue-creation-results.json already records this plan item as created. Pass --force to create it again.",
      });
      return false;
    }
    return true;
  });

  if (!approved) {
    const wouldCreate = creatable.map((item) => ({
      planItemId: item.planItemId,
      kind: item.kind,
      title: item.title,
      labels: labelsForPlanItem(item),
    }));
    const result = buildResult({
      context,
      plan,
      sourcePlanPath,
      resultPath,
      generatedAt: clock.now().toISOString(),
      dryRun: true,
      approved: false,
      existingCreated,
      createdCurrentRun: [],
      failed: [],
      skipped,
      wouldCreate,
      relationshipOutcomes: [],
      countsInput: collected.counts,
    });
    printDryRunSummary(context, result);
    return result;
  }

  if (creatable.length > 0) {
    const labelEnsurer = options.labelEnsurer ?? ensureReviewerIssueLabels;
    if (labelEnsurer !== false) {
      try {
        await labelEnsurer({ cwd: context.agentCwd, repo: context.repo });
      } catch (error) {
        const message = `Required reviewer-generated issue labels could not be ensured: ${error instanceof Error ? error.message : String(error)}`;
        const result = buildResult({
          context,
          plan,
          sourcePlanPath,
          resultPath,
          generatedAt: clock.now().toISOString(),
          dryRun: false,
          approved: true,
          existingCreated,
          createdCurrentRun: [],
          failed: creatable.map((item) => ({ planItemId: item.planItemId, kind: item.kind, title: item.title, message })),
          skipped,
          wouldCreate: [],
          relationshipOutcomes: [],
          countsInput: collected.counts,
        });
        await writeJsonArtifact(context, "issueCreationResults", result);
        printApprovedSummary(context, result);
        return result;
      }
    }
  }

  const publishResult = await publishIssuesWithAgent({
      context,
      sourcePlanPath,
      promptSourcePlanPath: artifactAgentPath(context, "issueCurationPlan"),
      promptResultPath: artifactAgentPath(context, "issueCreationResults"),
      creatable,
      agentRunner,
      approvalReason,
  });

  const result = buildResult({
    context,
    plan,
    sourcePlanPath,
    resultPath,
    generatedAt: clock.now().toISOString(),
    dryRun: false,
    approved: true,
    existingCreated,
    createdCurrentRun: publishResult.createdCurrentRun,
    failed: publishResult.failed,
    skipped,
    wouldCreate: [],
    relationshipOutcomes: publishResult.relationshipOutcomes,
    countsInput: collected.counts,
  });
  await writeJsonArtifact(context, "issueCreationResults", result);
  printApprovedSummary(context, result);
  return result;
}

interface PublishResult {
  createdCurrentRun: IssueCreationCreatedEntry[];
  failed: IssueCreationFailedEntry[];
  relationshipOutcomes: IssueCreationRelationshipOutcomeEntry[];
}

async function publishIssuesWithAgent(input: {
  context: WorkflowContext;
  sourcePlanPath: string;
  promptSourcePlanPath: string;
  promptResultPath: string;
  creatable: ValidPlanItem[];
  agentRunner: AgentRunner;
  approvalReason: string;
}): Promise<PublishResult> {
  const { context, sourcePlanPath, promptSourcePlanPath, promptResultPath, creatable, agentRunner, approvalReason } = input;
  if (creatable.length === 0) return { createdCurrentRun: [], failed: [], relationshipOutcomes: [] };

  console.log(`\n=== Author and create issues from ${sourcePlanPath} ===`);

  try {
    const output = await agentRunner({
      cwd: context.agentCwd,
      model: effectiveModelForStage(context.model, "issuePublishing"),
      thinkingLevel: context.thinkingConfig.issuePublishing,
      systemPrompt: issuePublishingSystemPrompt(),
      prompt: issuePublishingPrompt({
        context,
        sourcePlanPath: promptSourcePlanPath,
        resultPath: promptResultPath,
        approvalReason,
        allowedItems: creatable.map((item) => ({
          planItemId: item.planItemId,
          kind: item.kind,
          suggestedTitle: item.title,
          labels: labelsForPlanItem(item),
        })),
      }),
      fileEditingToolsEnabled: false,
      observer: context.observer,
      phase: "issue-publishing",
    });
    return toPublishResult(parseIssuePublishingAgentResponse(output), creatable);
  } catch (error) {
    return {
      createdCurrentRun: [],
      failed: creatable.map((item) => ({
        planItemId: item.planItemId,
        kind: item.kind,
        title: item.title,
        message: error instanceof Error ? error.message : String(error),
      })),
      relationshipOutcomes: [],
    };
  }
}

export function parseIssuePublishingAgentResponse(output: string): {
  created: unknown[];
  failed: unknown[];
  relationshipOutcomes: unknown[];
} {
  const trimmed = output.trim();
  const jsonText = trimmed.startsWith("```") ? extractFencedJson(trimmed) : trimmed;
  const parsed = JSON.parse(jsonText) as unknown;
  if (!isRecord(parsed)) throw new Error("Issue-publishing agent response was not a JSON object.");
  return {
    created: asOptionalArrayProperty(parsed, "created"),
    failed: asOptionalArrayProperty(parsed, "failed"),
    relationshipOutcomes: asOptionalArrayProperty(parsed, "relationshipOutcomes"),
  };
}

function toPublishResult(agentResult: ReturnType<typeof parseIssuePublishingAgentResponse>, creatable: ValidPlanItem[]): PublishResult {
  const itemsById = new Map(creatable.map((item) => [item.planItemId, item]));
  const createdCurrentRun = agentResult.created.map((entry) => {
    if (!isRecord(entry)) throw new Error("Issue-publishing agent returned a non-object created entry.");
    const planItemId = asNonEmptyString(entry["planItemId"]);
    if (!planItemId || !itemsById.has(planItemId)) throw new Error(`Issue-publishing agent returned unknown created planItemId '${planItemId ?? ""}'.`);
    const item = itemsById.get(planItemId);
    if (item === undefined) throw new Error(`Issue-publishing agent returned unknown created planItemId '${planItemId}'.`);
    const number = typeof entry["number"] === "number" && Number.isInteger(entry["number"]) ? entry["number"] : undefined;
    return {
      planItemId,
      kind: item.kind,
      title: asNonEmptyString(entry["title"]) ?? item.title,
      ...(asNonEmptyString(entry["url"]) ? { url: asNonEmptyString(entry["url"]) } : {}),
      ...(number !== undefined ? { number } : {}),
      ...(asNonEmptyString(entry["stdout"]) ? { stdout: asNonEmptyString(entry["stdout"]) } : {}),
      source: "current-run" as const,
    };
  });
  const failed = agentResult.failed.map((entry) => {
    if (!isRecord(entry)) throw new Error("Issue-publishing agent returned a non-object failed entry.");
    const planItemId = asNonEmptyString(entry["planItemId"]);
    if (!planItemId || !itemsById.has(planItemId)) throw new Error(`Issue-publishing agent returned unknown failed planItemId '${planItemId ?? ""}'.`);
    const item = itemsById.get(planItemId);
    if (item === undefined) throw new Error(`Issue-publishing agent returned unknown failed planItemId '${planItemId}'.`);
    return {
      planItemId,
      kind: item.kind,
      title: item.title,
      message: asNonEmptyString(entry["message"]) ?? "Issue-publishing agent reported failure without a message.",
    };
  });
  assertResultCoverage(createdCurrentRun, failed, itemsById);
  const relationshipOutcomes = normalizeRelationshipOutcomes(agentResult.relationshipOutcomes, itemsById);
  return { createdCurrentRun, failed, relationshipOutcomes };
}

function assertResultCoverage(
  created: IssueCreationCreatedEntry[],
  failed: IssueCreationFailedEntry[],
  itemsById: Map<string, ValidPlanItem>,
): void {
  const seen = new Map<string, number>();
  for (const entry of [...created, ...failed]) {
    seen.set(entry.planItemId, (seen.get(entry.planItemId) ?? 0) + 1);
  }

  const duplicates = [...seen.entries()].filter(([, count]) => count > 1).map(([planItemId]) => planItemId);
  if (duplicates.length > 0) {
    throw new Error(`Issue-publishing agent returned duplicate result for planItemId(s): ${duplicates.join(", ")}.`);
  }

  const missing = [...itemsById.keys()].filter((planItemId) => !seen.has(planItemId));
  if (missing.length > 0) {
    throw new Error(`Issue-publishing agent omitted result for planItemId(s): ${missing.join(", ")}.`);
  }
}

function normalizeRelationshipOutcomes(entries: unknown[], itemsById: Map<string, ValidPlanItem>): IssueCreationRelationshipOutcomeEntry[] {
  return entries.map((entry) => {
    if (!isRecord(entry)) throw new Error("Issue-publishing agent returned a non-object relationship outcome entry.");

    const planItemId = asNonEmptyString(entry["planItemId"]);
    if (!planItemId || !itemsById.has(planItemId)) {
      throw new Error(`Issue-publishing agent returned unknown relationship outcome planItemId '${planItemId ?? ""}'.`);
    }

    const status = asNonEmptyString(entry["status"]);
    if (!status) throw new Error(`Issue-publishing agent returned relationship outcome for '${planItemId}' without a non-empty status.`);

    const message = asNonEmptyString(entry["message"]);
    if (!message) throw new Error(`Issue-publishing agent returned relationship outcome for '${planItemId}' without a non-empty message.`);

    const targetPlanItemId = asNonEmptyString(entry["targetPlanItemId"]);
    if (targetPlanItemId && !itemsById.has(targetPlanItemId)) {
      throw new Error(`Issue-publishing agent returned relationship outcome for '${planItemId}' with unknown targetPlanItemId '${targetPlanItemId}'.`);
    }

    const sourceIssueNumber = asInteger(entry["sourceIssueNumber"]);
    const targetIssueNumber = asInteger(entry["targetIssueNumber"]);
    return {
      planItemId,
      status,
      message,
      ...(asNonEmptyString(entry["relationship"]) ? { relationship: asNonEmptyString(entry["relationship"]) } : {}),
      ...(targetPlanItemId ? { targetPlanItemId } : {}),
      ...(sourceIssueNumber !== undefined ? { sourceIssueNumber } : {}),
      ...(targetIssueNumber !== undefined ? { targetIssueNumber } : {}),
      ...(asNonEmptyString(entry["url"]) ? { url: asNonEmptyString(entry["url"]) } : {}),
    };
  });
}

function extractFencedJson(output: string): string {
  const match = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(output);
  if (!match?.[1]) throw new Error("Issue-publishing agent response was fenced but did not contain JSON.");
  return match[1];
}

async function readIssueCurationPlan(context: WorkflowContext): Promise<IssueCurationPlan> {
  if (!artifactExists(context, "issueCurationPlan")) {
    throw new Error(`Missing issue curation plan: ${artifactRelativePath(context, "issueCurationPlan")}. Run 'curate-issues' first.`);
  }

  try {
    return JSON.parse(await readArtifact(context, "issueCurationPlan")) as IssueCurationPlan;
  } catch (error) {
    throw new Error(`Could not parse ${artifactRelativePath(context, "issueCurationPlan")}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function readExistingCreatedEntries(context: WorkflowContext): Promise<IssueCreationCreatedEntry[]> {
  if (!artifactExists(context, "issueCreationResults")) return [];

  try {
    const parsed = JSON.parse(await readArtifact(context, "issueCreationResults")) as { created?: unknown };
    if (!Array.isArray(parsed.created)) return [];
    return parsed.created.flatMap((entry) => {
      if (!isRecord(entry)) return [];
      const planItemId = asNonEmptyString(entry["planItemId"]);
      const title = asNonEmptyString(entry["title"]);
      const kind = parseIssuePlanKind(entry["kind"]);
      if (!planItemId || !title || !kind) return [];
      return [{
        planItemId,
        kind,
        title,
        ...(asNonEmptyString(entry["url"]) ? { url: asNonEmptyString(entry["url"]) } : {}),
        ...(typeof entry["number"] === "number" && Number.isInteger(entry["number"]) ? { number: entry["number"] } : {}),
        ...(asNonEmptyString(entry["stdout"]) ? { stdout: asNonEmptyString(entry["stdout"]) } : {}),
        source: "existing-result" as const,
      }];
    });
  } catch (error) {
    console.warn(`Could not parse existing ${artifactRelativePath(context, "issueCreationResults")}; rerun idempotence will not use it: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

function collectPlanItems(plan: IssueCurationPlan): {
  valid: ValidPlanItem[];
  malformed: IssueCreationSkippedEntry[];
  counts: Pick<IssueCreationResults["counts"], "acceptedPlanItems" | "skippedRejectedCandidates" | "skippedDuplicateGroups" | "skippedDuplicateSourceFindings" | "skippedParserWarnings" | "skippedMalformed">;
} {
  const normalized = (plan as Partial<IssueCurationPlan>).issuesToCreate;
  const classificationMalformed: IssueCreationSkippedEntry[] = [];
  const accepted = Array.isArray(normalized)
    ? normalized.flatMap((item, index) => {
      const record = isRecord(item) ? item : undefined;
      const classification = parseIssuePlanClassification(record?.classification);
      if (!classification) {
        classificationMalformed.push(malformedSkip(
          record ? asNonEmptyString(record.planItemId) ?? `unclassified-${index + 1}` : `unclassified-${index + 1}`,
          "unknown",
          record ? asNonEmptyString(record.proposedTitle) : undefined,
          "Missing or invalid required field(s): classification. Expected one of: external-blocker, follow-up, suggestion.",
        ));
        return [];
      }
      return [{ raw: item, kind: classification, index }];
    })
    : [
      ...asArray((plan as Partial<IssueCurationPlan>).blockingIssuesToCreate).map((item, index) => ({ raw: item, kind: "blocking" as const, index })),
      ...asArray((plan as Partial<IssueCurationPlan>).followUpIssuesToCreate).map((item, index) => ({ raw: item, kind: "follow-up" as const, index })),
    ];
  const acceptedPlanItemCount = Array.isArray(normalized) ? normalized.length : accepted.length;

  const valid: ValidPlanItem[] = [];
  const malformed: IssueCreationSkippedEntry[] = [...classificationMalformed];
  for (const entry of accepted) {
    const parsed = parseValidPlanItem(entry.raw, entry.kind, entry.index);
    if ("item" in parsed) valid.push(parsed.item);
    else malformed.push(parsed.skipped);
  }

  const rejectedCandidates = asArray((plan as Partial<IssueCurationPlan>).rejectedCandidates);
  const duplicatesMerged = asArray((plan as Partial<IssueCurationPlan>).duplicatesMerged) as DuplicateGroup[];
  const warnings = asArray((plan as Partial<IssueCurationPlan>).warnings);
  return {
    valid,
    malformed,
    counts: {
      acceptedPlanItems: acceptedPlanItemCount,
      skippedRejectedCandidates: rejectedCandidates.length,
      skippedDuplicateGroups: duplicatesMerged.length,
      skippedDuplicateSourceFindings: duplicatesMerged.reduce((total, group) => {
        const ids = isRecord(group) && Array.isArray(group.mergedSourceFindingIds) ? group.mergedSourceFindingIds : [];
        return total + ids.length;
      }, 0),
      skippedParserWarnings: warnings.length,
      skippedMalformed: malformed.length,
    },
  };
}

function parseValidPlanItem(raw: unknown, kind: IssuePlanKind, index: number): { item: ValidPlanItem } | { skipped: IssueCreationSkippedEntry } {
  const fallbackId = `${kind}-${index + 1}`;
  if (!isRecord(raw)) {
    return { skipped: malformedSkip(fallbackId, kind, undefined, "Plan entry is not an object.") };
  }

  const planItemId = asNonEmptyString(raw["planItemId"]);
  const title = asNonEmptyString(raw["proposedTitle"]);
  const missing = [
    ...(planItemId ? [] : ["planItemId"]),
    ...(title ? [] : ["proposedTitle"]),
  ];
  if (missing.length > 0 || !planItemId || !title) {
    return { skipped: malformedSkip(planItemId ?? fallbackId, kind, title, `Missing required field(s): ${missing.join(", ")}.`) };
  }

  return {
    item: {
      kind,
      planItemId,
      title,
      labels: Array.isArray(raw["proposedLabels"]) ? raw["proposedLabels"].filter((label): label is string => typeof label === "string") : [],
    },
  };
}

function malformedSkip(planItemId: string, kind: IssueCreationSkippedKind, title: string | undefined, message: string): IssueCreationSkippedEntry {
  return {
    planItemId,
    kind,
    ...(title ? { title } : {}),
    reason: "malformed",
    message,
  };
}

function parseIssuePlanKind(value: unknown): IssuePlanKind | undefined {
  if (value === "blocking") return value;
  return parseIssuePlanClassification(value);
}

function parseIssuePlanClassification(value: unknown): IssuePlanClassification | undefined {
  return reviewerIssueClassificationLabels.find((label) => label === value);
}

function buildResult(input: {
  context: WorkflowContext;
  plan: IssueCurationPlan;
  sourcePlanPath: string;
  resultPath: string;
  generatedAt: string;
  dryRun: boolean;
  approved: boolean;
  existingCreated: IssueCreationCreatedEntry[];
  createdCurrentRun: IssueCreationCreatedEntry[];
  failed: IssueCreationFailedEntry[];
  skipped: IssueCreationSkippedEntry[];
  wouldCreate: IssueCreationWouldCreateEntry[];
  relationshipOutcomes: IssueCreationRelationshipOutcomeEntry[];
  countsInput: Pick<IssueCreationResults["counts"], "acceptedPlanItems" | "skippedRejectedCandidates" | "skippedDuplicateGroups" | "skippedDuplicateSourceFindings" | "skippedParserWarnings" | "skippedMalformed">;
}): IssueCreationResults {
  const created = [...input.existingCreated, ...input.createdCurrentRun];
  return {
    version: 1,
    generatedAt: input.generatedAt,
    dryRun: input.dryRun,
    approved: input.approved,
    sourcePlanPath: input.sourcePlanPath,
    resultPath: input.resultPath,
    ...(input.context.repo ? { repo: input.context.repo } : {}),
    sourceIssue: input.plan.sourceIssue,
    created,
    failed: input.failed,
    skipped: input.skipped,
    wouldCreate: input.wouldCreate,
    relationshipOutcomes: input.relationshipOutcomes,
    counts: {
      ...input.countsInput,
      wouldCreate: input.wouldCreate.length,
      createdCurrentRun: input.createdCurrentRun.length,
      createdTotalRecorded: created.length,
      failed: input.failed.length,
      skippedAlreadyCreated: input.skipped.filter((entry) => entry.reason === "already-created").length,
    },
  };
}

function labelsForPlanItem(item: Pick<ValidPlanItem, "kind" | "labels">): string[] {
  return normalizeLabels([...reviewerIssueHumanLabels, classificationLabelForKind(item.kind), ...item.labels]);
}

function classificationLabelForKind(kind: IssuePlanKind): IssuePlanClassification {
  return kind === "blocking" ? "external-blocker" : kind;
}

function normalizeLabels(labels: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const label of labels) {
    const trimmed = label.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

function printDryRunSummary(context: WorkflowContext, result: IssueCreationResults): void {
  console.log(`\n=== Dry run: create issues from ${result.sourcePlanPath} ===`);
  console.log("No GitHub issues were created. Pass --yes to create approved plan items.");
  console.log(`Target repo: ${context.repo ?? "gh default repository"}`);
  if (result.wouldCreate.length === 0) {
    console.log(`No approved plan items would be created. ${zeroCreatedExplanation(result)}`);
  } else {
    for (const item of result.wouldCreate) {
      console.log(`- ${item.planItemId} [${item.kind}]: ${item.title}`);
      console.log(`  labels: ${item.labels.join(", ")}`);
    }
  }
  printSkippedCounts(result);
}

function printApprovedSummary(context: WorkflowContext, result: IssueCreationResults): void {
  console.log(`\n✓ Issue creation: wrote ${artifactRelativePath(context, "issueCreationResults")}`);
  console.log(`Created this run: ${result.counts.createdCurrentRun}; failed: ${result.failed.length}; skipped already-created: ${result.counts.skippedAlreadyCreated}; malformed: ${result.counts.skippedMalformed}.`);
  if (result.counts.createdCurrentRun === 0) console.log(`Zero created explanation: ${zeroCreatedExplanation(result)}`);
  for (const entry of result.created.filter((created) => created.source === "current-run")) {
    console.log(`- created ${entry.planItemId}${entry.url ? `: ${entry.url}` : ""}`);
  }
  for (const entry of result.failed) {
    console.log(`- failed ${entry.planItemId}: ${entry.message}`);
  }
  printSkippedCounts(result);
}

function printSkippedCounts(result: IssueCreationResults): void {
  console.log(`Skipped rejected candidates: ${result.counts.skippedRejectedCandidates}; duplicate groups: ${result.counts.skippedDuplicateGroups}; parser warnings: ${result.counts.skippedParserWarnings}.`);
}

function zeroCreatedExplanation(result: IssueCreationResults): string {
  if (result.counts.acceptedPlanItems === 0) {
    if (result.counts.skippedParserWarnings > 0) return "No accepted candidates were found; review parser warnings and missing artifacts in the curation plan.";
    if (result.counts.skippedRejectedCandidates > 0) return "All parsed candidates were rejected by curation policy; inspect rejectedCandidates for reasons.";
    return "The curation plan contains no accepted reviewer findings.";
  }
  if (result.counts.skippedAlreadyCreated >= result.counts.acceptedPlanItems) return "All accepted plan items were already recorded as created; use --force only if you intentionally want duplicates.";
  if (result.counts.skippedMalformed > 0) return "Accepted plan items were malformed and skipped; inspect skipped entries in issue-creation-results.json.";
  if (result.failed.length > 0) return "Publishing or label setup failed; inspect failed entries in issue-creation-results.json.";
  return "No creatable plan items remained after idempotence and validation checks.";
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asOptionalArrayProperty(record: Record<string, unknown>, key: string): unknown[] {
  const value = record[key];
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`Issue-publishing agent response field '${key}' was not an array.`);
  return value;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function asInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
