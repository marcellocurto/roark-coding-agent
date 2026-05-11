export type StaticArtifactName =
  | "issue"
  | "triage"
  | "implementationPlanDraft"
  | "implementationPlan"
  | "preImplementationBaseline"
  | "implementationLog"
  | "reviewA"
  | "reviewB"
  | "readiness"
  | "verification"
  | "metadata"
  | "issueCurationPlan"
  | "issueCreationResults";

export type NumberedArtifactName =
  | "fixLog"
  | "finalReview"
  | "verificationBeforeFix"
  | "implementationRestartLog"
  | "refinementLog"
  | "reviewA"
  | "reviewB"
  | "baselineResetLog";

export type ArtifactRef = StaticArtifactName | { name: NumberedArtifactName; pass: number };

export type StaticArtifactDefinition = {
  readonly name: StaticArtifactName;
  readonly filename: string;
  readonly displayName: string;
};

export type NumberedArtifactDefinition = {
  readonly name: NumberedArtifactName;
  readonly filenamePrefix: string;
  readonly displayName: string;
};

export type ArtifactIdentity = {
  readonly name: StaticArtifactName | NumberedArtifactName;
  readonly kind: "static" | "numbered";
  readonly filename: string;
  readonly displayName: string;
  readonly pass?: number;
};

export type ArtifactContract = {
  readonly allowedVerdicts?: readonly string[];
  readonly requiredHeading?: string;
  readonly requiresReadyForImplementation?: true;
};

export const REVIEW_VERDICTS = ["approve", "fixes-required", "restart-required", "blocked"] as const;

export const STATIC_ARTIFACTS: readonly StaticArtifactDefinition[] = [
  { name: "issue", filename: "issue.md", displayName: "Issue" },
  { name: "triage", filename: "triage.md", displayName: "Triage" },
  { name: "implementationPlanDraft", filename: "implementation-plan-draft.md", displayName: "Implementation Plan Draft" },
  { name: "implementationPlan", filename: "implementation-plan.md", displayName: "Implementation Plan" },
  { name: "preImplementationBaseline", filename: "pre-implementation-baseline.json", displayName: "Pre-implementation Baseline" },
  { name: "implementationLog", filename: "implementation-log.md", displayName: "Implementation Log" },
  { name: "reviewA", filename: "review-a.md", displayName: "Review A" },
  { name: "reviewB", filename: "review-b.md", displayName: "Review B" },
  { name: "readiness", filename: "readiness.md", displayName: "Readiness" },
  { name: "verification", filename: "verification.md", displayName: "Verification" },
  { name: "metadata", filename: "metadata.json", displayName: "Metadata" },
  { name: "issueCurationPlan", filename: "issue-curation-plan.json", displayName: "Issue Curation Plan" },
  { name: "issueCreationResults", filename: "issue-creation-results.json", displayName: "Issue Creation Results" },
] as const;

export const NUMBERED_ARTIFACTS: readonly NumberedArtifactDefinition[] = [
  { name: "fixLog", filenamePrefix: "fix-log", displayName: "Fix Log" },
  { name: "finalReview", filenamePrefix: "final-review", displayName: "Final Review" },
  { name: "verificationBeforeFix", filenamePrefix: "verification-before-fix", displayName: "Verification Before Fix" },
  { name: "implementationRestartLog", filenamePrefix: "implementation-restart-log", displayName: "Implementation Restart Log" },
  { name: "refinementLog", filenamePrefix: "refinement-log", displayName: "Refinement Log" },
  { name: "reviewA", filenamePrefix: "review-a", displayName: "Review A" },
  { name: "reviewB", filenamePrefix: "review-b", displayName: "Review B" },
  { name: "baselineResetLog", filenamePrefix: "baseline-reset", displayName: "Baseline Reset" },
] as const;

export const ISSUE_CURATION_STATIC_ARTIFACT_REFS: readonly StaticArtifactName[] = [
  "issue",
  "metadata",
  "triage",
  "implementationPlanDraft",
  "implementationPlan",
  "implementationLog",
  "reviewA",
  "reviewB",
  "readiness",
  "verification",
] as const;

