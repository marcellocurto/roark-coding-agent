import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { AttemptWorkspaceMetadata } from "./workspace.ts";

export type AttemptOutcome =
  | "in-progress"
  | "published"
  | "triage-stopped"
  | "failed-readiness"
  | "failed-verification"
  | "failed-output-contract"
  | "errored";

export interface AttemptGitHubCommentRef {
  id: number;
  url?: string | undefined  ;
  marker: string;
  updatedAt: string;
}

export interface AttemptMetadata {
  attempt: number;
  issueNumber: number;
  branch: string;
  baseBranch: string;
  worktreePath: string;
  runArtifactPath: string;
  startedAt: string;
  endedAt: string | null;
  outcome: AttemptOutcome;
  outcomeDetail: string | null;
  workspace?: AttemptWorkspaceMetadata | undefined  ;
  githubComments?: {
    issue?: Record<string, AttemptGitHubCommentRef> | undefined;
  };
}

export type AttemptSummary = Pick<
  AttemptMetadata,
  "attempt" | "branch" | "startedAt" | "endedAt" | "outcome" | "runArtifactPath"
>;

export interface Clock { now(): Date }

export const defaultClock: Clock = { now: () => new Date() };

export interface FormatAttemptMetadataInput {
  attempt: number;
  issueNumber: number;
  branch: string;
  baseBranch: string;
  worktreePath: string;
  runArtifactPath: string;
  startedAt: Date | string;
  endedAt?: Date | string | null | undefined;
  outcome?: AttemptOutcome | undefined;
  outcomeDetail?: string | null | undefined;
  githubComments?: AttemptMetadata["githubComments"] | undefined;
  workspace?: AttemptWorkspaceMetadata | undefined  ;
}

export function attemptsRootDir(issueDir: string): string {
  return path.join(issueDir, "attempts");
}

export function attemptDir(issueDir: string, attempt: number): string {
  return path.join(attemptsRootDir(issueDir), String(attempt));
}

export function attemptMetadataPath(issueDir: string, attempt: number): string {
  return path.join(attemptDir(issueDir, attempt), "attempt.json");
}

export function attemptIndexPath(issueDir: string): string {
  return path.join(issueDir, "attempts.json");
}

export async function allocateNextAttempt(issueDir: string): Promise<number> {
  await mkdir(issueDir, { recursive: true });
  const root = attemptsRootDir(issueDir);
  if (!existsSync(root)) return 1;

  const entries = await readdir(root, { withFileTypes: true });
  let max = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!/^\d+$/.test(entry.name)) continue;
    const value = Number(entry.name);
    if (Number.isInteger(value) && value > max) max = value;
  }
  return max + 1;
}

export function formatAttemptMetadata(input: FormatAttemptMetadataInput): AttemptMetadata {
  return {
    attempt: input.attempt,
    issueNumber: input.issueNumber,
    branch: input.branch,
    baseBranch: input.baseBranch,
    worktreePath: input.worktreePath,
    ...(input.workspace ? { workspace: input.workspace } : {}),
    runArtifactPath: input.runArtifactPath,
    startedAt: toIsoString(input.startedAt),
    endedAt: input.endedAt === undefined ? null : toIsoStringOrNull(input.endedAt),
    outcome: input.outcome ?? "in-progress",
    outcomeDetail: input.outcomeDetail ?? null,
    ...(input.githubComments ? { githubComments: input.githubComments } : {}),
  };
}

export function recordAttemptIssueComment(
  metadata: AttemptMetadata,
  phase: string,
  ref: { id: number; url?: string | undefined; marker: string },
  updatedAt: Date | string = new Date(),
): AttemptMetadata {
  metadata.githubComments ??= {};
  metadata.githubComments.issue ??= {};
  metadata.githubComments.issue[phase] = {
    id: ref.id,
    ...(ref.url ? { url: ref.url } : {}),
    marker: ref.marker,
    updatedAt: toIsoString(updatedAt),
  };
  return metadata;
}

export function summarizeAttempt(metadata: AttemptMetadata): AttemptSummary {
  return {
    attempt: metadata.attempt,
    branch: metadata.branch,
    startedAt: metadata.startedAt,
    endedAt: metadata.endedAt,
    outcome: metadata.outcome,
    runArtifactPath: metadata.runArtifactPath,
  };
}

export function attemptArtifactRelativePath(metadata: AttemptMetadata, filename?: string): string {
  if (!filename) return metadata.runArtifactPath;
  return path.posix.join(toPosix(metadata.runArtifactPath), filename);
}

export function attemptMetadataRelativePath(metadata: AttemptMetadata): string {
  return attemptArtifactRelativePath(metadata, "attempt.json");
}

export async function writeAttemptMetadata(
  issueDir: string,
  metadata: AttemptMetadata,
): Promise<void> {
  const dir = attemptDir(issueDir, metadata.attempt);
  await mkdir(dir, { recursive: true });
  await writeFile(
    attemptMetadataPath(issueDir, metadata.attempt),
    `${JSON.stringify(metadata, null, 2)}\n`,
    "utf8",
  );
}

export async function readAttemptMetadata(
  issueDir: string,
  attempt: number,
): Promise<AttemptMetadata> {
  const raw = await readFile(attemptMetadataPath(issueDir, attempt), "utf8");
  return JSON.parse(raw) as AttemptMetadata;
}

export async function readAttemptIndex(issueDir: string): Promise<AttemptSummary[]> {
  const indexPath = attemptIndexPath(issueDir);
  if (!existsSync(indexPath)) return [];

  try {
    const raw = await readFile(indexPath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed as AttemptSummary[] : [];
  } catch {
    return [];
  }
}

export async function latestAttemptNumber(issueDir: string): Promise<number> {
  const indexed = await readAttemptIndex(issueDir);
  const fromIndex = indexed
    .map((entry) => entry.attempt)
    .filter((attempt) => Number.isInteger(attempt) && attempt > 0)
    .toSorted((left, right) => right - left)[0];
  if (fromIndex !== undefined) return fromIndex;

  const root = attemptsRootDir(issueDir);
  if (!existsSync(root)) throw new Error(`No autorun attempts found under ${root}. Pass --attempt or run auto first.`);

  const entries = await readdir(root, { withFileTypes: true });
  const attempts = entries
    .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
    .map((entry) => Number(entry.name))
    .filter((attempt) => Number.isInteger(attempt) && attempt > 0)
    .toSorted((left, right) => right - left);

  const latest = attempts[0];
  if (latest === undefined) throw new Error(`No autorun attempts found under ${root}. Pass --attempt or run auto first.`);
  return latest;
}

export async function updateAttemptIndex(
  issueDir: string,
  summary: AttemptSummary,
): Promise<AttemptSummary[]> {
  await mkdir(issueDir, { recursive: true });
  const indexPath = attemptIndexPath(issueDir);

  const current = await readAttemptIndex(issueDir);

  const existingIndex = current.findIndex((entry) => entry.attempt === summary.attempt);
  if (existingIndex >= 0) {
    current[existingIndex] = summary;
  } else {
    current.push(summary);
  }

  await writeFile(indexPath, `${JSON.stringify(current, null, 2)}\n`, "utf8");
  return current;
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function toIsoStringOrNull(value: Date | string | null): string | null {
  if (value === null) return null;
  return toIsoString(value);
}

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}
