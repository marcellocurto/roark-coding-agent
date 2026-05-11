import type { ProcessResult } from "../cli/process.ts";
import { runPiAgent } from "../pi/agent.ts";
import { issuePublishingPrompt, issuePublishingSystemPrompt } from "../prompts/issue-publishing-prompt.ts";
import { resolveGithubIssueCreateSkillPath } from "../skills/skill-resolver.ts";
import type { AgentRunner } from "../workflow/agent-runner.ts";
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

export type IssueCreationRelationshipOutcomeEntry = {
  planItemId: string;
  status: string;
  message: string;
  relationship?: string;
  targetPlanItemId?: string;
  sourceIssueNumber?: number;
  targetIssueNumber?: number;
  url?: string;
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
};

export type CreateIssuesOptions = {
  context: WorkflowContext;
  /**
   * Test-only/direct publisher override retained for low-level gh argv coverage.
   * Product create-issues runs use agentRunner with the resolved Roark skill.
   */
  runner?: ProcessRunner;
  agentRunner?: AgentRunner;
  skillResolver?: (cwd: string) => Promise<string>;
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

export async function createIssuesPhase(context: WorkflowContext, agentRunner: AgentRunner = runPiAgent): Promise<IssueCreationResults> {
  const result = await createIssuesFromCurationPlan({ context, agentRunner });
  if (context.yes && result.failed.length > 0) {
    throw new Error(`Issue creation failed for ${result.failed.length} plan item(s). See ${artifactRelativePath(context, "issueCreationResults")}.`);
  }
  return result;
}

export async function createIssuesFromCurationPlan(options: CreateIssuesOptions): Promise<IssueCreationResults> {
  const { context, runner, agentRunner = runPiAgent, skillResolver = resolveGithubIssueCreateSkillPath, clock = issueCreationDefaultClock } = options;
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
      relationshipOutcomes: [],
      countsInput: collected.counts,
    });
    printDryRunSummary(context, result);
    return result;
  }

  const publishResult = runner
    ? await publishIssuesDirectlyWithProcessRunner(context, creatable, runner)
    : await publishIssuesWithResolvedSkill({
      context,
      sourcePlanPath,
      resultPath,
      creatable,
      agentRunner,
      skillResolver,
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

type PublishResult = {
  createdCurrentRun: IssueCreationCreatedEntry[];
  failed: IssueCreationFailedEntry[];
  relationshipOutcomes: IssueCreationRelationshipOutcomeEntry[];
};

async function publishIssuesDirectlyWithProcessRunner(
  context: WorkflowContext,
  creatable: ValidPlanItem[],
  runner: ProcessRunner,
): Promise<PublishResult> {
  const createdCurrentRun: IssueCreationCreatedEntry[] = [];
  const failed: IssueCreationFailedEntry[] = [];

  console.log(`\n=== Create issues from ${artifactRelativePath(context, "issueCurationPlan")} ===`);
  for (const item of creatable) {
    const argv = buildIssueCreateArgv({ repo: context.repo, title: item.title, body: item.body, labels: item.labels });
    console.log(`- Creating ${item.planItemId}: ${item.title}`);
    try {
      const processResult = await runner(argv, { cwd: context.agentCwd });
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

  return { createdCurrentRun, failed, relationshipOutcomes: [] };
}

async function publishIssuesWithResolvedSkill(input: {
  context: WorkflowContext;
  sourcePlanPath: string;
  resultPath: string;
  creatable: ValidPlanItem[];
  agentRunner: AgentRunner;
  skillResolver: (cwd: string) => Promise<string>;
}): Promise<PublishResult> {
  const { context, sourcePlanPath, resultPath, creatable, agentRunner, skillResolver } = input;
  if (creatable.length === 0) return { createdCurrentRun: [], failed: [], relationshipOutcomes: [] };

  const skillPath = await skillResolver(context.agentCwd);
  console.log(`\n=== Create issues from ${sourcePlanPath} with skill ${skillPath} ===`);

  try {
    const output = await agentRunner({
      cwd: context.agentCwd,
      model: context.model,
      thinkingLevel: context.thinkingConfig.issuePublishing,
      systemPrompt: issuePublishingSystemPrompt(),
      prompt: issuePublishingPrompt({
        context,
        sourcePlanPath,
        resultPath,
        allowedItems: creatable.map((item) => ({
          planItemId: item.planItemId,
          kind: item.kind,
          title: item.title,
          labels: normalizeLabels([requiredTriageLabel, ...item.labels]),
        })),
      }),
      writable: false,
      observer: context.observer,
      phase: "issue-publishing",
      skillPaths: [skillPath],
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
    const planItemId = asNonEmptyString(entry.planItemId);
    if (!planItemId || !itemsById.has(planItemId)) throw new Error(`Issue-publishing agent returned unknown created planItemId '${planItemId ?? ""}'.`);
    const item = itemsById.get(planItemId)!;
    const number = typeof entry.number === "number" && Number.isInteger(entry.number) ? entry.number : undefined;
    return {
      planItemId,
      kind: item.kind,
      title: item.title,
      ...(asNonEmptyString(entry.url) ? { url: asNonEmptyString(entry.url) } : {}),
      ...(number !== undefined ? { number } : {}),
      ...(asNonEmptyString(entry.stdout) ? { stdout: asNonEmptyString(entry.stdout) } : {}),
      source: "current-run" as const,
    };
  });
  const failed = agentResult.failed.map((entry) => {
    if (!isRecord(entry)) throw new Error("Issue-publishing agent returned a non-object failed entry.");
    const planItemId = asNonEmptyString(entry.planItemId);
    if (!planItemId || !itemsById.has(planItemId)) throw new Error(`Issue-publishing agent returned unknown failed planItemId '${planItemId ?? ""}'.`);
    const item = itemsById.get(planItemId)!;
    return {
      planItemId,
      kind: item.kind,
      title: item.title,
      message: asNonEmptyString(entry.message) ?? "Issue-publishing agent reported failure without a message.",
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

    const planItemId = asNonEmptyString(entry.planItemId);
    if (!planItemId || !itemsById.has(planItemId)) {
      throw new Error(`Issue-publishing agent returned unknown relationship outcome planItemId '${planItemId ?? ""}'.`);
    }

    const status = asNonEmptyString(entry.status);
    if (!status) throw new Error(`Issue-publishing agent returned relationship outcome for '${planItemId}' without a non-empty status.`);

    const message = asNonEmptyString(entry.message);
    if (!message) throw new Error(`Issue-publishing agent returned relationship outcome for '${planItemId}' without a non-empty message.`);

    const targetPlanItemId = asNonEmptyString(entry.targetPlanItemId);
    if (targetPlanItemId && !itemsById.has(targetPlanItemId)) {
      throw new Error(`Issue-publishing agent returned relationship outcome for '${planItemId}' with unknown targetPlanItemId '${targetPlanItemId}'.`);
    }

    const sourceIssueNumber = asInteger(entry.sourceIssueNumber);
    const targetIssueNumber = asInteger(entry.targetIssueNumber);
    return {
      planItemId,
      status,
      message,
      ...(asNonEmptyString(entry.relationship) ? { relationship: asNonEmptyString(entry.relationship) } : {}),
      ...(targetPlanItemId ? { targetPlanItemId } : {}),
      ...(sourceIssueNumber !== undefined ? { sourceIssueNumber } : {}),
      ...(targetIssueNumber !== undefined ? { targetIssueNumber } : {}),
      ...(asNonEmptyString(entry.url) ? { url: asNonEmptyString(entry.url) } : {}),
    };
  });
}

function extractFencedJson(output: string): string {
  const match = output.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/);
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
    ...(input.plan.sourceIssue ? { sourceIssue: input.plan.sourceIssue } : {}),
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
