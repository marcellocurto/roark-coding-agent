import type { ProcessResult } from "../cli/process.ts";
import { runProcess } from "../cli/process.ts";
import {
  artifactExists,
  artifactRelativePath,
  readArtifact,
  type WorkflowContext,
  writeJsonArtifact,
} from "../workflow/artifacts.ts";
import type { DuplicateGroup, IssueCurationPlan } from "../workflow/issue-curation.ts";

export type IssueCreateArgvOptions = {
  repo?: string;
  title: string;
  body: string;
  labels?: string[];
};

export type ProcessRunner = (args: string[], options?: { cwd?: string }) => Promise<ProcessResult>;

export type IssueCreationCreatedEntry = {
  planItemId: string;
  kind: IssuePlanKind;
  title: string;
  url?: string;
  number?: number;
  stdout?: string;
  source: "current-run" | "existing-result";
};

export type IssueCreationFailedEntry = {
  planItemId: string;
  kind: IssuePlanKind;
  title: string;
  message: string;
};

export type IssueCreationSkippedEntry = {
  planItemId: string;
  kind: IssuePlanKind;
  title?: string;
  reason: "already-created" | "malformed";
  message: string;
};

export type IssueCreationWouldCreateEntry = {
  planItemId: string;
  kind: IssuePlanKind;
  title: string;
  labels: string[];
};

export type IssueCreationResults = {
  version: 1;
  generatedAt: string;
  dryRun: boolean;
  approved: boolean;
  sourcePlanPath: string;
  resultPath: string;
  repo?: string;
  sourceIssue?: IssueCurationPlan["sourceIssue"];
  created: IssueCreationCreatedEntry[];
  failed: IssueCreationFailedEntry[];
  skipped: IssueCreationSkippedEntry[];
  wouldCreate: IssueCreationWouldCreateEntry[];
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
};

export type CreateIssuesOptions = {
  context: WorkflowContext;
  runner?: ProcessRunner;
  clock?: { now(): Date };
};

type IssuePlanKind = "blocking" | "follow-up";

type ValidPlanItem = {
  kind: IssuePlanKind;
  planItemId: string;
  title: string;
  body: string;
  labels: string[];
};

const issueCreationDefaultClock = { now: () => new Date() };
const requiredTriageLabel = "needs-triage";

export function buildIssueCreateArgv(options: IssueCreateArgvOptions): string[] {
  const labels = normalizeLabels([requiredTriageLabel, ...(options.labels ?? [])]);
  const labelArgs = labels.flatMap((label) => ["--label", label]);
  const repoArgs = options.repo ? ["--repo", options.repo] : [];
  return [
    "gh",
    "issue",
    "create",
    "--title",
    options.title,
    "--body",
    options.body,
    ...labelArgs,
    ...repoArgs,
  ];
}

export async function createIssuesPhase(context: WorkflowContext): Promise<IssueCreationResults> {
  const result = await createIssuesFromCurationPlan({ context });
  if (context.yes && result.failed.length > 0) {
    throw new Error(`Issue creation failed for ${result.failed.length} plan item(s). See ${artifactRelativePath(context, "issueCreationResults")}.`);
  }
  return result;
}

