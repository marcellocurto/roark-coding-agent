import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

export type AttemptOutcome =
  | "in-progress"
  | "published"
  | "failed-readiness"
  | "failed-verification"
  | "errored";

export type AttemptMetadata = {
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
};

export type AttemptSummary = Pick<
  AttemptMetadata,
  "attempt" | "branch" | "startedAt" | "endedAt" | "outcome" | "runArtifactPath"
>;

export type Clock = { now(): Date };

export const defaultClock: Clock = { now: () => new Date() };

export type FormatAttemptMetadataInput = {
  attempt: number;
  issueNumber: number;
  branch: string;
  baseBranch: string;
  worktreePath: string;
  runArtifactPath: string;
  startedAt: Date | string;
  endedAt?: Date | string | null;
  outcome?: AttemptOutcome;
  outcomeDetail?: string | null;
};

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
    runArtifactPath: input.runArtifactPath,
    startedAt: toIsoString(input.startedAt),
    endedAt: input.endedAt === undefined ? null : toIsoStringOrNull(input.endedAt),
    outcome: input.outcome ?? "in-progress",
    outcomeDetail: input.outcomeDetail ?? null,
  };
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

export async function updateAttemptIndex(
  issueDir: string,
  summary: AttemptSummary,
): Promise<AttemptSummary[]> {
  await mkdir(issueDir, { recursive: true });
  const indexPath = attemptIndexPath(issueDir);

  let current: AttemptSummary[] = [];
  if (existsSync(indexPath)) {
    try {
      const raw = await readFile(indexPath, "utf8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) current = parsed as AttemptSummary[];
    } catch {
      current = [];
    }
  }

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
