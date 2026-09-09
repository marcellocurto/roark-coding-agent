import {
  trimmedText,
  changedFilesSchema,
  validationEntriesSchema,
} from "../structured-output/fields.ts";
import { Effect } from "effect";
import {
  artifactContract,
  type ArtifactContractError,
} from "../structured-output/contract.ts";
import { Schema } from "effect";
import type { StructuredArtifactDefinition } from "../structured-output/runner.ts";
const changeReportSchemaShape = Schema.Struct({
  summary: trimmedText("Concise account of the completed phase."),
  changedFiles: changedFilesSchema,
  validation: validationEntriesSchema,
  deviations: Schema.mutable(
    Schema.Array(
      trimmedText(
        "Deviation from the plan or material phase-specific decision.",
      ),
    ),
  ),
  addressedFindingIds: Schema.mutable(
    Schema.Array(
      trimmedText("Workflow ID of a review finding addressed by this phase."),
    ),
  ),
  remainingConcerns: Schema.mutable(
    Schema.Array(
      trimmedText("Concrete unresolved concern remaining after this phase."),
    ),
  ),
});
export type ChangeReport = (typeof changeReportSchemaShape)["Type"];
export const requireAddressedFindingIds = Effect.fnUntraced(function* (
  report: ChangeReport,
  expectedIds: readonly string[],
) {
  return yield* artifactContract(
    "Change report",
    Schema.toType(changeReportSchemaShape).check(
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
  changeReportSchemaShape.check(
    Schema.makeFilter((report) => {
      const ids = report.addressedFindingIds;
      const duplicates = [
        ...new Set(ids.filter((id, index) => ids.indexOf(id) !== index)),
      ];
      if (duplicates.length > 0)
        return `Change report addressedFindingIds must not contain duplicates: ${duplicates.join(", ")}.`;
    }),
  ),
);
export const validateChangeReport = contract.decode;
export const parseChangeReportJson = contract.parse;
export const changeReportSchema = Schema.toEncoded(changeReportSchemaShape);
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
