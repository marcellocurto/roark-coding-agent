import path from "node:path";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import type { StructuredArtifactDefinition } from "../structured-output/runner.ts";

const nonEmptyString = (description: string) => Type.String({ minLength: 1, description });

export const changedFileSchema = Type.Object({
  path: nonEmptyString("Repository-relative path changed during this phase."),
  description: nonEmptyString("What changed in this file and why."),
}, { additionalProperties: false });

export const validationEntrySchema = Type.Object({
  command: nonEmptyString("Exact validation command that ran or should run."),
  status: Type.Union([Type.Literal("passed"), Type.Literal("failed"), Type.Literal("not-run")]),
  details: nonEmptyString("Observed result or concrete reason the command was not run."),
}, { additionalProperties: false });

export const changeReportSchema = Type.Object({
  summary: nonEmptyString("Concise account of the completed phase."),
  changedFiles: Type.Array(changedFileSchema),
  validation: Type.Array(validationEntrySchema, { minItems: 1 }),
  deviations: Type.Array(nonEmptyString("Deviation from the plan or material phase-specific decision.")),
  addressedFindingIds: Type.Array(nonEmptyString("Workflow ID of a review finding addressed by this phase.")),
  remainingConcerns: Type.Array(nonEmptyString("Concrete unresolved concern remaining after this phase.")),
}, { additionalProperties: false });

export type ChangeReport = Static<typeof changeReportSchema>;

export class ChangeReportOutputContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChangeReportOutputContractError";
  }
}

export function validateChangeReport(value: unknown): ChangeReport {
  if (!Value.Check(changeReportSchema, value)) {
    const first = Value.Errors(changeReportSchema, value)[0];
    const location = first?.instancePath ?? first?.schemaPath ?? "change report";
    throw new ChangeReportOutputContractError(`Change report does not satisfy the structured contract at ${location}.`);
  }

  const report: ChangeReport = {
    summary: requireTrimmed(value.summary, "summary"),
    changedFiles: value.changedFiles.map((file, index) => ({
      path: validateRepositoryRelativePath(file.path.trim(), index),
      description: requireTrimmed(file.description, `changedFiles[${index}].description`),
    })),
    validation: value.validation.map((entry, index) => ({
      command: requireTrimmed(entry.command, `validation[${index}].command`),
      status: entry.status,
      details: requireTrimmed(entry.details, `validation[${index}].details`),
    })),
    deviations: trimItems(value.deviations, "deviations"),
    addressedFindingIds: trimItems(value.addressedFindingIds, "addressedFindingIds"),
    remainingConcerns: trimItems(value.remainingConcerns, "remainingConcerns"),
  };

  rejectDuplicates(report.changedFiles.map((file) => file.path), "changedFiles paths");
  rejectDuplicates(report.addressedFindingIds, "addressedFindingIds");
  return report;
}

export function parseChangeReportJson(content: string): ChangeReport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new ChangeReportOutputContractError(`Change report artifact is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return validateChangeReport(parsed);
}

export function requireAddressedFindingIds(
  report: ChangeReport,
  expectedIds: readonly string[],
): ChangeReport {
  const expected = new Set(expectedIds);
  const actual = new Set(report.addressedFindingIds);
  const unknown = report.addressedFindingIds.filter((id) => !expected.has(id));
  const missing = expectedIds.filter((id) => !actual.has(id));
  if (unknown.length > 0 || missing.length > 0) {
    const details = [
      unknown.length > 0 ? `unknown IDs: ${unknown.join(", ")}` : undefined,
      missing.length > 0 ? `missing required IDs: ${missing.join(", ")}` : undefined,
    ].filter((item): item is string => item !== undefined);
    throw new ChangeReportOutputContractError(`Fix report addressedFindingIds do not match the required review findings (${details.join("; ")}).`);
  }
  return report;
}

export function formatChangeReportMarkdown(report: ChangeReport, title: string): string {
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

export function changeReportArtifactDefinition(input: {
  title: string;
  validate?: ((report: ChangeReport) => ChangeReport) | undefined;
}): StructuredArtifactDefinition<ChangeReport> {
  const validateForContext = input.validate ?? ((report: ChangeReport) => report);
  return {
    toolName: "submit_change_report",
    label: "Change Report",
    noun: "change report",
    parameters: changeReportSchema,
    validate: (value) => validateForContext(validateChangeReport(value)),
    formatMarkdown: (result) => formatChangeReportMarkdown(result, input.title),
    createError: (message) => new ChangeReportOutputContractError(message),
  };
}

function validateRepositoryRelativePath(value: string, index: number): string {
  if (!value) throw new ChangeReportOutputContractError(`Change report changedFiles[${index}].path must not be blank.`);
  const normalized = value.replaceAll("\\", "/");
  if (path.posix.isAbsolute(normalized) || /^[A-Za-z]:\//.test(normalized)) {
    throw new ChangeReportOutputContractError(`Change report changedFiles[${index}].path must be repository-relative.`);
  }
  if (normalized.split("/").includes("..")) {
    throw new ChangeReportOutputContractError(`Change report changedFiles[${index}].path must not escape the repository.`);
  }
  return normalized.replace(/^\.\//, "");
}

function requireTrimmed(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new ChangeReportOutputContractError(`Change report ${field} must not be blank.`);
  return trimmed;
}

function trimItems(values: string[], field: string): string[] {
  return values.map((value, index) => requireTrimmed(value, `${field}[${index}]`));
}

function rejectDuplicates(values: readonly string[], field: string): void {
  const duplicates = values.filter((value, index) => values.indexOf(value) !== index);
  if (duplicates.length > 0) {
    throw new ChangeReportOutputContractError(`Change report ${field} must not contain duplicates: ${[...new Set(duplicates)].join(", ")}.`);
  }
}

function renderChangedFiles(report: ChangeReport): string[] {
  return report.changedFiles.length === 0
    ? ["None."]
    : report.changedFiles.map((file) => `- \`${file.path}\` — ${file.description}`);
}

function renderValidation(report: ChangeReport): string[] {
  return report.validation.length === 0
    ? ["None."]
    : report.validation.map((entry) => `- \`${entry.command}\` — ${entry.status}: ${entry.details}`);
}

function renderList(values: readonly string[]): string[] {
  return values.length === 0 ? ["None."] : values.map((value) => `- ${value}`);
}
