import { decodeJson } from "../workflow/validation.ts";
import { IssuePublishing } from "../issue-publishing/service.ts";
import { Presentation } from "../runtime/services.ts";
import { Effect, Schema } from "effect";
import {
  issuePublishingPrompt,
  issuePublishingSystemPrompt,
} from "../prompts/issue-publishing-prompt.ts";
import {
  formatIssueDraftMarkdown,
  type IssueDraftCollection,
  type IssueDraftRenderingContext,
} from "../issue-publishing/result.ts";
import { issueDraftArtifactDefinition } from "../issue-publishing/artifact.ts";
import { type AgentDisplayContext } from "../presentation/presenter.ts";
import { runPresentedPhase } from "../presentation/phase.ts";
import { effectiveModelForStage } from "../workflow/model-routing.ts";
import {
  artifactAgentPath,
  artifactRelativePath,
  type WorkflowContext,
} from "../workflow/artifacts.ts";
import { artifactExists } from "../workflow/artifacts.ts";
import {
  readArtifact,
  writeArtifact,
  writeJsonArtifact,
} from "../workflow/artifacts.ts";
import type {
  IssueCurationPlan,
  IssuePlanClassification,
} from "../workflow/issue-curation.ts";
import {
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
  url?: string | undefined;
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
  url?: string | undefined;
}
export interface IssueCreationResults {
  version: 1;
  generatedAt: string;
  dryRun: boolean;
  approved: boolean;
  sourcePlanPath: string;
  resultPath: string;
  repo?: string | undefined;
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
  clock?:
    | {
        now(): Date;
      }
    | undefined;
  approved?: boolean | undefined;
  approvalReason?: string | undefined;
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
export const createIssuesPhase = Effect.fn("createIssuesPhase")(function* (
  context: WorkflowContext,
) {
  const result = yield* createIssuesFromCurationPlan({ context });
  if (context.yes && result.failed.length > 0) {
    return yield* Effect.fail(
      new Error(
        `Issue creation failed for ${result.failed.length} plan item(s). See ${artifactRelativePath(context, "issueCreationResults")}.`,
      ),
    );
  }
  return result;
});
export const createIssuesFromCurationPlan = Effect.fn(
  "createIssuesFromCurationPlan",
)(function* (options: CreateIssuesOptions) {
  const { context, clock = issueCreationDefaultClock } = options;
  const publishing = yield* IssuePublishing;
  const approved = options.approved ?? context.yes;
  const approvalReason =
    options.approvalReason ??
    (context.yes
      ? "The user passed --yes"
      : "An internal caller explicitly approved publishing");
  const plan = yield* readIssueCurationPlan(context);
  const sourcePlanPath = artifactRelativePath(context, "issueCurationPlan");
  const resultPath = artifactRelativePath(context, "issueCreationResults");
  const existingCreated = yield* readExistingCreatedEntries(context);
  const collected = collectPlanItems(plan);
  const skipped: IssueCreationSkippedEntry[] = [...collected.malformed];
  const existingCreatedIds = new Set(
    existingCreated.map((entry) => entry.planItemId),
  );
  const creatable = collected.valid.filter((item) => {
    if (!context.force && existingCreatedIds.has(item.planItemId)) {
      skipped.push({
        planItemId: item.planItemId,
        kind: item.kind,
        title: item.title,
        reason: "already-created",
        message:
          "Skipped because issue-creation-results.json already records this plan item as created. Pass --force to create it again.",
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
    yield* printDryRunSummary(context, result);
    return result;
  }
  if (creatable.length > 0) {
    const ensured = yield* publishing
      .ensureLabels({ cwd: context.agentCwd, repo: context.repo })
      .pipe(Effect.result);
    if (ensured._tag === "Failure") {
      const error = ensured.failure;
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
        failed: creatable.map((item) => ({
          planItemId: item.planItemId,
          kind: item.kind,
          title: item.title,
          message,
        })),
        skipped,
        wouldCreate: [],
        relationshipOutcomes: [],
        countsInput: collected.counts,
      });
      yield* writeJsonArtifact(context, "issueCreationResults", result);
      yield* printApprovedSummary(context, result);
      return result;
    }
  }
  const display: AgentDisplayContext | undefined =
    creatable.length === 0
      ? undefined
      : {
          command: context.displayCommand ?? "create-issues",
          repository: context.repo,
          target: `#${context.issueNumber}`,
          phaseId: "issue-publishing",
          phaseLabel: "Author and create issues",
          expectedArtifact: resultPath,
          operation: "publish",
        };
  const create = Effect.fnUntraced(function* () {
    const publishResult =
      display === undefined
        ? { createdCurrentRun: [], failed: [], relationshipOutcomes: [] }
        : yield* authorAndPublishIssues({
            context,
            promptSourcePlanPath: artifactAgentPath(
              context,
              "issueCurationPlan",
            ),
            creatable,
            approvalReason,
            display,
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
    yield* writeJsonArtifact(context, "issueCreationResults", result);
    return result;
  });
  const result = display
    ? yield* runPresentedPhase(
        display,
        create,
        (created) => ({
          outcome: `created ${created.counts.createdCurrentRun}, failed ${created.failed.length}`,
          artifact: resultPath,
          failed: created.failed.length > 0,
        }),
        undefined,
      )
    : yield* create();
  yield* printApprovedSummary(context, result);
  return result;
});

const authorAndPublishIssues = Effect.fn("authorAndPublishIssues")(
  function* (input: {
    context: WorkflowContext;
    promptSourcePlanPath: string;
    creatable: ValidPlanItem[];
    approvalReason: string;
    display: AgentDisplayContext;
  }) {
    const {
      context,
      promptSourcePlanPath,
      creatable,
      approvalReason,
      display,
    } = input;
    return yield* Effect.gen(function* () {
      const itemsById = new Map(
        creatable.map((item) => [item.planItemId, item]),
      );
      const localRoots = [context.controlCwd, context.agentCwd];
      const renderDrafts = (drafts: IssueDraftCollection) =>
        renderIssueDrafts(drafts, itemsById, localRoots);
      const artifact = yield* runStructuredArtifact(
        {
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
        },
        issueDraftArtifactDefinition({
          expectedPlanItemIds: creatable.map((item) => item.planItemId),
          formatMarkdown: (drafts) =>
            formatIssueDraftCollectionMarkdown(drafts, renderDrafts(drafts)),
        }),
        {
          writeJson: (content) =>
            writeArtifact(context, "issueDrafts", content),
          writeMarkdown: (content) =>
            writeArtifact(context, "issueDraftsMarkdown", content),
        },
      );
      const drafts = artifact.value;
      const renderedById = renderDrafts(drafts);
      const createdCurrentRun: IssueCreationCreatedEntry[] = [];
      const failed: IssueCreationFailedEntry[] = [];
      for (const draft of drafts.issues) {
        const item = itemsById.get(draft.planItemId);
        if (!item)
          return yield* Effect.fail(
            new Error(
              `Structured issue draft referenced unknown planItemId '${draft.planItemId}'.`,
            ),
          );
        const rendered = renderedById.get(draft.planItemId);
        if (!rendered)
          return yield* Effect.fail(
            new Error(
              `Structured issue draft '${draft.planItemId}' was not rendered.`,
            ),
          );
        yield* Effect.gen(function* () {
          const published = yield* (yield* IssuePublishing).publish({
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
            ...(published.number !== undefined
              ? { number: published.number }
              : {}),
            ...(published.stdout ? { stdout: published.stdout } : {}),
            source: "current-run",
          });
        }).pipe(
          Effect.catch((error) =>
            Effect.gen(function* () {
              failed.push({
                planItemId: item.planItemId,
                kind: item.kind,
                title: rendered.title,
                message: error instanceof Error ? error.message : String(error),
              });
            }),
          ),
        );
      }
      return { createdCurrentRun, failed, relationshipOutcomes: [] };
    }).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
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
        }),
      ),
    );
  },
);
function renderIssueDrafts(
  drafts: IssueDraftCollection,
  itemsById: ReadonlyMap<string, ValidPlanItem>,
  localRoots: readonly string[],
): Map<
  string,
  {
    title: string;
    body: string;
  }
> {
  return new Map(
    drafts.issues.map((draft) => {
      const item = itemsById.get(draft.planItemId);
      if (!item)
        throw new Error(
          `Structured issue draft referenced unknown planItemId '${draft.planItemId}'.`,
        );
      return [
        draft.planItemId,
        {
          title: sanitizePublicMarkdown(draft.title, { localRoots }),
          body: sanitizePublicMarkdown(
            formatIssueDraftMarkdown(draft, item.renderingContext),
            { localRoots },
          ),
        },
      ] as const;
    }),
  );
}
function formatIssueDraftCollectionMarkdown(
  drafts: IssueDraftCollection,
  renderedById: ReadonlyMap<
    string,
    {
      title: string;
      body: string;
    }
  >,
): string {
  return drafts.issues
    .map((draft) => {
      const rendered = renderedById.get(draft.planItemId);
      if (!rendered)
        throw new Error(
          `Structured issue draft '${draft.planItemId}' was not rendered.`,
        );
      return [`# ${rendered.title}`, "", rendered.body].join("\n");
    })
    .join("\n---\n\n");
}
// Plan entries are validated individually below so malformed candidates remain
// reportable skips instead of making the entire plan unreadable.
const persistedPlanSchema = Schema.Struct({
  sourceIssue: Schema.optional(
    Schema.Struct({
      number: Schema.Number,
      title: Schema.String,
      url: Schema.optional(Schema.String),
    }),
  ),
  issuesToCreate: Schema.optional(Schema.Unknown),
  blockingIssuesToCreate: Schema.optional(Schema.Unknown),
  followUpIssuesToCreate: Schema.optional(Schema.Unknown),
  rejectedCandidates: Schema.optional(Schema.Unknown),
  duplicatesMerged: Schema.optional(Schema.Unknown),
  warnings: Schema.optional(Schema.Unknown),
});
type PersistedPlan = typeof persistedPlanSchema.Type;
const decodePersistedPlan = Schema.decodeUnknownEffect(
  Schema.fromJsonString(persistedPlanSchema),
);
const readIssueCurationPlan = Effect.fn("readIssueCurationPlan")(function* (
  context: WorkflowContext,
) {
  if (!(yield* artifactExists(context, "issueCurationPlan"))) {
    return yield* Effect.fail(
      new Error(
        `Missing issue curation plan: ${artifactRelativePath(context, "issueCurationPlan")}. Run 'curate-issues' first.`,
      ),
    );
  }
  return yield* Effect.gen(function* () {
    return yield* decodePersistedPlan(
      yield* readArtifact(context, "issueCurationPlan"),
    );
  }).pipe(
    Effect.catch((error) =>
      Effect.gen(function* () {
        return yield* Effect.fail(
          new Error(
            `Could not parse ${artifactRelativePath(context, "issueCurationPlan")}: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      }),
    ),
  );
});
const readExistingCreatedEntries = Effect.fn("readExistingCreatedEntries")(
  function* (context: WorkflowContext) {
    if (!(yield* artifactExists(context, "issueCreationResults"))) return [];
    return yield* Effect.gen(function* () {
      const parsed = yield* decodeJson(
        yield* readArtifact(context, "issueCreationResults"),
      );
      if (!isRecord(parsed) || !Array.isArray(parsed["created"])) return [];
      return parsed["created"].flatMap((entry) => {
        if (!isRecord(entry)) return [];
        const planItemId = asNonEmptyString(entry["planItemId"]);
        const title = asNonEmptyString(entry["title"]);
        const kind = parseIssuePlanKind(entry["kind"]);
        if (!planItemId || !title || !kind) return [];
        return [
          {
            planItemId,
            kind,
            title,
            ...(asNonEmptyString(entry["url"])
              ? { url: asNonEmptyString(entry["url"]) }
              : {}),
            ...(typeof entry["number"] === "number" &&
            Number.isInteger(entry["number"])
              ? { number: entry["number"] }
              : {}),
            ...(asNonEmptyString(entry["stdout"])
              ? { stdout: asNonEmptyString(entry["stdout"]) }
              : {}),
            source: "existing-result" as const,
          },
        ];
      });
    }).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          (yield* Presentation).warning(
            `could not parse existing ${artifactRelativePath(context, "issueCreationResults")}; rerun idempotence will not use it: ${error instanceof Error ? error.message : String(error)}`,
          );
          return [];
        }),
      ),
    );
  },
);
function collectPlanItems(plan: PersistedPlan): {
  valid: ValidPlanItem[];
  malformed: IssueCreationSkippedEntry[];
  counts: Pick<
    IssueCreationResults["counts"],
    | "acceptedPlanItems"
    | "skippedRejectedCandidates"
    | "skippedDuplicateGroups"
    | "skippedDuplicateSourceFindings"
    | "skippedParserWarnings"
    | "skippedMalformed"
  >;
} {
  const normalized = Array.isArray(plan.issuesToCreate)
    ? asArray(plan.issuesToCreate)
    : undefined;
  const classificationMalformed: IssueCreationSkippedEntry[] = [];
  const accepted = Array.isArray(normalized)
    ? normalized.flatMap((item, index) => {
        const record = isRecord(item) ? item : undefined;
        const classification = parseIssuePlanClassification(
          record?.["classification"],
        );
        if (!classification) {
          classificationMalformed.push(
            malformedSkip(
              record
                ? (asNonEmptyString(record["planItemId"]) ??
                    `unclassified-${index + 1}`)
                : `unclassified-${index + 1}`,
              "unknown",
              record ? asNonEmptyString(record["proposedTitle"]) : undefined,
              "Missing or invalid required field(s): classification. Expected one of: external-blocker, follow-up, suggestion.",
            ),
          );
          return [];
        }
        return [{ raw: item, kind: classification, index }];
      })
    : [
        ...asArray(plan.blockingIssuesToCreate).map((item, index) => ({
          raw: item,
          kind: "blocking" as const,
          index,
        })),
        ...asArray(plan.followUpIssuesToCreate).map((item, index) => ({
          raw: item,
          kind: "follow-up" as const,
          index,
        })),
      ];
  const acceptedPlanItemCount = Array.isArray(normalized)
    ? normalized.length
    : accepted.length;
  const valid: ValidPlanItem[] = [];
  const malformed: IssueCreationSkippedEntry[] = [...classificationMalformed];
  for (const entry of accepted) {
    const parsed = parseValidPlanItem(entry.raw, entry.kind, entry.index);
    if ("item" in parsed) valid.push(parsed.item);
    else malformed.push(parsed.skipped);
  }
  const rejectedCandidates = asArray(plan.rejectedCandidates);
  const duplicatesMerged = asArray(plan.duplicatesMerged);
  const warnings = asArray(plan.warnings);
  return {
    valid,
    malformed,
    counts: {
      acceptedPlanItems: acceptedPlanItemCount,
      skippedRejectedCandidates: rejectedCandidates.length,
      skippedDuplicateGroups: duplicatesMerged.length,
      skippedDuplicateSourceFindings: duplicatesMerged.reduce<number>(
        (total, group) => {
          const ids =
            isRecord(group) && Array.isArray(group["mergedSourceFindingIds"])
              ? group["mergedSourceFindingIds"]
              : [];
          return total + ids.length;
        },
        0,
      ),
      skippedParserWarnings: warnings.length,
      skippedMalformed: malformed.length,
    },
  };
}
function parseValidPlanItem(
  raw: unknown,
  kind: IssuePlanKind,
  index: number,
):
  | {
      item: ValidPlanItem;
    }
  | {
      skipped: IssueCreationSkippedEntry;
    } {
  const fallbackId = `${kind}-${index + 1}`;
  if (!isRecord(raw)) {
    return {
      skipped: malformedSkip(
        fallbackId,
        kind,
        undefined,
        "Plan entry is not an object.",
      ),
    };
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
    return {
      skipped: malformedSkip(
        planItemId ?? fallbackId,
        kind,
        title,
        `Missing required field(s): ${missing.join(", ")}.`,
      ),
    };
  }
  const { proposedLabels } = raw;
  return {
    item: {
      kind,
      planItemId,
      title,
      labels: Array.isArray(proposedLabels)
        ? proposedLabels.filter(
            (label): label is string => typeof label === "string",
          )
        : [],
      renderingContext,
    },
  };
}
function parseIssueDraftRenderingContext(
  value: Record<string, unknown>,
  kind: IssuePlanKind,
): IssueDraftRenderingContext | undefined {
  const sourceIssue = value["sourceIssueContext"];
  const runContext = value["runContext"];
  if (
    !isStringArray(value["sourceFindingIds"]) ||
    !isStringArray(value["reviewerSources"]) ||
    !isRecord(sourceIssue) ||
    typeof sourceIssue["number"] !== "number" ||
    !Number.isInteger(sourceIssue["number"]) ||
    typeof sourceIssue["title"] !== "string" ||
    !isRecord(runContext) ||
    typeof runContext["runDirRelative"] !== "string" ||
    !isStringArray(runContext["artifactPaths"])
  )
    return undefined;
  const sourceUrl = asNonEmptyString(sourceIssue["url"]);
  const relatedPrUrl = asNonEmptyString(runContext["prUrl"]);
  const attempt =
    typeof runContext["attempt"] === "number" &&
    Number.isInteger(runContext["attempt"])
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
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}
function malformedSkip(
  planItemId: string,
  kind: IssueCreationSkippedKind,
  title: string | undefined,
  message: string,
): IssueCreationSkippedEntry {
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
function parseIssuePlanClassification(
  value: unknown,
): IssuePlanClassification | undefined {
  return reviewerIssueClassificationLabels.find((label) => label === value);
}
function buildResult(input: {
  context: WorkflowContext;
  plan: PersistedPlan;
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
  countsInput: Pick<
    IssueCreationResults["counts"],
    | "acceptedPlanItems"
    | "skippedRejectedCandidates"
    | "skippedDuplicateGroups"
    | "skippedDuplicateSourceFindings"
    | "skippedParserWarnings"
    | "skippedMalformed"
  >;
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
      skippedAlreadyCreated: input.skipped.filter(
        (entry) => entry.reason === "already-created",
      ).length,
    },
  };
}
function labelsForPlanItem(
  item: Pick<ValidPlanItem, "kind" | "labels">,
): string[] {
  const managedLabels = new Set<string>(
    reviewerIssueManagedLabels.map((label) => label.toLowerCase()),
  );
  const additionalLabels = item.labels.filter(
    (label) => !managedLabels.has(label.trim().toLowerCase()),
  );
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
const printDryRunSummary = Effect.fnUntraced(function* (
  context: WorkflowContext,
  result: IssueCreationResults,
) {
  (yield* Presentation).line(
    `Dry run: create issues from ${result.sourcePlanPath}`,
  );
  (yield* Presentation).line(
    "No GitHub issues were created. Pass --yes to create approved plan items.",
  );
  (yield* Presentation).line(
    `Target repo: ${context.repo ?? "gh default repository"}`,
  );
  if (result.wouldCreate.length === 0) {
    (yield* Presentation).line(
      `No approved plan items would be created. ${zeroCreatedExplanation(result)}`,
    );
  } else {
    for (const item of result.wouldCreate) {
      (yield* Presentation).line(
        `- ${item.planItemId} [${item.kind}]: ${item.title}`,
      );
      (yield* Presentation).line(`labels: ${item.labels.join(", ")}`);
    }
  }
  yield* printSkippedCounts(result);
});
const printApprovedSummary = Effect.fnUntraced(function* (
  context: WorkflowContext,
  result: IssueCreationResults,
) {
  (yield* Presentation).line(
    `Issue creation: wrote ${artifactRelativePath(context, "issueCreationResults")}`,
  );
  (yield* Presentation).line(
    `Created this run: ${result.counts.createdCurrentRun}; failed: ${result.failed.length}; skipped already-created: ${result.counts.skippedAlreadyCreated}; malformed: ${result.counts.skippedMalformed}.`,
  );
  if (result.counts.createdCurrentRun === 0)
    (yield* Presentation).line(
      `Zero created explanation: ${zeroCreatedExplanation(result)}`,
    );
  for (const entry of result.created.filter(
    (created) => created.source === "current-run",
  )) {
    (yield* Presentation).line(
      `- created ${entry.planItemId}${entry.url ? `: ${entry.url}` : ""}`,
    );
  }
  for (const entry of result.failed) {
    (yield* Presentation).line(
      `- failed ${entry.planItemId}: ${entry.message}`,
    );
  }
  yield* printSkippedCounts(result);
});
const printSkippedCounts = Effect.fnUntraced(function* (
  result: IssueCreationResults,
) {
  (yield* Presentation).line(
    `Skipped rejected candidates: ${result.counts.skippedRejectedCandidates}; duplicate groups: ${result.counts.skippedDuplicateGroups}; plan warnings: ${result.counts.skippedParserWarnings}.`,
  );
});
function zeroCreatedExplanation(result: IssueCreationResults): string {
  if (result.counts.acceptedPlanItems === 0) {
    if (result.counts.skippedParserWarnings > 0)
      return "No accepted candidates were found; review warnings and missing artifacts in the curation plan.";
    if (result.counts.skippedRejectedCandidates > 0)
      return "All reviewer findings were rejected by curation policy; inspect rejectedCandidates for reasons.";
    return "The curation plan contains no accepted reviewer findings.";
  }
  if (result.counts.skippedAlreadyCreated >= result.counts.acceptedPlanItems)
    return "All accepted plan items were already recorded as created; use --force only if you intentionally want duplicates.";
  if (result.counts.skippedMalformed > 0)
    return "Accepted plan items were malformed and skipped; inspect skipped entries in issue-creation-results.json.";
  if (result.failed.length > 0)
    return "Publishing or label setup failed; inspect failed entries in issue-creation-results.json.";
  return "No creatable plan items remained after idempotence and validation checks.";
}
function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : undefined;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