const staticArtifactByName = Object.fromEntries(
  STATIC_ARTIFACTS.map((artifact) => [artifact.name, artifact]),
) as Record<StaticArtifactName, StaticArtifactDefinition>;

const numberedArtifactByName = Object.fromEntries(
  NUMBERED_ARTIFACTS.map((artifact) => [artifact.name, artifact]),
) as Record<NumberedArtifactName, NumberedArtifactDefinition>;

const staticContracts: Partial<Record<StaticArtifactName, ArtifactContract>> = {
  triage: { allowedVerdicts: ["proceed", "blocked", "reject", "needs-human-decision"] },
  implementationPlanDraft: {
    requiredHeading: "Implementation Plan Draft",
    requiresReadyForImplementation: true,
  },
  implementationPlan: {
    requiredHeading: "Implementation Plan",
    requiresReadyForImplementation: true,
  },
  implementationLog: { requiredHeading: "Implementation Log" },
  reviewA: { allowedVerdicts: REVIEW_VERDICTS },
  reviewB: { allowedVerdicts: REVIEW_VERDICTS },
};

const numberedContracts: Record<NumberedArtifactName, (pass: number) => ArtifactContract> = {
  fixLog: (pass) => ({ requiredHeading: `Fix Log Pass ${pass}` }),
  finalReview: () => ({ allowedVerdicts: ["ready-for-pr", "fixes-required", "blocked"] }),
  verificationBeforeFix: () => ({}),
  implementationRestartLog: (pass) => ({ requiredHeading: `Implementation Restart Log Pass ${pass}` }),
  refinementLog: (pass) => ({ requiredHeading: `Refinement Log Pass ${pass}` }),
  reviewA: (pass) => ({ requiredHeading: `Review A Pass ${pass}`, allowedVerdicts: REVIEW_VERDICTS }),
  reviewB: (pass) => ({ requiredHeading: `Review B Pass ${pass}`, allowedVerdicts: REVIEW_VERDICTS }),
  baselineResetLog: (pass) => ({ requiredHeading: `Baseline Reset Pass ${pass}` }),
};

export function fixLogRef(pass: number): ArtifactRef {
  return { name: "fixLog", pass };
}

export function finalReviewRef(pass: number): ArtifactRef {
  return { name: "finalReview", pass };
}

export function verificationBeforeFixRef(pass: number): ArtifactRef {
  return { name: "verificationBeforeFix", pass };
}

export function implementationRestartLogRef(pass: number): ArtifactRef {
  return { name: "implementationRestartLog", pass };
}

export function refinementLogRef(pass: number): ArtifactRef {
  return { name: "refinementLog", pass };
}

export function reviewARef(pass: number): ArtifactRef {
  return { name: "reviewA", pass };
}

export function reviewBRef(pass: number): ArtifactRef {
  return { name: "reviewB", pass };
}

export function baselineResetLogRef(pass: number): ArtifactRef {
  return { name: "baselineResetLog", pass };
}

export function artifactFilename(artifact: ArtifactRef): string {
  if (typeof artifact === "string") return staticArtifactByName[artifact].filename;
  return `${numberedArtifactByName[artifact.name].filenamePrefix}-${artifact.pass}.md`;
}

export function formatArtifactRef(artifact: ArtifactRef): string {
  if (typeof artifact === "string") return artifact;
  return `${artifact.name}-${artifact.pass}`;
}

export function artifactIdentity(artifact: ArtifactRef): ArtifactIdentity {
  if (typeof artifact === "string") {
    const definition = staticArtifactByName[artifact];
    return {
      name: definition.name,
      kind: "static",
      filename: definition.filename,
      displayName: definition.displayName,
    };
  }

  const definition = numberedArtifactByName[artifact.name];
  return {
    name: definition.name,
    kind: "numbered",
    filename: artifactFilename(artifact),
    displayName: `${definition.displayName} Pass ${artifact.pass}`,
    pass: artifact.pass,
  };
}

export function artifactContract(artifact: ArtifactRef): ArtifactContract | undefined {
  if (typeof artifact === "string") return staticContracts[artifact];
  return numberedContracts[artifact.name](artifact.pass);
}
