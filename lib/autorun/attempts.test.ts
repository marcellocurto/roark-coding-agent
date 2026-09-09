import { Schema, Effect } from "effect";
import { runApplicationPromise } from "../runtime/application.ts";
import {
  AttemptStore,
  attemptArtifactRelativePath,
  attemptDir,
  attemptIndexPath,
  attemptMetadataPath,
  attemptMetadataRelativePath,
  attemptsRootDir,
  formatAttemptMetadata,
  recordAttemptIssueComment,
  summarizeAttempt,
  type AttemptMetadata,
} from "./attempts.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
const tempDirs: string[] = [];
afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    await rm(dir, { recursive: true, force: true });
  }
});
async function makeIssueDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "roark-attempts-"));
  tempDirs.push(dir);
  return dir;
}
const baseInput = {
  attempt: 2,
  issueNumber: 10,
  branch: "roark/issue-10",
  baseBranch: "main",
  worktreePath: "/repo",
  runArtifactPath: ".roark/runs/issue/10/attempts/2",
  startedAt: "2026-05-05T07:17:40.000Z",
} as const;
describe("path helpers", () => {
  test("uses the durable issue attempt layout", () => {
    expect(attemptsRootDir("/repo/.roark/runs/issue/10")).toBe(
      "/repo/.roark/runs/issue/10/attempts",
    );
    expect(attemptDir("/repo/.roark/runs/issue/10", 2)).toBe(
      "/repo/.roark/runs/issue/10/attempts/2",
    );
    expect(attemptMetadataPath("/repo/issue/10", 3)).toBe(
      "/repo/issue/10/attempts/3/attempt.json",
    );
    expect(attemptIndexPath("/repo/issue/10")).toBe(
      "/repo/issue/10/attempts.json",
    );
  });
});
describe("formatAttemptMetadata", () => {
  test("defaults to in-progress with null endedAt and null detail", () => {
    const metadata = formatAttemptMetadata(baseInput);
    expect(metadata).toEqual({
      attempt: 2,
      issueNumber: 10,
      branch: "roark/issue-10",
      baseBranch: "main",
      worktreePath: "/repo",
      runArtifactPath: ".roark/runs/issue/10/attempts/2",
      startedAt: "2026-05-05T07:17:40.000Z",
      endedAt: null,
      outcome: "in-progress",
      outcomeDetail: null,
    });
  });
  test("converts Date instances to ISO strings", () => {
    const metadata = formatAttemptMetadata({
      ...baseInput,
      startedAt: new Date("2026-05-05T07:17:40.000Z"),
      endedAt: new Date("2026-05-05T07:42:11.000Z"),
      outcome: "published",
    });
    expect(metadata.startedAt).toBe("2026-05-05T07:17:40.000Z");
    expect(metadata.endedAt).toBe("2026-05-05T07:42:11.000Z");
    expect(metadata.outcome).toBe("published");
  });
});
describe("recordAttemptIssueComment", () => {
  test("stores issue comment refs by phase", () => {
    const metadata = formatAttemptMetadata(baseInput);
    recordAttemptIssueComment(
      metadata,
      "review-a",
      {
        id: 123,
        url: "https://github.com/owner/repo/issues/10#issuecomment-123",
        marker: "<!-- roark:issue=10 attempt=2 phase=review-a -->",
      },
      "2026-05-05T07:20:00.000Z",
    );
    expect(metadata.githubComments?.issue?.["review-a"]).toEqual({
      id: 123,
      url: "https://github.com/owner/repo/issues/10#issuecomment-123",
      marker: "<!-- roark:issue=10 attempt=2 phase=review-a -->",
      updatedAt: "2026-05-05T07:20:00.000Z",
    });
  });
});
describe("summarizeAttempt", () => {
  test("projects to the index summary fields only", () => {
    const metadata: AttemptMetadata = formatAttemptMetadata({
      ...baseInput,
      endedAt: "2026-05-05T07:42:11.000Z",
      outcome: "published",
    });
    expect(summarizeAttempt(metadata)).toEqual({
      attempt: 2,
      branch: "roark/issue-10",
      startedAt: "2026-05-05T07:17:40.000Z",
      endedAt: "2026-05-05T07:42:11.000Z",
      outcome: "published",
      runArtifactPath: ".roark/runs/issue/10/attempts/2",
    });
  });
});
describe("attemptArtifactRelativePath", () => {
  test("returns the run artifact path when filename is omitted", () => {
    const metadata = formatAttemptMetadata(baseInput);
    expect(attemptArtifactRelativePath(metadata)).toBe(
      ".roark/runs/issue/10/attempts/2",
    );
  });
  test("joins filenames with forward slashes", () => {
    const metadata = formatAttemptMetadata(baseInput);
    expect(attemptArtifactRelativePath(metadata, "attempt.json")).toBe(
      ".roark/runs/issue/10/attempts/2/attempt.json",
    );
    expect(attemptMetadataRelativePath(metadata)).toBe(
      ".roark/runs/issue/10/attempts/2/attempt.json",
    );
  });
});
describe("allocateNextAttempt", () => {
  test("returns 1 when there are no prior attempts", async () => {
    const issueDir = await makeIssueDir();
    expect(
      await runApplicationPromise(
        Effect.flatMap(AttemptStore, (store) => store.allocate(issueDir)),
      ),
    ).toBe(1);
  });
  test("returns max+1 based on numeric subdirectories", async () => {
    const issueDir = await makeIssueDir();
    await mkdir(path.join(issueDir, "attempts", "1"), { recursive: true });
    expect(
      await runApplicationPromise(
        Effect.flatMap(AttemptStore, (store) => store.allocate(issueDir)),
      ),
    ).toBe(2);
    await mkdir(path.join(issueDir, "attempts", "2"), { recursive: true });
    await mkdir(path.join(issueDir, "attempts", "5"), { recursive: true });
    expect(
      await runApplicationPromise(
        Effect.flatMap(AttemptStore, (store) => store.allocate(issueDir)),
      ),
    ).toBe(6);
  });
  test("ignores non-numeric subdirectories", async () => {
    const issueDir = await makeIssueDir();
    await mkdir(path.join(issueDir, "attempts", "1"), { recursive: true });
    await mkdir(path.join(issueDir, "attempts", "scratch"), {
      recursive: true,
    });
    expect(
      await runApplicationPromise(
        Effect.flatMap(AttemptStore, (store) => store.allocate(issueDir)),
      ),
    ).toBe(2);
  });
});
describe("writeAttemptMetadata + readAttemptMetadata", () => {
  test("rejects well-formed JSON with invalid metadata fields", async () => {
    const issueDir = await makeIssueDir();
    const metadata = formatAttemptMetadata(baseInput);
    await mkdir(attemptDir(issueDir, metadata.attempt), { recursive: true });
    await writeFile(
      attemptMetadataPath(issueDir, metadata.attempt),
      JSON.stringify({ ...metadata, attempt: "invalid" }),
    );
    const result = await runApplicationPromise(
      Effect.flatMap(AttemptStore, (store) =>
        store.read(issueDir, metadata.attempt),
      ).pipe(Effect.result),
    );
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "AttemptDataError" },
    });
  });
  test("preserves additional metadata fields when reading existing attempts", async () => {
    const issueDir = await makeIssueDir();
    const metadata = {
      ...formatAttemptMetadata(baseInput),
      extension: { detail: "retained" },
    };
    await mkdir(attemptDir(issueDir, metadata.attempt), { recursive: true });
    await writeFile(
      attemptMetadataPath(issueDir, metadata.attempt),
      JSON.stringify(metadata),
    );
    const parsed = await runApplicationPromise(
      Effect.flatMap(AttemptStore, (store) =>
        store.read(issueDir, metadata.attempt),
      ),
    );
    expect(parsed).toEqual(metadata);
  });
  test("round-trips metadata as JSON with stable formatting", async () => {
    const issueDir = await makeIssueDir();
    const metadata = formatAttemptMetadata({
      ...baseInput,
      endedAt: "2026-05-05T07:42:11.000Z",
      outcome: "published",
    });
    await runApplicationPromise(
      Effect.flatMap(AttemptStore, (store) => store.write(issueDir, metadata)),
    );
    const raw = await readFile(
      attemptMetadataPath(issueDir, metadata.attempt),
      "utf8",
    );
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw).toContain('"attempt": 2');
    const parsed = await runApplicationPromise(
      Effect.flatMap(AttemptStore, (store) =>
        store.read(issueDir, metadata.attempt),
      ),
    );
    expect(parsed).toEqual(metadata);
  });
});
describe("readAttemptIndex + latestAttemptNumber", () => {
  test("reads the persisted index and returns the latest attempt", async () => {
    const issueDir = await makeIssueDir();
    await runApplicationPromise(
      Effect.flatMap(AttemptStore, (store) =>
        store.updateIndex(issueDir, {
          attempt: 1,
          branch: "roark/issue-10",
          startedAt: "2026-05-05T07:00:00.000Z",
          endedAt: null,
          outcome: "failed-readiness",
          runArtifactPath: ".roark/runs/issue/10/attempts/1",
        }),
      ),
    );
    await runApplicationPromise(
      Effect.flatMap(AttemptStore, (store) =>
        store.updateIndex(issueDir, {
          attempt: 3,
          branch: "roark/issue-10",
          startedAt: "2026-05-05T09:00:00.000Z",
          endedAt: null,
          outcome: "in-progress",
          runArtifactPath: ".roark/runs/issue/10/attempts/3",
        }),
      ),
    );
    expect(
      (
        await runApplicationPromise(
          Effect.flatMap(AttemptStore, (store) => store.list(issueDir)),
        )
      ).map((entry) => entry.attempt),
    ).toEqual([1, 3]);
    expect(
      await runApplicationPromise(
        Effect.flatMap(AttemptStore, (store) => store.latest(issueDir)),
      ),
    ).toBe(3);
  });
  test("falls back to numeric attempt directories when the index is missing", async () => {
    const issueDir = await makeIssueDir();
    await mkdir(path.join(issueDir, "attempts", "1"), { recursive: true });
    await mkdir(path.join(issueDir, "attempts", "4"), { recursive: true });
    expect(
      await runApplicationPromise(
        Effect.flatMap(AttemptStore, (store) => store.latest(issueDir)),
      ),
    ).toBe(4);
  });
});
describe("updateAttemptIndex", () => {
  test("appends new attempts in order", async () => {
    const issueDir = await makeIssueDir();
    const first = await runApplicationPromise(
      Effect.flatMap(AttemptStore, (store) =>
        store.updateIndex(issueDir, {
          attempt: 1,
          branch: "roark/issue-10",
          startedAt: "2026-05-05T07:00:00.000Z",
          endedAt: null,
          outcome: "in-progress",
          runArtifactPath: ".roark/runs/issue/10/attempts/1",
        }),
      ),
    );
    expect(first.map((entry) => entry.attempt)).toEqual([1]);
    const second = await runApplicationPromise(
      Effect.flatMap(AttemptStore, (store) =>
        store.updateIndex(issueDir, {
          attempt: 2,
          branch: "roark/issue-10",
          startedAt: "2026-05-05T08:00:00.000Z",
          endedAt: null,
          outcome: "in-progress",
          runArtifactPath: ".roark/runs/issue/10/attempts/2",
        }),
      ),
    );
    expect(second.map((entry) => entry.attempt)).toEqual([1, 2]);
    const persisted = Schema.decodeUnknownSync(
      Schema.fromJsonString(
        Schema.mutable(Schema.Array(Schema.Struct({ attempt: Schema.Number }))),
      ),
    )(await readFile(attemptIndexPath(issueDir), "utf8"));
    expect(Array.isArray(persisted)).toBe(true);
    expect(persisted).toHaveLength(2);
    expect(persisted[1]?.attempt).toBe(2);
  });
  test("upserts an existing attempt without changing order", async () => {
    const issueDir = await makeIssueDir();
    await runApplicationPromise(
      Effect.flatMap(AttemptStore, (store) =>
        store.updateIndex(issueDir, {
          attempt: 1,
          branch: "roark/issue-10",
          startedAt: "2026-05-05T07:00:00.000Z",
          endedAt: null,
          outcome: "in-progress",
          runArtifactPath: ".roark/runs/issue/10/attempts/1",
        }),
      ),
    );
    await runApplicationPromise(
      Effect.flatMap(AttemptStore, (store) =>
        store.updateIndex(issueDir, {
          attempt: 2,
          branch: "roark/issue-10",
          startedAt: "2026-05-05T08:00:00.000Z",
          endedAt: null,
          outcome: "in-progress",
          runArtifactPath: ".roark/runs/issue/10/attempts/2",
        }),
      ),
    );
    const finalized = await runApplicationPromise(
      Effect.flatMap(AttemptStore, (store) =>
        store.updateIndex(issueDir, {
          attempt: 1,
          branch: "roark/issue-10",
          startedAt: "2026-05-05T07:00:00.000Z",
          endedAt: "2026-05-05T07:30:00.000Z",
          outcome: "failed-verification",
          runArtifactPath: ".roark/runs/issue/10/attempts/1",
        }),
      ),
    );
    expect(finalized.map((entry) => entry.attempt)).toEqual([1, 2]);
    const head = finalized[0];
    if (!head) throw new Error("expected head entry");
    expect(head.outcome).toBe("failed-verification");
    expect(head.endedAt).toBe("2026-05-05T07:30:00.000Z");
  });
  test("recovers from a corrupted index by starting fresh", async () => {
    const issueDir = await makeIssueDir();
    await mkdir(issueDir, { recursive: true });
    await writeFile(attemptIndexPath(issueDir), "{not json", "utf8");
    const result = await runApplicationPromise(
      Effect.flatMap(AttemptStore, (store) =>
        store.updateIndex(issueDir, {
          attempt: 1,
          branch: "roark/issue-10",
          startedAt: "2026-05-05T07:00:00.000Z",
          endedAt: null,
          outcome: "in-progress",
          runArtifactPath: ".roark/runs/issue/10/attempts/1",
        }),
      ),
    );
    expect(result).toHaveLength(1);
  });
});
