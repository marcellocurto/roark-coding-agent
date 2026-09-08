import {
  Context,
  Effect,
  FileSystem,
  Layer,
  Schema,
  type PlatformError,
} from "effect";
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
  url?: string | undefined;
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
  workspace?: AttemptWorkspaceMetadata | undefined;
  githubComments?: {
    issue?: Record<string, AttemptGitHubCommentRef> | undefined;
  };
}

export type AttemptSummary = Pick<
  AttemptMetadata,
  "attempt" | "branch" | "startedAt" | "endedAt" | "outcome" | "runArtifactPath"
>;

const attemptSummarySchema = Schema.Struct({
  attempt: Schema.Number,
  branch: Schema.String,
  startedAt: Schema.String,
  endedAt: Schema.NullOr(Schema.String),
  runArtifactPath: Schema.String,
  outcome: Schema.Literals([
    "in-progress",
    "published",
    "triage-stopped",
    "failed-readiness",
    "failed-verification",
    "failed-output-contract",
    "errored",
  ]),
});
const attemptMetadataSchema = Schema.Struct({
  ...attemptSummarySchema.fields,
  issueNumber: Schema.Number,
  baseBranch: Schema.String,
  worktreePath: Schema.String,
  outcomeDetail: Schema.NullOr(Schema.String),
  workspace: Schema.optional(
    Schema.Struct({
      path: Schema.String,
      strategy: Schema.Literal("clone"),
      cloneRemote: Schema.String,
      cloneUrl: Schema.optional(Schema.String),
      createdNow: Schema.Boolean,
    }),
  ),
  githubComments: Schema.optionalKey(
    Schema.Struct({
      issue: Schema.optional(
        Schema.Record(
          Schema.String,
          Schema.Struct({
            id: Schema.Number,
            url: Schema.optional(Schema.String),
            marker: Schema.String,
            updatedAt: Schema.String,
          }),
        ),
      ),
    }),
  ),
});
const parseAttemptSummaries = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.mutable(Schema.Array(attemptSummarySchema))),
);
const parseAttemptMetadata = Schema.decodeUnknownSync(
  Schema.fromJsonString(attemptMetadataSchema),
);

export interface Clock {
  now(): Date;
}

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
  workspace?: AttemptWorkspaceMetadata | undefined;
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

