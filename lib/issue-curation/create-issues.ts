import { runPiAgent } from "../pi/agent.ts";
import { issuePublishingPrompt, issuePublishingSystemPrompt } from "../prompts/issue-publishing-prompt.ts";
import { publishIssueWithGitHub, type IssuePublisher } from "../issue-publishing/github.ts";
import { formatIssueDraftMarkdown, type IssueDraftCollection, type IssueDraftRenderingContext } from "../issue-publishing/result.ts";
import { issueDraftArtifactDefinition } from "../issue-publishing/artifact.ts";
import type { AgentRunner } from "../workflow/agent-runner.ts";
import { presenter, type AgentDisplayContext } from "../presentation/presenter.ts";
import { runPresentedPhase } from "../presentation/phase.ts";
import { effectiveModelForStage } from "../workflow/model-routing.ts";
import {
  artifactAgentPath,
  artifactExists,
  artifactRelativePath,
  readArtifact,
  type WorkflowContext,
  writeArtifact,
  writeJsonArtifact,
} from "../workflow/artifacts.ts";
import type { DuplicateGroup, IssueCurationPlan, IssuePlanClassification } from "../workflow/issue-curation.ts";
import {
  ensureReviewerIssueLabels,
  reviewerIssueClassificationLabels,
  reviewerIssueLabelForClassification,
  reviewerIssueManagedLabels,
  reviewerIssueTriageLabels,
} from "./labels.ts";
import { sanitizePublicMarkdown } from "../autorun/public-output.ts";
import { runStructuredArtifact } from "../structured-output/runner.ts";

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
  issuePublisher?: IssuePublisher | undefined;
}

type IssuePlanKind = IssuePlanClassification | "blocking";
type IssueCreationSkippedKind = IssuePlanKind | "unknown";

interface ValidPlanItem {
  kind: IssuePlanKind;
  planItemId: string;
  title: string;
  labels: string[];
  renderingContext: IssueDraftRenderingContext;
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

