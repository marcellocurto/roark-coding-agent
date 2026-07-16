export type StaticArtifactName =
  | "issue"
  | "triage"
  | "triageMarkdown"
  | "implementationPlanDraft"
  | "implementationPlanDraftMarkdown"
  | "implementationPlan"
  | "implementationPlanMarkdown"
  | "preImplementationBaseline"
  | "implementationLog"
  | "implementationLogMarkdown"
  | "prDraft"
  | "prDraftMarkdown"
  | "readiness"
  | "readinessMarkdown"
  | "verification"
  | "verificationFull"
  | "metadata"
  | "issueCurationPlan"
  | "issueDrafts"
  | "issueDraftsMarkdown"
  | "issueCreationResults";

export type NumberedArtifactName =
  | "fixLog"
  | "fixLogMarkdown"
  | "verificationBeforeFix"
  | "verificationBeforeFixFull"
  | "implementationRestartLog"
  | "refinementLog"
  | "refinementLogMarkdown"
  | "reviewA"
  | "reviewB"
  | "reviewAMarkdown"
  | "reviewBMarkdown"
  | "baselineResetLog";

export type ArtifactRef = StaticArtifactName | { name: NumberedArtifactName; pass: number };

export interface StaticArtifactDefinition {
  readonly name: StaticArtifactName;
  readonly filename: string;
  readonly displayName: string;
}

export interface NumberedArtifactDefinition {
  readonly name: NumberedArtifactName;
  readonly filenamePrefix: string;
  readonly filenameSuffix?: string;
  readonly displayName: string;
  readonly extension?: "md" | "json" | undefined;
}

export interface ArtifactIdentity {
  readonly name: StaticArtifactName | NumberedArtifactName;
  readonly kind: "static" | "numbered";
  readonly filename: string;
  readonly displayName: string;
  readonly pass?: number | undefined;
}

export interface ArtifactContract {
  readonly requiredHeading?: string;
}

export const STATIC_ARTIFACTS: readonly StaticArtifactDefinition[] = [
  { name: "issue", filename: "issue.md", displayName: "Issue" },
  { name: "triage", filename: "triage.json", displayName: "Triage" },
  { name: "triageMarkdown", filename: "triage.md", displayName: "Triage Markdown" },
  { name: "implementationPlanDraft", filename: "implementation-plan-draft.json", displayName: "Implementation Plan Draft" },
  { name: "implementationPlanDraftMarkdown", filename: "implementation-plan-draft.md", displayName: "Implementation Plan Draft Markdown" },
  { name: "implementationPlan", filename: "implementation-plan.json", displayName: "Implementation Plan" },
  { name: "implementationPlanMarkdown", filename: "implementation-plan.md", displayName: "Implementation Plan Markdown" },
  { name: "preImplementationBaseline", filename: "pre-implementation-baseline.json", displayName: "Pre-implementation Baseline" },
  { name: "implementationLog", filename: "implementation-log.json", displayName: "Implementation Log" },
  { name: "implementationLogMarkdown", filename: "implementation-log.md", displayName: "Implementation Log Markdown" },
  { name: "prDraft", filename: "pr-draft.json", displayName: "PR Draft" },
  { name: "prDraftMarkdown", filename: "pr-draft.md", displayName: "PR Draft Markdown" },
  { name: "readiness", filename: "readiness.json", displayName: "Readiness" },
  { name: "readinessMarkdown", filename: "readiness.md", displayName: "Readiness Markdown" },
  { name: "verification", filename: "verification.md", displayName: "Verification" },
  { name: "verificationFull", filename: "verification-full.md", displayName: "Complete Verification" },
  { name: "metadata", filename: "metadata.json", displayName: "Metadata" },
  { name: "issueCurationPlan", filename: "issue-curation-plan.json", displayName: "Issue Curation Plan" },
  { name: "issueDrafts", filename: "issue-drafts.json", displayName: "Issue Drafts" },
  { name: "issueDraftsMarkdown", filename: "issue-drafts.md", displayName: "Issue Drafts Markdown" },
  { name: "issueCreationResults", filename: "issue-creation-results.json", displayName: "Issue Creation Results" },
] as const;

