import { describe, expect, test } from "bun:test";
import { createWorkflowContext } from "../workflow/artifacts.ts";
import { issuePublishingPrompt } from "./issue-publishing-prompt.ts";

describe("issuePublishingPrompt", () => {
  test("requires using the pinned skill and keeps the curation plan authoritative", () => {
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
      allowedItems: [{ planItemId: "follow-up-1", kind: "follow-up", title: "Follow-up", labels: ["needs-triage"] }],
    });

    expect(prompt).toContain("Read and follow the available `github-issue-create` skill");
    expect(prompt).toContain("duplicate-search, label, body-file, parent/sub-issue, blocked-by relationship");
    expect(prompt).toContain("The curation plan at `.roark/runs/issue/12/attempts/2/issue-curation-plan.json` is the only source of truth");
    expect(prompt).toContain("Do not create issues for rejected candidates");
    expect(prompt).toContain("follow-up-1");
    expect(prompt).toContain("Return only JSON");
  });
});
