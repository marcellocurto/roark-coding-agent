import { Effect, SchemaGetter, type SchemaIssue } from "effect";
import {
  artifactContract,
  invalidArtifact,
  type ArtifactContractError,
} from "../structured-output/contract.ts";
import path from "node:path";
import { Schema } from "effect";
import type { StructuredArtifactDefinition } from "../structured-output/runner.ts";
const nonEmptyString = (description: string) =>
  Schema.String.check(Schema.isMinLength(1)).annotate({ description });
export const changedFileSchema = Schema.Struct({
  path: nonEmptyString("Repository-relative path changed during this phase."),
  description: nonEmptyString("What changed in this file and why."),
});
export const validationEntrySchema = Schema.Struct({
  command: nonEmptyString("Exact validation command that ran or should run."),
  status: Schema.Union([
    Schema.Literal("passed"),
    Schema.Literal("failed"),
    Schema.Literal("not-run"),
  ]),
  details: nonEmptyString(
    "Observed result or concrete reason the command was not run.",
  ),
});
const changeReportSchemaShape = Schema.Struct({
  summary: nonEmptyString("Concise account of the completed phase."),
  changedFiles: Schema.mutable(Schema.Array(changedFileSchema)),
  validation: Schema.mutable(Schema.Array(validationEntrySchema)).check(
    Schema.isMinLength(1),
  ),
  deviations: Schema.mutable(
    Schema.Array(
      nonEmptyString(
        "Deviation from the plan or material phase-specific decision.",
      ),
    ),
  ),
  addressedFindingIds: Schema.mutable(
    Schema.Array(
      nonEmptyString(
        "Workflow ID of a review finding addressed by this phase.",
      ),
    ),
  ),
  remainingConcerns: Schema.mutable(
    Schema.Array(
      nonEmptyString("Concrete unresolved concern remaining after this phase."),
    ),
  ),
});
export type ChangeReport = (typeof changeReportSchemaShape)["Type"];
export const normalizeChangeReport = Effect.fnUntraced(function* (
  value: ChangeReport,
): Effect.fn.Return<ChangeReport, SchemaIssue.Issue> {
  const report: ChangeReport = {
    summary: yield* requireTrimmed(value.summary, "summary"),
    changedFiles: yield* Effect.forEach(
      value.changedFiles,
      Effect.fnUntraced(function* (file, index) {
        return {
          path: yield* validateRepositoryRelativePath(file.path.trim(), index),
          description: yield* requireTrimmed(
            file.description,
            `changedFiles[${index}].description`,
          ),
        };
      }),
    ),
    validation: yield* Effect.forEach(
      value.validation,
      Effect.fnUntraced(function* (entry, index) {
        return {
          command: yield* requireTrimmed(
            entry.command,
            `validation[${index}].command`,
          ),
          status: entry.status,
          details: yield* requireTrimmed(
            entry.details,
            `validation[${index}].details`,
          ),
        };
      }),
    ),
    deviations: yield* trimItems(value.deviations, "deviations"),
    addressedFindingIds: yield* trimItems(
      value.addressedFindingIds,
      "addressedFindingIds",
    ),
    remainingConcerns: yield* trimItems(
      value.remainingConcerns,
      "remainingConcerns",
    ),
  };
  yield* rejectDuplicates(
    report.changedFiles.map((file) => file.path),
    "changedFiles paths",
  );
  yield* rejectDuplicates(report.addressedFindingIds, "addressedFindingIds");
  return report;
});
export const requireAddressedFindingIds = Effect.fnUntraced(function* (
  report: ChangeReport,
  expectedIds: readonly string[],
) {
  return yield* artifactContract(
    "Change report",
    changeReportSchemaShape.check(
      Schema.makeFilter((report) => {
        const expected = new Set(expectedIds);
        const actual = new Set(report.addressedFindingIds);
        const unknown = report.addressedFindingIds.filter(
          (id) => !expected.has(id),
        );
        const missing = expectedIds.filter((id) => !actual.has(id));
        if (unknown.length > 0 || missing.length > 0) {
          const details = [
            unknown.length > 0
              ? `unknown IDs: ${unknown.join(", ")}`
              : undefined,
            missing.length > 0
              ? `missing required IDs: ${missing.join(", ")}`
              : undefined,
          ].filter((item): item is string => item !== undefined);
          return `Fix report addressedFindingIds do not match the required review findings (${details.join("; ")}).`;
        }
      }),
    ),
  ).decode(report);
});
export function formatChangeReportMarkdown(
  report: ChangeReport,
  title: string,
): string {
  const lines = [
    `# ${title}`,
    "",
    "## Summary",
    report.summary,
    "",
    "## Changed Files",
    ...renderChangedFiles(report),
    "",
    "## Validation Run",
    ...renderValidation(report),
    "",
    "## Deviations",
    ...renderList(report.deviations),
    "",
    "## Review Findings Addressed",
    ...renderList(report.addressedFindingIds),
    "",
    "## Remaining Concerns",
    ...renderList(report.remainingConcerns),
    "",
  ];
  return lines.join("\n");
}
const contract = artifactContract(
  "Change report",
  changeReportSchemaShape.pipe(
    Schema.decode({
      decode: SchemaGetter.transformOrFail(normalizeChangeReport),
      encode: SchemaGetter.passthrough(),
    }),
  ),
);
export const validateChangeReport = contract.decode;
export const parseChangeReportJson = contract.parse;
export const changeReportSchema = changeReportSchemaShape;
export function changeReportArtifactDefinition(input: {
  title: string;
  validate?:
    | ((
        report: ChangeReport,
      ) => Effect.Effect<ChangeReport, ArtifactContractError>)
    | undefined;
}): StructuredArtifactDefinition<ChangeReport> {
  const validateForContext =
    input.validate ?? ((report: ChangeReport) => Effect.succeed(report));
  return {
    toolName: "submit_change_report",
    label: "Change Report",
    noun: "change report",
    parameters: changeReportSchema,
    validate: (value) =>
      validateChangeReport(value).pipe(Effect.flatMap(validateForContext)),
    formatMarkdown: (result) => formatChangeReportMarkdown(result, input.title),
  };
}
const validateRepositoryRelativePath = Effect.fnUntraced(function* (
  value: string,
  index: number,
): Effect.fn.Return<string, SchemaIssue.Issue> {
  if (!value)
    return yield* invalidArtifact(
      `Change report changedFiles[${index}].path must not be blank.`,
    );
  const normalized = value.replaceAll("\\", "/");
  if (path.posix.isAbsolute(normalized) || /^[A-Za-z]:\//.test(normalized)) {
    return yield* invalidArtifact(
      `Change report changedFiles[${index}].path must be repository-relative.`,
    );
  }
  if (normalized.split("/").includes("..")) {
    return yield* invalidArtifact(
      `Change report changedFiles[${index}].path must not escape the repository.`,
    );
  }
  return normalized.replace(/^\.\//, "");
});
const requireTrimmed = Effect.fnUntraced(function* (
  value: string,
  field: string,
): Effect.fn.Return<string, SchemaIssue.Issue> {
  const trimmed = value.trim();
  if (!trimmed)
    return yield* invalidArtifact(`Change report ${field} must not be blank.`);
  return trimmed;
});
const trimItems = Effect.fnUntraced(function* (
  values: string[],
  field: string,
): Effect.fn.Return<string[], SchemaIssue.Issue> {
  return yield* Effect.forEach(
    values,
    Effect.fnUntraced(function* (value, index) {
      return yield* requireTrimmed(value, `${field}[${index}]`);
    }),
  );
});
const rejectDuplicates = Effect.fnUntraced(function* (
  values: readonly string[],
  field: string,
): Effect.fn.Return<void, SchemaIssue.Issue> {
  const duplicates = values.filter(
    (value, index) => values.indexOf(value) !== index,
  );
  if (duplicates.length > 0) {
    return yield* invalidArtifact(
      `Change report ${field} must not contain duplicates: ${[...new Set(duplicates)].join(", ")}.`,
    );
  }
});
function renderChangedFiles(report: ChangeReport): string[] {
  return report.changedFiles.length === 0
    ? ["None."]
    : report.changedFiles.map(
        (file) => `- \`${file.path}\` — ${file.description}`,
      );
}
function renderValidation(report: ChangeReport): string[] {
  return report.validation.length === 0
    ? ["None."]
    : report.validation.map(
        (entry) => `- \`${entry.command}\` — ${entry.status}: ${entry.details}`,
      );
}
function renderList(values: readonly string[]): string[] {
  return values.length === 0 ? ["None."] : values.map((value) => `- ${value}`);
}
