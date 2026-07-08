import { describe, expect, test } from "bun:test";
import { createWorkflowContext } from "../workflow/artifacts.ts";
import { issuePublishingPrompt } from "./issue-publishing-prompt.ts";

describe("issuePublishingPrompt", () => {
  test("requires agent-authored issue bodies and keeps the curation plan authoritative", () => {
    const context = createWorkflowContext({
      command: "create-issues",
      issue: "12",
      cwd: "/repo",
      outDir: ".roark/runs",
      repo: "owner/repo",
      force: false,
      yes: true,
      maxFixPasses: 1,
      attempt: 2,
    });

    const prompt = issuePublishingPrompt({
      context,
      allowedItems: [{ planItemId: "follow-up-1", kind: "follow-up", suggestedTitle: "Follow-up", labels: ["needs-triage"] }],
    });

    expect(prompt).toContain("The curation plan at `.roark/runs/issue/12/attempts/2/issue-curation-plan.json` is the source of truth");
    expect(prompt).toContain("Do not create issues for rejected candidates");
    expect(prompt).toContain("write the final GitHub issue title and body yourself");
    expect(prompt).toContain("Do not copy the plan's proposedBody as the final body");
    expect(prompt).toContain("Before the regular issue body sections, add a top-level `## Simple summary` section");
    expect(prompt).toContain("busy maintainer");
    expect(prompt).toContain("Summary, Why this issue exists, Impact, Suggested fix, Acceptance criteria, Risks / non-goals, Context");
    expect(prompt).toContain("search likely duplicates");
    expect(prompt).toContain("follow-up-1");
    expect(prompt).toContain("Return only JSON");
  });
});
