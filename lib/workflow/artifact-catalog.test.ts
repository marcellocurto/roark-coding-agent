import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { validateAgentArtifact } from "./artifact-validation.ts";
import {
  artifactFilename,
  artifactFromFilename,
  artifactMarkdownSibling,
  type ArtifactRef,
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
  STATIC_ARTIFACTS,
} from "./artifact-catalog.ts";

const expectedStaticFilenames: Record<StaticArtifactName, string> = {
  issue: "issue.md",
  continuationState: "continuation-state.json",
  continuationInput: "continuation-input.json",
  continuationReview: "continuation-review.json",
  continuationReviewMarkdown: "continuation-review.md",
  executionStop: "execution-stop.json",
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
  test.each([
    { canonical: "implementationLog", markdown: "implementationLogMarkdown" },
    {
      canonical: { name: "fixLog", pass: 2 },
      markdown: { name: "fixLogMarkdown", pass: 2 },
    },
    {
      canonical: { name: "refinementLog", pass: 2 },
      markdown: { name: "refinementLogMarkdown", pass: 2 },
    },
    {
      canonical: { name: "reviewA", pass: 2 },
      markdown: { name: "reviewAMarkdown", pass: 2 },
    },
    {
      canonical: { name: "reviewB", pass: 2 },
      markdown: { name: "reviewBMarkdown", pass: 2 },
    },
  ] satisfies { canonical: ArtifactRef; markdown: ArtifactRef }[])(
    "keeps structured artifacts distinct from Markdown companions: %j",
    async ({ canonical, markdown }) => {
      const humanReport = "# Report\n\n## Summary\nCompleted the phase.\n";
      expect(artifactMarkdownSibling(canonical)).toEqual(markdown);
      expect(artifactFromFilename(artifactFilename(canonical))).toEqual(
        canonical,
      );
      expect(artifactFromFilename(artifactFilename(markdown))).toEqual(
        markdown,
      );
      expect(
        (await Effect.runPromise(validateAgentArtifact(canonical, humanReport)))
          .ok,
      ).toBe(false);
      expect(
        (await Effect.runPromise(validateAgentArtifact(markdown, humanReport)))
          .ok,
      ).toBe(true);
    },
  );
  test("resolves persisted static artifact filenames", () => {
    for (const [name, filename] of Object.entries(expectedStaticFilenames)) {
      const definition = STATIC_ARTIFACTS.find(
        (artifact) => artifact.name === name,
      );
      if (!definition) throw new Error(`Missing artifact definition: ${name}`);
      expect(artifactFilename(definition.name)).toBe(filename);
    }
  });

  test("resolves persisted numbered artifact filenames", () => {
    expect(artifactFilename(fixLogRef(2))).toBe("fix-log-2.json");
    expect(artifactFilename(fixLogMarkdownRef(2))).toBe("fix-log-2.md");
    expect(artifactFilename(verificationBeforeFixRef(1))).toBe(
      "verification-before-fix-1.md",
    );
    expect(artifactFilename(verificationBeforeFixFullRef(1))).toBe(
      "verification-before-fix-1-full.md",
    );
    expect(artifactFilename(implementationRestartLogRef(1))).toBe(
      "implementation-restart-log-1.md",
    );
    expect(artifactFilename(refinementLogRef(0))).toBe("refinement-log-0.json");
    expect(artifactFilename(refinementLogMarkdownRef(0))).toBe(
      "refinement-log-0.md",
    );
    expect(artifactFilename(reviewARef(2))).toBe("review-a-2.json");
    expect(artifactFilename(reviewAMarkdownRef(2))).toBe("review-a-2.md");
    expect(artifactFilename(reviewBMarkdownRef(2))).toBe("review-b-2.md");
    expect(formatArtifactRef(fixLogRef(2))).toBe("fixLog-2");
  });
});