export const NUMBERED_ARTIFACTS: readonly NumberedArtifactDefinition[] = [
  { name: "fixLog", filenamePrefix: "fix-log", displayName: "Fix Log", extension: "json" },
  { name: "fixLogMarkdown", filenamePrefix: "fix-log", displayName: "Fix Log Markdown" },
  { name: "verificationBeforeFix", filenamePrefix: "verification-before-fix", displayName: "Verification Before Fix" },
  { name: "verificationBeforeFixFull", filenamePrefix: "verification-before-fix", filenameSuffix: "-full", displayName: "Complete Verification Before Fix" },
  { name: "implementationRestartLog", filenamePrefix: "implementation-restart-log", displayName: "Implementation Restart Log" },
  { name: "refinementLog", filenamePrefix: "refinement-log", displayName: "Refinement Log", extension: "json" },
  { name: "refinementLogMarkdown", filenamePrefix: "refinement-log", displayName: "Refinement Log Markdown" },
  { name: "reviewA", filenamePrefix: "review-a", displayName: "Review A", extension: "json" },
  { name: "reviewB", filenamePrefix: "review-b", displayName: "Review B", extension: "json" },
  { name: "reviewAMarkdown", filenamePrefix: "review-a", displayName: "Review A Markdown" },
  { name: "reviewBMarkdown", filenamePrefix: "review-b", displayName: "Review B Markdown" },
  { name: "baselineResetLog", filenamePrefix: "baseline-reset", displayName: "Baseline Reset" },
] as const;

export const ISSUE_CURATION_STATIC_ARTIFACT_REFS: readonly StaticArtifactName[] = [
  "issue",
  "metadata",
  "triage",
  "implementationPlanDraft",
  "implementationPlan",
  "implementationLog",
  "readiness",
  "verification",
] as const;

const staticArtifactByName = Object.fromEntries(
  STATIC_ARTIFACTS.map((artifact) => [artifact.name, artifact]),
) as Record<StaticArtifactName, StaticArtifactDefinition>;

const numberedArtifactByName = Object.fromEntries(
  NUMBERED_ARTIFACTS.map((artifact) => [artifact.name, artifact]),
) as Record<NumberedArtifactName, NumberedArtifactDefinition>;

const staticContracts: Partial<Record<StaticArtifactName, ArtifactContract>> = {};

const numberedContracts: Record<NumberedArtifactName, (pass: number) => ArtifactContract> = {
  fixLog: () => ({}),
  fixLogMarkdown: () => ({}),
  verificationBeforeFix: () => ({}),
  verificationBeforeFixFull: () => ({}),
  implementationRestartLog: (pass) => ({ requiredHeading: `Implementation Restart Log Pass ${pass}` }),
  refinementLog: () => ({}),
  refinementLogMarkdown: () => ({}),
  reviewA: () => ({}),
  reviewB: () => ({}),
  reviewAMarkdown: () => ({}),
  reviewBMarkdown: () => ({}),
  baselineResetLog: (pass) => ({ requiredHeading: `Baseline Reset Pass ${pass}` }),
};

export function fixLogRef(pass: number): ArtifactRef {
  return { name: "fixLog", pass };
}

export function fixLogMarkdownRef(pass: number): ArtifactRef {
  return { name: "fixLogMarkdown", pass };
}

export function verificationBeforeFixRef(pass: number): ArtifactRef {
  return { name: "verificationBeforeFix", pass };
}

export function verificationBeforeFixFullRef(pass: number): ArtifactRef {
  return { name: "verificationBeforeFixFull", pass };
}

export function implementationRestartLogRef(pass: number): ArtifactRef {
  return { name: "implementationRestartLog", pass };
}

export function refinementLogRef(pass: number): ArtifactRef {
  return { name: "refinementLog", pass };
}

export function refinementLogMarkdownRef(pass: number): ArtifactRef {
  return { name: "refinementLogMarkdown", pass };
}

export function reviewARef(pass: number): ArtifactRef {
  return { name: "reviewA", pass };
}

export function reviewBRef(pass: number): ArtifactRef {
  return { name: "reviewB", pass };
}

export function reviewAMarkdownRef(pass: number): ArtifactRef {
  return { name: "reviewAMarkdown", pass };
}

export function reviewBMarkdownRef(pass: number): ArtifactRef {
  return { name: "reviewBMarkdown", pass };
}

export function baselineResetLogRef(pass: number): ArtifactRef {
  return { name: "baselineResetLog", pass };
}

export function artifactFilename(artifact: ArtifactRef): string {
  if (typeof artifact === "string") return staticArtifactByName[artifact].filename;
  const definition = numberedArtifactByName[artifact.name];
  return `${definition.filenamePrefix}-${artifact.pass}${definition.filenameSuffix ?? ""}.${definition.extension ?? "md"}`;
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
