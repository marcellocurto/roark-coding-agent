import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { allocateNextRevision, inferIssueFromPrBody } from "./artifacts.ts";

describe("PR revision artifacts", () => {
  test("allocates next revision directory number", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "roark-pr-revision-"));
    const prDir = path.join(root, "pr", "12");
    expect(await allocateNextRevision(prDir)).toBe(1);
    await mkdir(path.join(prDir, "revision-1"), { recursive: true });
    await mkdir(path.join(prDir, "revision-3"), { recursive: true });
    await mkdir(path.join(prDir, "notes"), { recursive: true });
    expect(await allocateNextRevision(prDir)).toBe(4);
  });

  test("infers closing issue from PR body", () => {
    expect(inferIssueFromPrBody("Implements this.\n\nCloses #46")).toBe(46);
    expect(inferIssueFromPrBody("Fixes owner/repo#123")).toBe(123);
    expect(inferIssueFromPrBody("No closing keyword #7")).toBeUndefined();
  });
});
