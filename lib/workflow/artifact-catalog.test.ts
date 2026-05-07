import { describe, expect, test } from "bun:test";
import {
  artifactContract,
  artifactFilename,
  artifactIdentity,
  finalReviewRef,
  fixLogRef,
  formatArtifactRef,
  ISSUE_CURATION_STATIC_ARTIFACT_REFS,
  STATIC_ARTIFACTS,
  type StaticArtifactName,
} from "./artifact-catalog.ts";

const expectedStaticFilenames: Record<StaticArtifactName, string> = {
  issue: "issue.md",
  triage: "triage.md",
  implementationPlan: "implementation-plan.md",
  implementationLog: "implementation-log.md",
  reviewA: "review-a.md",
  reviewB: "review-b.md",
  readiness: "readiness.md",
  verification: "verification.md",
  metadata: "metadata.json",
  issueCurationPlan: "issue-curation-plan.json",
  issueCreationResults: "issue-creation-results.json",
};

describe("artifact catalog", () => {
  test("maps static artifacts to unchanged filenames", () => {
    expect(Object.fromEntries(STATIC_ARTIFACTS.map((artifact) => [artifact.name, artifact.filename]))).toEqual(expectedStaticFilenames);
    for (const [name, filename] of Object.entries(expectedStaticFilenames) as [StaticArtifactName, string][]) {
      expect(artifactFilename(name)).toBe(filename);
    }
  });

  test("constructs numbered artifact refs and filenames", () => {
    expect(fixLogRef(2)).toEqual({ name: "fixLog", pass: 2 });
    expect(finalReviewRef(3)).toEqual({ name: "finalReview", pass: 3 });
    expect(artifactFilename(fixLogRef(2))).toBe("fix-log-2.md");
    expect(artifactFilename(finalReviewRef(3))).toBe("final-review-3.md");
    expect(formatArtifactRef(fixLogRef(2))).toBe("fixLog-2");
  });

  test("exposes artifact identity metadata", () => {
    expect(artifactIdentity("implementationPlan")).toEqual({
      name: "implementationPlan",
      kind: "static",
      filename: "implementation-plan.md",
      displayName: "Implementation Plan",
    });
    expect(artifactIdentity(finalReviewRef(1))).toEqual({
      name: "finalReview",
      kind: "numbered",
      filename: "final-review-1.md",
      displayName: "Final Review Pass 1",
      pass: 1,
    });
  });

  test("exposes validation contract metadata without validation logic", () => {
    expect(artifactContract("triage")?.allowedVerdicts).toEqual([
      "proceed",
      "blocked",
      "reject",
      "needs-human-decision",
    ]);
    expect(artifactContract("implementationPlan")).toEqual({
      requiredHeading: "Implementation Plan",
      requiresReadyForImplementation: true,
    });
    expect(artifactContract(fixLogRef(4))).toEqual({ requiredHeading: "Fix Log Pass 4" });
    expect(artifactContract(finalReviewRef(1))?.allowedVerdicts).toEqual([
      "ready-for-pr",
      "fixes-required",
      "blocked",
    ]);
  });

  test("defines static artifacts available to issue curation in stable order", () => {
    expect(ISSUE_CURATION_STATIC_ARTIFACT_REFS).toEqual([
      "issue",
      "metadata",
      "triage",
      "implementationPlan",
      "implementationLog",
      "reviewA",
      "reviewB",
      "readiness",
      "verification",
    ]);
  });
});
