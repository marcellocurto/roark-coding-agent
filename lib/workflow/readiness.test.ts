import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createWorkflowContext, reviewARef, reviewBRef, writeArtifact } from "./artifacts.ts";
import { buildReadinessMarkdown } from "./readiness.ts";
import { reviewFinding, reviewResult } from "../testing/reviews.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("buildReadinessMarkdown", () => {
  test("separates blocking and non-blocking structured findings", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "roark-readiness-"));
    tempDirs.push(dir);
    const context = createWorkflowContext({
      command: "do",
      issue: "22",
      cwd: dir,
      outDir: ".roark/runs",
      force: false,
      yes: true,
      maxFixPasses: 1,
      attempt: 1,
    });
    await writeArtifact(context, "triage", "# Triage\n\n## Verdict\nproceed\n");
    await writeArtifact(context, "implementationPlan", "# Implementation Plan\n\n## Ready For Implementation\nyes\n");
    await writeArtifact(context, reviewARef(0), JSON.stringify(reviewResult([
      reviewFinding("must-fix-current", "Current bug"),
    ]), null, 2));
    await writeArtifact(context, reviewBRef(0), JSON.stringify(reviewResult([
      reviewFinding("external-blocker", "Needs access"),
      reviewFinding("follow-up", "Track later"),
      reviewFinding("suggestion", "Polish"),
    ]), null, 2));

    const markdown = await buildReadinessMarkdown(context);

    expect(markdown).toContain("## Status\nnot-ready");
    expect(markdown).toContain("## Current-Issue Blocking Findings\n- review-a:A-001");
    expect(markdown).toContain("## External Blockers\n- review-b:B-001");
    expect(markdown).toContain("## Follow-Up Findings\n- review-b:B-002");
    expect(markdown).toContain("## Suggestions\n- review-b:B-003");
    expect(markdown).not.toContain("Parser And Contract Warnings");
  });

  test("does not treat a diagnostic JSON file as a completed review cycle", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "roark-readiness-"));
    tempDirs.push(dir);
    const context = createWorkflowContext({
      command: "do",
      issue: "22",
      cwd: dir,
      outDir: ".roark/runs",
      force: false,
      yes: true,
      maxFixPasses: 1,
      attempt: 1,
    });
    await writeArtifact(context, "triage", "# Triage\n\n## Verdict\nproceed\n");
    await writeArtifact(context, "implementationPlan", "# Implementation Plan\n\n## Ready For Implementation\nyes\n");
    await writeArtifact(context, reviewARef(0), JSON.stringify(reviewResult()));
    await writeArtifact(context, reviewBRef(0), JSON.stringify(reviewResult()));
    await writeArtifact(context, reviewARef(1), JSON.stringify(reviewResult([
      reviewFinding("must-fix-current", "Incomplete later cycle"),
    ])));
    await writeArtifact(context, reviewBRef(1), JSON.stringify({ error: { message: "provider unavailable" } }));

    const markdown = await buildReadinessMarkdown(context);

    expect(markdown).toContain("- Latest review cycle: 0");
    expect(markdown).toContain("## Status\nready-for-pr");
    expect(markdown).not.toContain("Incomplete later cycle");
  });

  test("ignores unnumbered review JSON files", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "roark-readiness-"));
    tempDirs.push(dir);
    const context = createWorkflowContext({
      command: "do",
      issue: "22",
      cwd: dir,
      outDir: ".roark/runs",
      force: false,
      yes: true,
      maxFixPasses: 1,
      attempt: 1,
    });
    await writeArtifact(context, "triage", "# Triage\n\n## Verdict\nproceed\n");
    await writeArtifact(context, "implementationPlan", "# Implementation Plan\n\n## Ready For Implementation\nyes\n");
    await Bun.write(path.join(context.runDir, "review-a.json"), JSON.stringify(reviewResult([
      reviewFinding("must-fix-current", "Stale unnumbered finding"),
    ])));
    await Bun.write(path.join(context.runDir, "review-b.json"), JSON.stringify(reviewResult()));

    const markdown = await buildReadinessMarkdown(context);

    expect(markdown).toContain("- Latest review cycle: none");
    expect(markdown).toContain("## Status\nnot-ready");
    expect(markdown).not.toContain("Stale unnumbered finding");
  });
});
