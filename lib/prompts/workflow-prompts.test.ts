import { runApplicationPromise } from "../runtime/application.ts";
import * as nativeWorkflowPrompts from "./workflow-prompts.ts";
import {
  writeArtifact,
  verificationBeforeFixRef,
  type WorkflowContext,
} from "../workflow/artifacts.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  implementationPrompt,
  planDraftPrompt,
  planPrompt,
  sharedSystemPrompt,
  triagePrompt,
} from "./workflow-prompts.ts";
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
async function phasePrompts(testContext: WorkflowContext): Promise<string[]> {
  return [
    triagePrompt(testContext),
    planDraftPrompt(testContext),
    planPrompt(testContext),
    implementationPrompt(testContext),
    await runApplicationPromise(
      nativeWorkflowPrompts.codeRefinementPrompt(testContext, 0, "initial"),
    ),
    await runApplicationPromise(
      nativeWorkflowPrompts.reviewAPrompt(testContext, 0),
    ),
    await runApplicationPromise(
      nativeWorkflowPrompts.reviewBPrompt(testContext, 0),
    ),
    await runApplicationPromise(
      nativeWorkflowPrompts.fixPrompt(testContext, 1),
    ),
  ];
}
function matchCount(value: string, pattern: RegExp): number {
  return value.match(pattern)?.length ?? 0;
}
afterEach(async () => {
  for (const dir of tempDirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});
describe("workflow prompt structure and inputs", () => {
  test("shared and phase prompts keep one balanced XML envelope", async () => {
    expect(sharedSystemPrompt).toContain("<system_prompt>");
    expect(sharedSystemPrompt).toContain("</system_prompt>");
    for (const prompt of await phasePrompts(context)) {
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
    expect(prompt).toContain(
      '<artifact kind="issue">../../runs/issue/123/issue.md</artifact>',
    );
    expect(prompt).toContain(
      '<artifact kind="triage">../../runs/issue/123/triage.json</artifact>',
    );
    expect(prompt).not.toContain(
      '<artifact kind="issue">.roark/runs/issue/123/issue.md</artifact>',
    );
  });
});
describe("structured review contract", () => {
  test("review agent B does not receive review agent A's artifact", async () => {
    const prompt = await runApplicationPromise(
      nativeWorkflowPrompts.reviewBPrompt(context, 0),
    );
    expect(prompt).not.toContain('artifact kind="review_a"');
  });
  test("later review passes receive only their own prior stable finding IDs", async () => {
    const reviewA = await runApplicationPromise(
      nativeWorkflowPrompts.reviewAPrompt(context, 1),
    );
    const reviewB = await runApplicationPromise(
      nativeWorkflowPrompts.reviewBPrompt(context, 1),
    );
    expect(reviewA).toContain(
      '<artifact kind="prior_review_a">.roark/runs/issue/123/review-a-0.json</artifact>',
    );
    expect(reviewA).not.toContain('kind="prior_review_b"');
    expect(reviewB).toContain(
      '<artifact kind="prior_review_b">.roark/runs/issue/123/review-b-0.json</artifact>',
    );
    expect(reviewB).not.toContain('kind="prior_review_a"');
  });
});
describe("fix and refinement prompt inputs", () => {
  test("restart code refinement prompt reads restarted implementation context instead of a fix log", async () => {
    const prompt = await runApplicationPromise(
      nativeWorkflowPrompts.codeRefinementPrompt(context, 1, "restart"),
    );
    expect(prompt).toContain('<artifact kind="implementation_log">');
    expect(prompt).toContain('<artifact kind="baseline_reset">');
    expect(prompt).toContain('<artifact kind="implementation_restart_log">');
    expect(prompt).not.toContain('<artifact kind="fix_log">');
  });
  test.each([0, 1])(
    "workflow prompts use only their pass's verification archive despite generic verification exit %i",
    async (exitCode) => {
      const runDir = await mkdtemp(
        path.join(tmpdir(), "roark-prompt-verification-"),
      );
      tempDirs.push(runDir);
      const verificationContext = {
        ...context,
        controlCwd: runDir,
        agentCwd: runDir,
        outDir: path.join(runDir, ".roark/runs"),
        runDir,
        runDirRelative: ".",
        maxFixPasses: 2,
      } satisfies WorkflowContext;
      await runApplicationPromise(
        writeArtifact(
          verificationContext,
          verificationBeforeFixRef(1),
          "# Verification\n\n## Exit Code\n1\n",
        ),
      );
      await runApplicationPromise(
        writeArtifact(
          verificationContext,
          "verification",
          `# Verification\n\n## Exit Code\n${exitCode}\n`,
        ),
      );
      expect(
        await runApplicationPromise(
          nativeWorkflowPrompts.fixPrompt(verificationContext, 1),
        ),
      ).toContain(
        '<artifact kind="failed_verification">verification-before-fix-1.md</artifact>',
      );
      expect(
        await runApplicationPromise(
          nativeWorkflowPrompts.codeRefinementPrompt(
            verificationContext,
            1,
            "fix",
          ),
        ),
      ).toContain(
        '<artifact kind="failed_verification">verification-before-fix-1.md</artifact>',
      );
      expect(
        await runApplicationPromise(
          nativeWorkflowPrompts.reviewAPrompt(verificationContext, 1),
        ),
      ).toContain(
        '<artifact kind="failed_verification">verification-before-fix-1.md</artifact>',
      );
      expect(
        await runApplicationPromise(
          nativeWorkflowPrompts.reviewBPrompt(verificationContext, 1),
        ),
      ).toContain(
        '<artifact kind="failed_verification">verification-before-fix-1.md</artifact>',
      );
      const nextPassPrompts = [
        nativeWorkflowPrompts.fixPrompt(verificationContext, 2),
        nativeWorkflowPrompts.codeRefinementPrompt(
          verificationContext,
          2,
          "fix",
        ),
        nativeWorkflowPrompts.reviewAPrompt(verificationContext, 2),
        nativeWorkflowPrompts.reviewBPrompt(verificationContext, 2),
      ];
      for (const prompt of nextPassPrompts) {
        const content = await runApplicationPromise(prompt);
        expect(content).not.toContain('kind="failed_verification"');
        expect(content).not.toContain("verification-before-fix-1.md");
      }
    },
  );
});
