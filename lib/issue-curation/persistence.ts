import { Cause, Effect, Option, Schema, type PlatformError } from "effect";
import { ArtifactContractError } from "../structured-output/contract.ts";
import { Presentation } from "../runtime/services.ts";
import {
  artifactExists,
  artifactRelativePath,
  readArtifact,
  type WorkflowContext,
} from "../workflow/artifacts.ts";
import {
  reviewerIssueClassificationLabels,
  type ReviewerIssueClassificationLabel,
} from "./labels.ts";
import type { IssueDraftRenderingContext } from "../issue-publishing/result.ts";

const classificationSchema = Schema.Literals(reviewerIssueClassificationLabels);
const planKindSchema = Schema.Literals([
  "blocking",
  ...reviewerIssueClassificationLabels,
]);
export type IssuePlanKind = typeof planKindSchema.Type;
export interface IssueCreationSkippedEntry {
  planItemId: string;
  kind: IssuePlanKind | "unknown";
  title?: string | undefined;
  reason: "already-created" | "malformed";
  message: string;
}
export interface ValidPlanItem {
  kind: IssuePlanKind;
  planItemId: string;
  title: string;
  labels: string[];
  renderingContext: IssueDraftRenderingContext;
}

const storedText = Schema.Trim.check(Schema.isMinLength(1));
// Optional metadata is salvageable: a malformed URL or count must not discard a
// valid published identity and cause an already-created issue to be published again.
function optionalStoredField<S extends Schema.Constraint>(schema: S) {
  return Schema.optional(schema).pipe(
    Schema.catchDecoding(() => Effect.succeed(Option.some(undefined))),
  );
}
const storedArray = optionalStoredField(Schema.Array(Schema.Unknown));
const sourceIssueSchema = Schema.Struct({
  number: Schema.Int,
  title: Schema.String,
  url: Schema.optional(Schema.String),
});
// Decode candidates separately: older plans use split arrays, and damaged rows
// must remain reportable skips rather than invalidate their valid neighbors.
const planEnvelopeSchema = Schema.Struct({
  sourceIssue: Schema.optional(sourceIssueSchema),
  issuesToCreate: storedArray,
  blockingIssuesToCreate: storedArray,
  followUpIssuesToCreate: storedArray,
  rejectedCandidates: storedArray,
  duplicatesMerged: storedArray,
  warnings: storedArray,
});
const decodePlanEnvelope = Schema.decodeUnknownEffect(
  Schema.fromJsonString(planEnvelopeSchema),
);
const rowMetadataSchema = Schema.Struct({
  planItemId: optionalStoredField(storedText),
  proposedTitle: optionalStoredField(storedText),
  classification: optionalStoredField(classificationSchema),
  proposedLabels: storedArray,
});
const decodeRowMetadata = Schema.decodeUnknownEffect(rowMetadataSchema);
const renderingContextSchema = Schema.Struct({
  sourceFindingIds: Schema.mutable(Schema.Array(Schema.String)),
  reviewerSources: Schema.mutable(Schema.Array(Schema.String)),
  sourceIssueContext: Schema.Struct({
    number: Schema.Int,
    title: Schema.String,
    url: optionalStoredField(storedText),
  }),
  runContext: Schema.Struct({
    runDirRelative: Schema.String,
    artifactPaths: Schema.Array(Schema.String),
    attempt: optionalStoredField(Schema.Int),
    prUrl: optionalStoredField(storedText),
  }),
});
const decodeRenderingContext = Schema.decodeUnknownEffect(
  renderingContextSchema,
);
const decodeDuplicateGroup = Schema.decodeUnknownEffect(
  Schema.Struct({ mergedSourceFindingIds: storedArray }),
);
const createdEntrySchema = Schema.Struct({
  planItemId: storedText,
  kind: planKindSchema,
  title: storedText,
  url: optionalStoredField(storedText),
  number: optionalStoredField(Schema.Int),
  stdout: optionalStoredField(storedText),
});
export type IssueCreationCreatedEntry = typeof createdEntrySchema.Type & {
  source: "current-run" | "existing-result";
};
const decodeCreatedEntry = Schema.decodeUnknownEffect(createdEntrySchema);
const decodeHistory = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ created: storedArray })),
);

export const readIssueCurationPlan = Effect.fn("readIssueCurationPlan")(
  function* (context: WorkflowContext) {
    const path = artifactRelativePath(context, "issueCurationPlan");
    if (!(yield* artifactExists(context, "issueCurationPlan"))) {
      return yield* Effect.fail(
        new ArtifactContractError({
          artifact: "issueCurationPlan",
          message: `Missing issue curation plan: ${path}. Run 'curate-issues' first.`,
        }),
      );
    }
    const plan = yield* decodePlanEnvelope(
      yield* readArtifact(context, "issueCurationPlan"),
    ).pipe(
      Effect.mapError(
        (cause) =>
          new ArtifactContractError({
            artifact: "issueCurationPlan",
            message: `Could not parse ${path}: ${cause.message}`,
            cause,
          }),
      ),
    );
    return {
      sourceIssue: plan.sourceIssue,
      ...(yield* collectPlanItems(plan)),
    };
  },
);
export type PublishingPlan = Effect.Success<
  ReturnType<typeof readIssueCurationPlan>
>;

