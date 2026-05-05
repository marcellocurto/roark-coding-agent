import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  allocateNextAttempt,
  attemptArtifactRelativePath,
  attemptDir,
  attemptIndexPath,
  attemptMetadataPath,
  attemptMetadataRelativePath,
  attemptsRootDir,
  formatAttemptMetadata,
  latestAttemptNumber,
  readAttemptIndex,
  readAttemptMetadata,
  summarizeAttempt,
  updateAttemptIndex,
  writeAttemptMetadata,
  type AttemptMetadata,
} from "./attempts.ts";

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
  test("attemptsRootDir returns <issueDir>/attempts", () => {
    expect(attemptsRootDir("/repo/.roark/runs/issue/10")).toBe(
      "/repo/.roark/runs/issue/10/attempts",
    );
  });

  test("attemptDir returns <issueDir>/attempts/<n>", () => {
    expect(attemptDir("/repo/.roark/runs/issue/10", 2)).toBe(
      "/repo/.roark/runs/issue/10/attempts/2",
    );
  });

  test("attemptMetadataPath includes attempt.json", () => {
    expect(attemptMetadataPath("/repo/issue/10", 3)).toBe("/repo/issue/10/attempts/3/attempt.json");
  });

  test("attemptIndexPath sits at issue root", () => {
    expect(attemptIndexPath("/repo/issue/10")).toBe("/repo/issue/10/attempts.json");
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

  test("preserves outcomeDetail when provided", () => {
    const metadata = formatAttemptMetadata({
      ...baseInput,
      outcome: "failed-verification",
      outcomeDetail: "verify command exited 2",
      endedAt: "2026-05-05T07:42:11.000Z",
    });
    expect(metadata.outcome).toBe("failed-verification");
    expect(metadata.outcomeDetail).toBe("verify command exited 2");
    expect(metadata.endedAt).toBe("2026-05-05T07:42:11.000Z");
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
    expect(attemptArtifactRelativePath(metadata)).toBe(".roark/runs/issue/10/attempts/2");
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
    expect(await allocateNextAttempt(issueDir)).toBe(1);
  });

  test("returns max+1 based on numeric subdirectories", async () => {
    const issueDir = await makeIssueDir();
    await mkdir(path.join(issueDir, "attempts", "1"), { recursive: true });
    expect(await allocateNextAttempt(issueDir)).toBe(2);

    await mkdir(path.join(issueDir, "attempts", "2"), { recursive: true });
    await mkdir(path.join(issueDir, "attempts", "5"), { recursive: true });
    expect(await allocateNextAttempt(issueDir)).toBe(6);
  });

  test("ignores non-numeric subdirectories", async () => {
    const issueDir = await makeIssueDir();
    await mkdir(path.join(issueDir, "attempts", "1"), { recursive: true });
    await mkdir(path.join(issueDir, "attempts", "scratch"), { recursive: true });
    expect(await allocateNextAttempt(issueDir)).toBe(2);
  });
});

describe("writeAttemptMetadata + readAttemptMetadata", () => {
  test("round-trips metadata as JSON with stable formatting", async () => {
    const issueDir = await makeIssueDir();
    const metadata = formatAttemptMetadata({
      ...baseInput,
      endedAt: "2026-05-05T07:42:11.000Z",
      outcome: "published",
    });

    await writeAttemptMetadata(issueDir, metadata);
    const raw = await readFile(attemptMetadataPath(issueDir, metadata.attempt), "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw).toContain("\"attempt\": 2");

    const parsed = await readAttemptMetadata(issueDir, metadata.attempt);
    expect(parsed).toEqual(metadata);
  });
});

describe("readAttemptIndex + latestAttemptNumber", () => {
  test("reads the persisted index and returns the latest attempt", async () => {
    const issueDir = await makeIssueDir();
    await updateAttemptIndex(issueDir, {
      attempt: 1,
      branch: "roark/issue-10",
      startedAt: "2026-05-05T07:00:00.000Z",
      endedAt: null,
      outcome: "failed-readiness",
      runArtifactPath: ".roark/runs/issue/10/attempts/1",
    });
    await updateAttemptIndex(issueDir, {
      attempt: 3,
      branch: "roark/issue-10",
      startedAt: "2026-05-05T09:00:00.000Z",
      endedAt: null,
      outcome: "in-progress",
      runArtifactPath: ".roark/runs/issue/10/attempts/3",
    });

    expect((await readAttemptIndex(issueDir)).map((entry) => entry.attempt)).toEqual([1, 3]);
    expect(await latestAttemptNumber(issueDir)).toBe(3);
  });

  test("falls back to numeric attempt directories when the index is missing", async () => {
    const issueDir = await makeIssueDir();
    await mkdir(path.join(issueDir, "attempts", "1"), { recursive: true });
    await mkdir(path.join(issueDir, "attempts", "4"), { recursive: true });
    expect(await latestAttemptNumber(issueDir)).toBe(4);
  });
});

describe("updateAttemptIndex", () => {
  test("appends new attempts in order", async () => {
    const issueDir = await makeIssueDir();
    const first = await updateAttemptIndex(issueDir, {
      attempt: 1,
      branch: "roark/issue-10",
      startedAt: "2026-05-05T07:00:00.000Z",
      endedAt: null,
      outcome: "in-progress",
      runArtifactPath: ".roark/runs/issue/10/attempts/1",
    });
    expect(first.map((entry) => entry.attempt)).toEqual([1]);

    const second = await updateAttemptIndex(issueDir, {
      attempt: 2,
      branch: "roark/issue-10",
      startedAt: "2026-05-05T08:00:00.000Z",
      endedAt: null,
      outcome: "in-progress",
      runArtifactPath: ".roark/runs/issue/10/attempts/2",
    });
    expect(second.map((entry) => entry.attempt)).toEqual([1, 2]);

    const persisted = JSON.parse(await readFile(attemptIndexPath(issueDir), "utf8"));
    expect(Array.isArray(persisted)).toBe(true);
    expect(persisted).toHaveLength(2);
    expect(persisted[1].attempt).toBe(2);
  });

  test("upserts an existing attempt without changing order", async () => {
    const issueDir = await makeIssueDir();
    await updateAttemptIndex(issueDir, {
      attempt: 1,
      branch: "roark/issue-10",
      startedAt: "2026-05-05T07:00:00.000Z",
      endedAt: null,
      outcome: "in-progress",
      runArtifactPath: ".roark/runs/issue/10/attempts/1",
    });
    await updateAttemptIndex(issueDir, {
      attempt: 2,
      branch: "roark/issue-10",
      startedAt: "2026-05-05T08:00:00.000Z",
      endedAt: null,
      outcome: "in-progress",
      runArtifactPath: ".roark/runs/issue/10/attempts/2",
    });

    const finalized = await updateAttemptIndex(issueDir, {
      attempt: 1,
      branch: "roark/issue-10",
      startedAt: "2026-05-05T07:00:00.000Z",
      endedAt: "2026-05-05T07:30:00.000Z",
      outcome: "failed-verification",
      runArtifactPath: ".roark/runs/issue/10/attempts/1",
    });

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

    const result = await updateAttemptIndex(issueDir, {
      attempt: 1,
      branch: "roark/issue-10",
      startedAt: "2026-05-05T07:00:00.000Z",
      endedAt: null,
      outcome: "in-progress",
      runArtifactPath: ".roark/runs/issue/10/attempts/1",
    });
    expect(result).toHaveLength(1);
  });
});
