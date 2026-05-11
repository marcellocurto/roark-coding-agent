import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createWorkflowContext, finalReviewRef, reviewARef, reviewBRef, writeArtifact } from "./artifacts.ts";
import { buildReadinessMarkdown } from "./readiness.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("buildReadinessMarkdown", () => {
  test("ignores stale final review artifacts when numbered review cycle approves", async () => {
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
    await writeArtifact(context, reviewARef(0), "# Review A Pass 0\n\n## Verdict\napprove\n");
    await writeArtifact(context, reviewBRef(0), "# Review B Pass 0\n\n## Verdict\napprove\n");
    await writeArtifact(context, finalReviewRef(1), "# Final Review Pass 1\n\n## Verdict\nfixes-required\n");

    const markdown = await buildReadinessMarkdown(context);

    expect(markdown).toContain("## Status\nready-for-pr");
    expect(markdown).toContain("- Latest review cycle: 0");
    expect(markdown).toContain("- Legacy final review pass used: none");
  });

  test("does not let a stale final review override latest numbered fixes-required reviews", async () => {
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
    await writeArtifact(context, reviewARef(0), "# Review A Pass 0\n\n## Verdict\nfixes-required\n");
    await writeArtifact(context, reviewBRef(0), "# Review B Pass 0\n\n## Verdict\napprove\n");
    await writeArtifact(context, finalReviewRef(1), "# Final Review Pass 1\n\n## Verdict\nready-for-pr\n");

    const markdown = await buildReadinessMarkdown(context);

    expect(markdown).toContain("## Status\nnot-ready");
    expect(markdown).toContain("- Latest review cycle: 0");
    expect(markdown).toContain("- Review A verdict: fixes-required");
    expect(markdown).toContain("- Legacy final review pass used: none");
  });

  test("separates blocking, non-blocking, and warning finding summaries", async () => {
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
    await writeArtifact(context, "reviewA", `# Review A\n\n## Verdict\nfixes-required\n\n## Findings Ledger\n${entry("F1", "must-fix-current", "Current bug")}\n${entry("U1", "unknown-kind", "Bad classification")}`);
    await writeArtifact(context, "reviewB", `# Review B\n\n## Verdict\nblocked\n\n## Findings Ledger\n${entry("B1", "external-blocker", "Needs access")}\n${entry("FU1", "follow-up", "Track later")}\n${entry("S1", "suggestion", "Polish")}`);

    const markdown = await buildReadinessMarkdown(context);

    expect(markdown).toContain("## Status\nnot-ready");
    expect(markdown).toContain("## Current-Issue Blocking Findings\n- review-a:F1");
    expect(markdown).toContain("## External Blockers\n- review-b:B1");
    expect(markdown).toContain("## Follow-Up Findings\n- review-b:FU1");
    expect(markdown).toContain("## Suggestions\n- review-b:S1");
    expect(markdown).toContain("## Parser And Contract Warnings");
    expect(markdown).toContain("unknown-kind");
  });
});

function entry(id: string, classification: string, title: string): string {
  return `- Identifier: ${id}\n- Classification: ${classification}\n- Title: ${title}\n- Severity: medium\n- Confidence: high\n- Evidence: file.ts:1\n- Current-issue impact: Impact.\n- Recommended handling: Handle.\n`;
}
