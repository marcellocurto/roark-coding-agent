import { RunObservation } from "../observability/observer.ts";
import {
  readIssueCurationPlan,
  readExistingCreatedEntries,
  classificationForKind,
  type PublishingPlan,
  type ValidPlanItem,
  type IssuePlanKind,
  type IssueCreationCreatedEntry,
  type IssueCreationSkippedEntry,
} from "./persistence.ts";
import { IssuePublishing } from "../issue-publishing/service.ts";
import { Presentation } from "../runtime/services.ts";
import { DateTime, Effect } from "effect";
import {
  issuePublishingPrompt,
  issuePublishingSystemPrompt,
} from "../prompts/issue-publishing-prompt.ts";
import {
  formatIssueDraftMarkdown,
  type IssueDraftCollection,
} from "../issue-publishing/result.ts";
import { issueDraftArtifactDefinition } from "../issue-publishing/artifact.ts";
import { type AgentDisplayContext } from "../presentation/presenter.ts";
import { runPresentedPhase } from "../presentation/phase.ts";
import { createAgentRunRequest } from "../workflow/agent-runner.ts";
import {
  artifactAgentPath,
  artifactRelativePath,
  type WorkflowContext,
} from "../workflow/artifacts.ts";
import { writeArtifact, writeJsonArtifact } from "../workflow/artifacts.ts";
import type { IssueCurationPlan } from "../workflow/issue-curation.ts";
import {
  reviewerIssueLabelForClassification,
  reviewerIssueManagedLabels,
  reviewerIssueTriageLabels,
} from "./labels.ts";
import { sanitizePublicMarkdown } from "../autorun/public-output.ts";
import { runStructuredArtifact } from "../structured-output/runner.ts";
export interface IssueCreationFailedEntry {
  planItemId: string;
  kind: IssuePlanKind;
  title: string;
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
  approved?: boolean | undefined;
  approvalReason?: string | undefined;
}
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
  const { context } = options;
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
  const skipped: IssueCreationSkippedEntry[] = [...plan.malformed];
  const existingCreatedIds = new Set(
    existingCreated.map((entry) => entry.planItemId),
  );
  const creatable = plan.valid.filter((item) => {
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
      generatedAt: DateTime.formatIso(yield* DateTime.now),
      dryRun: true,
      approved: false,
      existingCreated,
      createdCurrentRun: [],
      failed: [],
      skipped,
      wouldCreate,
      relationshipOutcomes: [],
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
        generatedAt: DateTime.formatIso(yield* DateTime.now),
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
      generatedAt: DateTime.formatIso(yield* DateTime.now),
      dryRun: false,
      approved: true,
      existingCreated,
      createdCurrentRun: publishResult.createdCurrentRun,
      failed: publishResult.failed,
      skipped,
      wouldCreate: [],
      relationshipOutcomes: publishResult.relationshipOutcomes,
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
        createAgentRunRequest(context, "issuePublishing", {
          cwd: context.agentCwd,
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
          observer: yield* RunObservation,
          display,
        }),
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
function buildResult(input: {
  context: WorkflowContext;
  plan: PublishingPlan;
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
      ...input.plan.counts,
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