export function formatAttemptMetadata(
  input: FormatAttemptMetadataInput,
): AttemptMetadata {
  return {
    attempt: input.attempt,
    issueNumber: input.issueNumber,
    branch: input.branch,
    baseBranch: input.baseBranch,
    worktreePath: input.worktreePath,
    ...(input.workspace ? { workspace: input.workspace } : {}),
    runArtifactPath: input.runArtifactPath,
    startedAt: toIsoString(input.startedAt),
    endedAt:
      input.endedAt === undefined ? null : toIsoStringOrNull(input.endedAt),
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

export function attemptArtifactRelativePath(
  metadata: AttemptMetadata,
  filename?: string,
): string {
  if (!filename) return metadata.runArtifactPath;
  return path.posix.join(toPosix(metadata.runArtifactPath), filename);
}

export function attemptMetadataRelativePath(metadata: AttemptMetadata): string {
  return attemptArtifactRelativePath(metadata, "attempt.json");
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

export class AttemptDataError extends Schema.TaggedError<AttemptDataError>()(
  "AttemptDataError",
  {
    path: Schema.String,
    cause: Schema.Unknown,
  },
) {
  override get message(): string {
    return `Could not read attempt data at ${this.path}: ${String(this.cause)}`;
  }
}

type AttemptStoreError = PlatformError.PlatformError | AttemptDataError;
export class AttemptStore extends Context.Service<
  AttemptStore,
  {
    allocate(
      issueDir: string,
    ): Effect.Effect<number, PlatformError.PlatformError>;
    write(
      issueDir: string,
      metadata: AttemptMetadata,
    ): Effect.Effect<void, PlatformError.PlatformError>;
    read(
      issueDir: string,
      attempt: number,
    ): Effect.Effect<AttemptMetadata, AttemptStoreError>;
    list(issueDir: string): Effect.Effect<AttemptSummary[]>;
    latest(issueDir: string): Effect.Effect<number, AttemptStoreError>;
    updateIndex(
      issueDir: string,
      summary: AttemptSummary,
    ): Effect.Effect<AttemptSummary[], PlatformError.PlatformError>;
    persist(
      issueDir: string,
      metadata: AttemptMetadata,
    ): Effect.Effect<void, PlatformError.PlatformError>;
  }
>()("roark/autorun/AttemptStore") {}

export const attemptStoreLayer = Layer.effect(
  AttemptStore,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directories = Effect.fn("AttemptStore.directories")(function* (
      issueDir: string,
    ) {
      const root = attemptsRootDir(issueDir);
      if (!(yield* fs.exists(root))) return [];
      const entries = yield* fs.readDirectory(root);
      const attempts: number[] = [];
      for (const entry of entries) {
        if (!/^\d+$/.test(entry)) continue;
        if ((yield* fs.stat(path.join(root, entry))).type !== "Directory")
          continue;
        const value = Number(entry);
        if (Number.isInteger(value) && value > 0) attempts.push(value);
      }
      return attempts;
    });
    const list = Effect.fn("AttemptStore.list")(
      function* (issueDir: string) {
        const file = attemptIndexPath(issueDir);
        const raw = yield* fs.readFileString(file);
        return yield* Effect.try({
          try: () => {
            return parseAttemptSummaries(raw, { onExcessProperty: "preserve" });
          },
          catch: (cause) => new AttemptDataError({ path: file, cause }),
        });
      },
      Effect.catch(() => Effect.succeed([] as AttemptSummary[])),
    );
    const write = Effect.fn("AttemptStore.write")(function* (
      issueDir: string,
      metadata: AttemptMetadata,
    ) {
      yield* fs.makeDirectory(attemptDir(issueDir, metadata.attempt), {
        recursive: true,
      });
      yield* fs.writeFileString(
        attemptMetadataPath(issueDir, metadata.attempt),
        `${JSON.stringify(metadata, null, 2)}\n`,
      );
    }, Effect.uninterruptible);
    const updateIndex = Effect.fn("AttemptStore.updateIndex")(function* (
      issueDir: string,
      summary: AttemptSummary,
    ) {
      yield* fs.makeDirectory(issueDir, { recursive: true });
      const current = yield* list(issueDir);
      const index = current.findIndex(
        (entry) => entry.attempt === summary.attempt,
      );
      if (index >= 0) current[index] = summary;
      else current.push(summary);
      yield* fs.writeFileString(
        attemptIndexPath(issueDir),
        `${JSON.stringify(current, null, 2)}\n`,
      );
      return current;
    }, Effect.uninterruptible);
    return AttemptStore.of({
      list,
      write,
      updateIndex,
      allocate: Effect.fn("AttemptStore.allocate")(function* (issueDir) {
        yield* fs.makeDirectory(issueDir, { recursive: true });
        const attempts = yield* directories(issueDir);
        return Math.max(0, ...attempts) + 1;
      }),
      read: Effect.fn("AttemptStore.read")(function* (issueDir, attempt) {
        const file = attemptMetadataPath(issueDir, attempt);
        const raw = yield* fs.readFileString(file);
        return yield* Effect.try({
          try: () =>
            parseAttemptMetadata(raw, { onExcessProperty: "preserve" }),
          catch: (cause) => new AttemptDataError({ path: file, cause }),
        });
      }),
      latest: Effect.fn("AttemptStore.latest")(function* (issueDir) {
        const indexed = (yield* list(issueDir))
          .map((entry) => entry.attempt)
          .filter((attempt) => Number.isInteger(attempt) && attempt > 0);
        const attempts =
          indexed.length > 0 ? indexed : yield* directories(issueDir);
        if (attempts.length === 0)
          return yield* Effect.fail(
            new AttemptDataError({
              path: attemptsRootDir(issueDir),
              cause: `No autorun attempts found under ${attemptsRootDir(issueDir)}. Pass --attempt or run auto first.`,
            }),
          );
        return Math.max(...attempts);
      }),
      persist: Effect.fn("AttemptStore.persist")(function* (
        issueDir,
        metadata,
      ) {
        yield* write(issueDir, metadata);
        yield* updateIndex(issueDir, summarizeAttempt(metadata));
      }, Effect.uninterruptible),
    });
  }),
);