  const display: AgentDisplayContext | undefined = creatable.length === 0 ? undefined : {
    command: context.displayCommand ?? "create-issues",
    repository: context.repo,
    target: `#${context.issueNumber}`,
    phaseId: "issue-publishing",
    phaseLabel: "Author and create issues",
    expectedArtifact: resultPath,
    operation: "publish",
  };
  const create = async () => {
    const publishResult = display === undefined
      ? { createdCurrentRun: [], failed: [], relationshipOutcomes: [] }
      : await authorAndPublishIssues({
        context,
        promptSourcePlanPath: artifactAgentPath(context, "issueCurationPlan"),
        creatable,
        agentRunner,
        approvalReason,
        display,
        issuePublisher: options.issuePublisher ?? publishIssueWithGitHub,
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
    return result;
  };
  const result = display
    ? await runPresentedPhase(display, create, (created) => ({
      outcome: `created ${created.counts.createdCurrentRun}, failed ${created.failed.length}`,
      artifact: resultPath,
      failed: created.failed.length > 0,
    }))
    : await create();
  printApprovedSummary(context, result);
  return result;
}

interface PublishResult {
  createdCurrentRun: IssueCreationCreatedEntry[];
  failed: IssueCreationFailedEntry[];
  relationshipOutcomes: IssueCreationRelationshipOutcomeEntry[];
}

async function authorAndPublishIssues(input: {
  context: WorkflowContext;
  promptSourcePlanPath: string;
  creatable: ValidPlanItem[];
  agentRunner: AgentRunner;
  approvalReason: string;
  issuePublisher: IssuePublisher;
  display: AgentDisplayContext;
}): Promise<PublishResult> {
  const { context, promptSourcePlanPath, creatable, agentRunner, approvalReason, issuePublisher, display } = input;

  try {
    const itemsById = new Map(creatable.map((item) => [item.planItemId, item]));
    const localRoots = [context.controlCwd, context.agentCwd];
    const renderDrafts = (drafts: IssueDraftCollection) => renderIssueDrafts(drafts, itemsById, localRoots);
    const artifact = await runStructuredArtifact({
      cwd: context.agentCwd,
      model: effectiveModelForStage(context.model, "issuePublishing"),
      thinkingLevel: context.thinkingConfig.issuePublishing,
      systemPrompt: issuePublishingSystemPrompt(),
      prompt: issuePublishingPrompt({
        context,
        sourcePlanPath: promptSourcePlanPath,
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
      display,
    }, agentRunner, issueDraftArtifactDefinition({
      expectedPlanItemIds: creatable.map((item) => item.planItemId),
      formatMarkdown: (drafts) => formatIssueDraftCollectionMarkdown(drafts, renderDrafts(drafts)),
    }), {
      writeJson: (content) => writeArtifact(context, "issueDrafts", content),
      writeMarkdown: (content) => writeArtifact(context, "issueDraftsMarkdown", content),
    });

    const drafts = artifact.value;
    const renderedById = renderDrafts(drafts);

    const createdCurrentRun: IssueCreationCreatedEntry[] = [];
    const failed: IssueCreationFailedEntry[] = [];
    for (const draft of drafts.issues) {
      const item = itemsById.get(draft.planItemId);
      if (!item) throw new Error(`Structured issue draft referenced unknown planItemId '${draft.planItemId}'.`);
      const rendered = renderedById.get(draft.planItemId);
      if (!rendered) throw new Error(`Structured issue draft '${draft.planItemId}' was not rendered.`);
      try {
        const published = await issuePublisher({
          cwd: context.agentCwd,
          repo: context.repo,
          title: rendered.title,
          body: rendered.body,
          labels: labelsForPlanItem(item),
        });
        createdCurrentRun.push({
          planItemId: item.planItemId,
          kind: item.kind,
          title: rendered.title,
          url: published.url,
          ...(published.number !== undefined ? { number: published.number } : {}),
          ...(published.stdout ? { stdout: published.stdout } : {}),
          source: "current-run",
        });
      } catch (error) {
        failed.push({
          planItemId: item.planItemId,
          kind: item.kind,
          title: rendered.title,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { createdCurrentRun, failed, relationshipOutcomes: [] };
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

function renderIssueDrafts(
  drafts: IssueDraftCollection,
  itemsById: ReadonlyMap<string, ValidPlanItem>,
  localRoots: readonly string[],
): Map<string, { title: string; body: string }> {
  return new Map(drafts.issues.map((draft) => {
    const item = itemsById.get(draft.planItemId);
    if (!item) throw new Error(`Structured issue draft referenced unknown planItemId '${draft.planItemId}'.`);
    return [draft.planItemId, {
      title: sanitizePublicMarkdown(draft.title, { localRoots }),
      body: sanitizePublicMarkdown(formatIssueDraftMarkdown(draft, item.renderingContext), { localRoots }),
    }] as const;
  }));
}

function formatIssueDraftCollectionMarkdown(
  drafts: IssueDraftCollection,
  renderedById: ReadonlyMap<string, { title: string; body: string }>,
): string {
  return drafts.issues.map((draft) => {
    const rendered = renderedById.get(draft.planItemId);
    if (!rendered) throw new Error(`Structured issue draft '${draft.planItemId}' was not rendered.`);
    return [`# ${rendered.title}`, "", rendered.body].join("\n");
  }).join("\n---\n\n");
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
    presenter().warning(`could not parse existing ${artifactRelativePath(context, "issueCreationResults")}; rerun idempotence will not use it: ${error instanceof Error ? error.message : String(error)}`);
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
  const renderingContext = parseIssueDraftRenderingContext(raw, kind);
  const missing = [
    ...(planItemId ? [] : ["planItemId"]),
    ...(title ? [] : ["proposedTitle"]),
    ...(renderingContext ? [] : ["structured issue context"]),
  ];
  if (missing.length > 0 || !planItemId || !title || !renderingContext) {
    return { skipped: malformedSkip(planItemId ?? fallbackId, kind, title, `Missing required field(s): ${missing.join(", ")}.`) };
  }
  const { proposedLabels } = raw;

  return {
    item: {
      kind,
      planItemId,
      title,
      labels: Array.isArray(proposedLabels) ? proposedLabels.filter((label): label is string => typeof label === "string") : [],
      renderingContext,
    },
  };
}

function parseIssueDraftRenderingContext(value: Record<string, unknown>, kind: IssuePlanKind): IssueDraftRenderingContext | undefined {
  const sourceIssue = value["sourceIssueContext"];
  const runContext = value["runContext"];
  if (!isStringArray(value["sourceFindingIds"])
    || !isStringArray(value["reviewerSources"])
    || !isRecord(sourceIssue)
    || typeof sourceIssue["number"] !== "number"
    || !Number.isInteger(sourceIssue["number"])
    || typeof sourceIssue["title"] !== "string"
    || !isRecord(runContext)
    || typeof runContext["runDirRelative"] !== "string"
    || !isStringArray(runContext["artifactPaths"])) return undefined;
  const sourceUrl = asNonEmptyString(sourceIssue["url"]);
  const relatedPrUrl = asNonEmptyString(runContext["prUrl"]);
  const attempt = typeof runContext["attempt"] === "number" && Number.isInteger(runContext["attempt"])
    ? runContext["attempt"]
    : undefined;
  return {
    sourceIssue: {
      number: sourceIssue["number"],
      title: sourceIssue["title"],
      ...(sourceUrl ? { url: sourceUrl } : {}),
    },
    ...(relatedPrUrl ? { relatedPrUrl } : {}),
    classification: classificationForKind(kind),
    sourceFindingIds: value["sourceFindingIds"],
    reviewerSources: value["reviewerSources"],
    ...(attempt !== undefined ? { attempt } : {}),
  };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
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
  const managedLabels = new Set<string>(reviewerIssueManagedLabels.map((label) => label.toLowerCase()));
  const additionalLabels = item.labels.filter((label) => !managedLabels.has(label.trim().toLowerCase()));
  return normalizeLabels([
    ...reviewerIssueTriageLabels,
    reviewerIssueLabelForClassification(classificationForKind(item.kind)),
    ...additionalLabels,
  ]);
}

function classificationForKind(kind: IssuePlanKind): IssuePlanClassification {
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
  presenter().line(`Dry run: create issues from ${result.sourcePlanPath}`);
  presenter().line("No GitHub issues were created. Pass --yes to create approved plan items.");
  presenter().line(`Target repo: ${context.repo ?? "gh default repository"}`);
  if (result.wouldCreate.length === 0) {
    presenter().line(`No approved plan items would be created. ${zeroCreatedExplanation(result)}`);
  } else {
    for (const item of result.wouldCreate) {
      presenter().line(`- ${item.planItemId} [${item.kind}]: ${item.title}`);
      presenter().line(`labels: ${item.labels.join(", ")}`);
    }
  }
  printSkippedCounts(result);
}

function printApprovedSummary(context: WorkflowContext, result: IssueCreationResults): void {
  presenter().line(`Issue creation: wrote ${artifactRelativePath(context, "issueCreationResults")}`);
  presenter().line(`Created this run: ${result.counts.createdCurrentRun}; failed: ${result.failed.length}; skipped already-created: ${result.counts.skippedAlreadyCreated}; malformed: ${result.counts.skippedMalformed}.`);
  if (result.counts.createdCurrentRun === 0) presenter().line(`Zero created explanation: ${zeroCreatedExplanation(result)}`);
  for (const entry of result.created.filter((created) => created.source === "current-run")) {
    presenter().line(`- created ${entry.planItemId}${entry.url ? `: ${entry.url}` : ""}`);
  }
  for (const entry of result.failed) {
    presenter().line(`- failed ${entry.planItemId}: ${entry.message}`);
  }
  printSkippedCounts(result);
}

function printSkippedCounts(result: IssueCreationResults): void {
  presenter().line(`Skipped rejected candidates: ${result.counts.skippedRejectedCandidates}; duplicate groups: ${result.counts.skippedDuplicateGroups}; plan warnings: ${result.counts.skippedParserWarnings}.`);
}

function zeroCreatedExplanation(result: IssueCreationResults): string {
  if (result.counts.acceptedPlanItems === 0) {
    if (result.counts.skippedParserWarnings > 0) return "No accepted candidates were found; review warnings and missing artifacts in the curation plan.";
    if (result.counts.skippedRejectedCandidates > 0) return "All reviewer findings were rejected by curation policy; inspect rejectedCandidates for reasons.";
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

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
