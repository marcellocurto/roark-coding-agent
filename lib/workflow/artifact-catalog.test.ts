import { describe, expect, test } from "bun:test";
import {
  artifactFilename,
  fixLogRef,
  formatArtifactRef,
  implementationRestartLogRef,
  refinementLogRef,
  reviewARef,
  verificationBeforeFixRef,
  verificationBeforeFixFullRef,
  type StaticArtifactName,
} from "./artifact-catalog.ts";

const expectedStaticFilenames: Record<StaticArtifactName, string> = {
  issue: "issue.md",
  triage: "triage.md",
  implementationPlanDraft: "implementation-plan-draft.md",
  implementationPlan: "implementation-plan.md",
  preImplementationBaseline: "pre-implementation-baseline.json",
  implementationLog: "implementation-log.md",
  prNarrative: "pr-narrative.md",
  reviewA: "review-a.md",
  reviewB: "review-b.md",
  readiness: "readiness.md",
  verification: "verification.md",
  verificationFull: "verification-full.md",
  metadata: "metadata.json",
  issueCurationPlan: "issue-curation-plan.json",
  issueCreationResults: "issue-creation-results.json",
};

describe("artifact catalog", () => {
  test("resolves persisted static artifact filenames", () => {
    for (const [name, filename] of Object.entries(expectedStaticFilenames) as [StaticArtifactName, string][]) {
      expect(artifactFilename(name)).toBe(filename);
    }
  });

  test("resolves persisted numbered artifact filenames", () => {
    expect(artifactFilename(fixLogRef(2))).toBe("fix-log-2.md");
    expect(artifactFilename(verificationBeforeFixRef(1))).toBe("verification-before-fix-1.md");
    expect(artifactFilename(verificationBeforeFixFullRef(1))).toBe("verification-before-fix-1-full.md");
    expect(artifactFilename(implementationRestartLogRef(1))).toBe("implementation-restart-log-1.md");
    expect(artifactFilename(refinementLogRef(0))).toBe("refinement-log-0.md");
    expect(artifactFilename(reviewARef(2))).toBe("review-a-2.md");
    expect(formatArtifactRef(fixLogRef(2))).toBe("fixLog-2");
  });
});
