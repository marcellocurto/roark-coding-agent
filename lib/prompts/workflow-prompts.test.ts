import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  codeRefinementPrompt,
  fixPrompt,
  implementationPrompt,
  planDraftPrompt,
  planPrompt,
  reviewAPrompt,
  reviewBPrompt,
  sharedSystemPrompt,
  triagePrompt,
} from "./workflow-prompts.ts";
import { verificationBeforeFixRef, writeArtifact, type WorkflowContext } from "../workflow/artifacts.ts";
import { getWorkflowThinkingConfig } from "../workflow/thinking.ts";

const context = {
  controlCwd: "/repo",
  agentCwd: "/repo",
  outDir: "/repo/.roark/runs",
  runDir: "/repo/.roark/runs/issue/123",
  runDirRelative: ".roark/runs/issue/123",
  issueInput: "123",
  issueNumber: "123",
  force: false,
  yes: false,
  maxFixPasses: 1,
  thinkingConfig: getWorkflowThinkingConfig(),
} satisfies WorkflowContext;

const splitContext = {
  ...context,
  agentCwd: "/repo/.roark/worktrees/issue-123",
} satisfies WorkflowContext;

const tempDirs: string[] = [];

function phasePrompts(testContext: WorkflowContext): string[] {
  return [
    triagePrompt(testContext),
    planDraftPrompt(testContext),
    planPrompt(testContext),
    implementationPrompt(testContext),
    codeRefinementPrompt(testContext, 0),
    reviewAPrompt(testContext),
    reviewBPrompt(testContext),
    fixPrompt(testContext, 1),
  ];
}

function matchCount(value: string, pattern: RegExp): number {
  return value.match(pattern)?.length ?? 0;
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("workflow prompt structure and inputs", () => {
  test("shared and phase prompts keep one balanced XML envelope", () => {
    expect(sharedSystemPrompt).toContain("<system_prompt>");
    expect(sharedSystemPrompt).toContain("</system_prompt>");
    for (const prompt of phasePrompts(context)) {
      expect(matchCount(prompt, /<workflow_phase\b/g)).toBe(1);
      expect(matchCount(prompt, /<\/workflow_phase>/g)).toBe(1);
      expect(matchCount(prompt, /<success_criteria>/g)).toBe(1);
      expect(matchCount(prompt, /<\/success_criteria>/g)).toBe(1);
      expect(matchCount(prompt, /<inputs>/g)).toBe(1);
      expect(matchCount(prompt, /<\/inputs>/g)).toBe(1);
      expect(matchCount(prompt, /<output_contract\b/g)).toBe(1);
      expect(matchCount(prompt, /<\/output_contract>/g)).toBe(1);
    }
  });

  test("phase input artifact paths are reachable from split agent cwd", () => {
    const prompt = implementationPrompt(splitContext);
    expect(prompt).toContain('<artifact kind="issue">../../runs/issue/123/issue.md</artifact>');
    expect(prompt).toContain('<artifact kind="triage">../../runs/issue/123/triage.json</artifact>');
    expect(prompt).not.toContain('<artifact kind="issue">.roark/runs/issue/123/issue.md</artifact>');
  });
});

describe("structured review contract", () => {
  test("review agent B does not receive review agent A's artifact", () => {
    const prompt = reviewBPrompt(context);
    expect(prompt).not.toContain('artifact kind="review_a"');
  });

  test("later review passes receive only their own prior stable finding IDs", () => {
    const reviewA = reviewAPrompt(context, 1);
    const reviewB = reviewBPrompt(context, 1);
    expect(reviewA).toContain('<artifact kind="prior_review_a">.roark/runs/issue/123/review-a-0.json</artifact>');
    expect(reviewA).not.toContain('kind="prior_review_b"');
    expect(reviewB).toContain('<artifact kind="prior_review_b">.roark/runs/issue/123/review-b-0.json</artifact>');
    expect(reviewB).not.toContain('kind="prior_review_a"');
  });
});

describe("fix and refinement prompt inputs", () => {
  test("restart code refinement prompt reads restarted implementation context instead of a fix log", () => {
    const prompt = codeRefinementPrompt(context, 1, "restart");

    expect(prompt).toContain('<artifact kind="implementation_log">');
    expect(prompt).toContain('<artifact kind="baseline_reset">');
    expect(prompt).toContain('<artifact kind="implementation_restart_log">');
    expect(prompt).not.toContain('<artifact kind="fix_log">');
  });

  test("fix and subsequent workflow prompts include failed verification when present", async () => {
    const runDir = await mkdtemp(path.join(tmpdir(), "roark-prompt-verification-"));
    tempDirs.push(runDir);
    const verificationContext = {
      ...context,
      controlCwd: runDir,
      agentCwd: runDir,
      outDir: path.join(runDir, ".roark/runs"),
      runDir,
      runDirRelative: ".",
    } satisfies WorkflowContext;
    await writeArtifact(verificationContext, verificationBeforeFixRef(1), "# Verification\n\n## Exit Code\n1\n");

    expect(fixPrompt(verificationContext, 1)).toContain('<artifact kind="failed_verification">verification-before-fix-1.md</artifact>');
    expect(codeRefinementPrompt(verificationContext, 1)).toContain('<artifact kind="failed_verification">verification-before-fix-1.md</artifact>');
    expect(reviewAPrompt(verificationContext, 1)).toContain('<artifact kind="failed_verification">verification-before-fix-1.md</artifact>');
  });
});
