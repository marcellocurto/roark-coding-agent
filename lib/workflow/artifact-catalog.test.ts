import { describe, expect, test } from "bun:test";
import {
  artifactFilename,
  fixLogRef,
  fixLogMarkdownRef,
  formatArtifactRef,
  implementationRestartLogRef,
  refinementLogRef,
  refinementLogMarkdownRef,
  reviewAMarkdownRef,
  reviewARef,
  reviewBMarkdownRef,
  verificationBeforeFixRef,
  verificationBeforeFixFullRef,
  type StaticArtifactName,
} from "./artifact-catalog.ts";

const expectedStaticFilenames: Record<StaticArtifactName, string> = {
  issue: "issue.md",
  triage: "triage.json",
  triageMarkdown: "triage.md",
  implementationPlanDraft: "implementation-plan-draft.json",
  implementationPlanDraftMarkdown: "implementation-plan-draft.md",
  implementationPlan: "implementation-plan.json",
  implementationPlanMarkdown: "implementation-plan.md",
  preImplementationBaseline: "pre-implementation-baseline.json",
  implementationLog: "implementation-log.json",
  implementationLogMarkdown: "implementation-log.md",
      prDraft: "pr-draft.json",
      prDraftMarkdown: "pr-draft.md",
  readiness: "readiness.json",
  readinessMarkdown: "readiness.md",
  verification: "verification.md",
  verificationFull: "verification-full.md",
  metadata: "metadata.json",
      issueCurationPlan: "issue-curation-plan.json",
      issueDrafts: "issue-drafts.json",
      issueDraftsMarkdown: "issue-drafts.md",
      issueCreationResults: "issue-creation-results.json",
};

describe("artifact catalog", () => {
  test("resolves persisted static artifact filenames", () => {
    for (const [name, filename] of Object.entries(expectedStaticFilenames) as [StaticArtifactName, string][]) {
      expect(artifactFilename(name)).toBe(filename);
    }
  });

  test("resolves persisted numbered artifact filenames", () => {
    expect(artifactFilename(fixLogRef(2))).toBe("fix-log-2.json");
    expect(artifactFilename(fixLogMarkdownRef(2))).toBe("fix-log-2.md");
    expect(artifactFilename(verificationBeforeFixRef(1))).toBe("verification-before-fix-1.md");
    expect(artifactFilename(verificationBeforeFixFullRef(1))).toBe("verification-before-fix-1-full.md");
    expect(artifactFilename(implementationRestartLogRef(1))).toBe("implementation-restart-log-1.md");
    expect(artifactFilename(refinementLogRef(0))).toBe("refinement-log-0.json");
    expect(artifactFilename(refinementLogMarkdownRef(0))).toBe("refinement-log-0.md");
    expect(artifactFilename(reviewARef(2))).toBe("review-a-2.json");
    expect(artifactFilename(reviewAMarkdownRef(2))).toBe("review-a-2.md");
    expect(artifactFilename(reviewBMarkdownRef(2))).toBe("review-b-2.md");
    expect(formatArtifactRef(fixLogRef(2))).toBe("fixLog-2");
  });
});