export async function createIssuesFromCurationPlan(options: CreateIssuesOptions): Promise<IssueCreationResults> {
  const { context, runner = runProcess, clock = issueCreationDefaultClock } = options;
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

  if (!context.yes) {
    const wouldCreate = creatable.map((item) => ({
      planItemId: item.planItemId,
      kind: item.kind,
      title: item.title,
      labels: normalizeLabels([requiredTriageLabel, ...item.labels]),
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
      countsInput: collected.counts,
    });
    printDryRunSummary(context, result);
    return result;
  }

  const createdCurrentRun: IssueCreationCreatedEntry[] = [];
  const failed: IssueCreationFailedEntry[] = [];

  console.log(`\n=== Create issues from ${sourcePlanPath} ===`);
  for (const item of creatable) {
    const argv = buildIssueCreateArgv({ repo: context.repo, title: item.title, body: item.body, labels: item.labels });
    console.log(`- Creating ${item.planItemId}: ${item.title}`);
    try {
      const processResult = await runner(argv, { cwd: context.cwd });
      if (processResult.exitCode !== 0) {
        failed.push({
          planItemId: item.planItemId,
          kind: item.kind,
          title: item.title,
          message: processResult.stderr.trim() || processResult.stdout.trim() || `gh issue create exited with code ${processResult.exitCode}`,
        });
        continue;
      }

      const parsed = parseCreatedIssue(processResult.stdout);
      createdCurrentRun.push({
        planItemId: item.planItemId,
        kind: item.kind,
        title: item.title,
        ...(parsed.url ? { url: parsed.url } : {}),
        ...(parsed.number !== undefined ? { number: parsed.number } : {}),
        ...(processResult.stdout.trim() ? { stdout: processResult.stdout.trim() } : {}),
        source: "current-run",
      });
    } catch (error) {
      failed.push({
        planItemId: item.planItemId,
        kind: item.kind,
        title: item.title,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const result = buildResult({
    context,
    plan,
    sourcePlanPath,
    resultPath,
    generatedAt: clock.now().toISOString(),
    dryRun: false,
    approved: true,
    existingCreated,
    createdCurrentRun,
    failed,
    skipped,
    wouldCreate: [],
    countsInput: collected.counts,
  });
  await writeJsonArtifact(context, "issueCreationResults", result);
  printApprovedSummary(context, result);
  return result;
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
      const planItemId = asNonEmptyString(entry.planItemId);
      const title = asNonEmptyString(entry.title);
      const kind = entry.kind === "blocking" || entry.kind === "follow-up" ? entry.kind : undefined;
      if (!planItemId || !title || !kind) return [];
      return [{
        planItemId,
        kind,
        title,
        ...(asNonEmptyString(entry.url) ? { url: asNonEmptyString(entry.url) } : {}),
        ...(typeof entry.number === "number" && Number.isInteger(entry.number) ? { number: entry.number } : {}),
        ...(asNonEmptyString(entry.stdout) ? { stdout: asNonEmptyString(entry.stdout) } : {}),
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
  const blocking = asArray((plan as Partial<IssueCurationPlan>).blockingIssuesToCreate);
  const followUps = asArray((plan as Partial<IssueCurationPlan>).followUpIssuesToCreate);
  const accepted = [
    ...blocking.map((item, index) => ({ raw: item, kind: "blocking" as const, index })),
    ...followUps.map((item, index) => ({ raw: item, kind: "follow-up" as const, index })),
  ];

  const valid: ValidPlanItem[] = [];
  const malformed: IssueCreationSkippedEntry[] = [];
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
      acceptedPlanItems: accepted.length,
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

  const planItemId = asNonEmptyString(raw.planItemId);
  const title = asNonEmptyString(raw.proposedTitle);
  const body = typeof raw.proposedBody === "string" && raw.proposedBody.trim() !== "" ? raw.proposedBody : undefined;
  const missing = [
    ...(planItemId ? [] : ["planItemId"]),
    ...(title ? [] : ["proposedTitle"]),
    ...(body ? [] : ["proposedBody"]),
  ];
  if (missing.length > 0 || !planItemId || !title || !body) {
    return { skipped: malformedSkip(planItemId ?? fallbackId, kind, title, `Missing required field(s): ${missing.join(", ")}.`) };
  }

  return {
    item: {
      kind,
      planItemId,
      title,
      body,
      labels: Array.isArray(raw.proposedLabels) ? raw.proposedLabels.filter((label): label is string => typeof label === "string") : [],
    },
  };
}

function malformedSkip(planItemId: string, kind: IssuePlanKind, title: string | undefined, message: string): IssueCreationSkippedEntry {
  return {
    planItemId,
    kind,
    ...(title ? { title } : {}),
    reason: "malformed",
    message,
  };
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
    ...(input.plan.sourceIssue ? { sourceIssue: input.plan.sourceIssue } : {}),
    created,
    failed: input.failed,
    skipped: input.skipped,
    wouldCreate: input.wouldCreate,
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

function parseCreatedIssue(stdout: string): { url?: string; number?: number } {
  const url = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /^https?:\/\//.test(line));
  if (!url) return {};
  const numberMatch = url.match(/\/issues\/(\d+)(?:[/?#]|$)/);
  return { url, ...(numberMatch?.[1] ? { number: Number(numberMatch[1]) } : {}) };
}

function printDryRunSummary(context: WorkflowContext, result: IssueCreationResults): void {
  console.log(`\n=== Dry run: create issues from ${result.sourcePlanPath} ===`);
  console.log("No GitHub issues were created. Pass --yes to create approved plan items.");
  console.log(`Target repo: ${context.repo ?? "gh default repository"}`);
  if (result.wouldCreate.length === 0) {
    console.log("No approved plan items would be created.");
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

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