export const readExistingCreatedEntries = Effect.fn(
  "readExistingCreatedEntries",
)(function* (context: WorkflowContext) {
  if (!(yield* artifactExists(context, "issueCreationResults"))) return [];
  return yield* Effect.gen(function* () {
    const history = yield* decodeHistory(
      yield* readArtifact(context, "issueCreationResults"),
    );
    const entries: IssueCreationCreatedEntry[] = [];
    for (const raw of history.created ?? []) {
      const decoded = yield* decodeCreatedEntry(raw).pipe(Effect.option);
      if (Option.isNone(decoded)) continue;
      const { planItemId, kind, title, url, number, stdout } = decoded.value;
      entries.push({
        planItemId,
        kind,
        title,
        ...(url ? { url } : {}),
        ...(number !== undefined ? { number } : {}),
        ...(stdout ? { stdout } : {}),
        source: "existing-result",
      });
    }
    return entries;
  }).pipe(
    Effect.catchCauseIf(
      (cause) => !Cause.hasDies(cause) && !Cause.hasInterrupts(cause),
      Effect.fnUntraced(function* (
        cause: Cause.Cause<Schema.SchemaError | PlatformError.PlatformError>,
      ) {
        const message = Option.match(Cause.findErrorOption(cause), {
          onSome: (error) => error.message,
          onNone: () => Cause.pretty(cause),
        });
        (yield* Presentation).warning(
          `could not parse existing ${artifactRelativePath(context, "issueCreationResults")}; rerun idempotence will not use it: ${message}`,
        );
        return [];
      }),
    ),
  );
});

const collectPlanItems = Effect.fnUntraced(function* (
  plan: typeof planEnvelopeSchema.Type,
) {
  const accepted: {
    raw: unknown;
    kind: IssuePlanKind;
    index: number;
    metadata: Option.Option<typeof rowMetadataSchema.Type>;
  }[] = [];
  const malformed: IssueCreationSkippedEntry[] = [];
  if (plan.issuesToCreate !== undefined) {
    for (const [index, raw] of plan.issuesToCreate.entries()) {
      const metadata = yield* decodeRowMetadata(raw).pipe(Effect.option);
      const row = Option.getOrUndefined(metadata);
      if (row?.classification === undefined) {
        malformed.push(
          malformedSkip(
            row?.planItemId ?? `unclassified-${index + 1}`,
            "unknown",
            row?.proposedTitle,
            "Missing or invalid required field(s): classification. Expected one of: external-blocker, follow-up, suggestion.",
          ),
        );
      } else {
        accepted.push({ raw, kind: row.classification, index, metadata });
      }
    }
  } else {
    // Empty current plans take precedence. Legacy arrays are read only when the
    // current array is absent or unreadable, matching pre-v2 continuation behavior.
    for (const [kind, rows] of [
      ["blocking", plan.blockingIssuesToCreate],
      ["follow-up", plan.followUpIssuesToCreate],
    ] as const) {
      for (const [index, raw] of (rows ?? []).entries()) {
        accepted.push({
          raw,
          kind,
          index,
          metadata: yield* decodeRowMetadata(raw).pipe(Effect.option),
        });
      }
    }
  }
  const valid: ValidPlanItem[] = [];
  for (const { raw, kind, index, metadata } of accepted) {
    const fallbackId = `${kind}-${index + 1}`;
    if (Option.isNone(metadata)) {
      malformed.push(
        malformedSkip(
          fallbackId,
          kind,
          undefined,
          "Plan entry is not an object.",
        ),
      );
      continue;
    }
    const row = metadata.value;
    const context = yield* decodeRenderingContext(raw).pipe(Effect.option);
    if (!row.planItemId || !row.proposedTitle || Option.isNone(context)) {
      const missing = [
        ...(row.planItemId ? [] : ["planItemId"]),
        ...(row.proposedTitle ? [] : ["proposedTitle"]),
        ...(Option.isSome(context) ? [] : ["structured issue context"]),
      ];
      malformed.push(
        malformedSkip(
          row.planItemId ?? fallbackId,
          kind,
          row.proposedTitle,
          `Missing required field(s): ${missing.join(", ")}.`,
        ),
      );
      continue;
    }
    const {
      sourceFindingIds,
      reviewerSources,
      sourceIssueContext,
      runContext,
    } = context.value;
    valid.push({
      kind,
      planItemId: row.planItemId,
      title: row.proposedTitle,
      labels: (row.proposedLabels ?? []).filter(Schema.is(Schema.String)),
      renderingContext: {
        sourceIssue: {
          number: sourceIssueContext.number,
          title: sourceIssueContext.title,
          ...(sourceIssueContext.url ? { url: sourceIssueContext.url } : {}),
        },
        ...(runContext.prUrl ? { relatedPrUrl: runContext.prUrl } : {}),
        classification: classificationForKind(kind),
        sourceFindingIds,
        reviewerSources,
        ...(runContext.attempt === undefined
          ? {}
          : { attempt: runContext.attempt }),
      },
    });
  }
  let skippedDuplicateSourceFindings = 0;
  for (const raw of plan.duplicatesMerged ?? []) {
    const group = yield* decodeDuplicateGroup(raw).pipe(Effect.option);
    if (Option.isSome(group))
      skippedDuplicateSourceFindings +=
        group.value.mergedSourceFindingIds?.length ?? 0;
  }
  return {
    valid,
    malformed,
    counts: {
      acceptedPlanItems: plan.issuesToCreate?.length ?? accepted.length,
      skippedRejectedCandidates: plan.rejectedCandidates?.length ?? 0,
      skippedDuplicateGroups: plan.duplicatesMerged?.length ?? 0,
      skippedDuplicateSourceFindings,
      skippedParserWarnings: plan.warnings?.length ?? 0,
      skippedMalformed: malformed.length,
    },
  };
});
function malformedSkip(
  planItemId: string,
  kind: IssueCreationSkippedEntry["kind"],
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
export function classificationForKind(
  kind: IssuePlanKind,
): ReviewerIssueClassificationLabel {
  return kind === "blocking" ? "external-blocker" : kind;
}
