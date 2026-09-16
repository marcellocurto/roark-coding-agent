export type ArtifactFamily = "review" | "change-report";
interface StaticArtifactMetadata {
  readonly name: string;
  readonly filename: string;
  readonly displayName: string;
  readonly family?: ArtifactFamily;
  readonly markdownSibling?: string;
}
interface NumberedArtifactMetadata {
  readonly name: string;
  readonly filenamePrefix: string;
  readonly filenameSuffix?: string;
  readonly displayName: string;
  readonly extension?: "md" | "json";
  readonly family?: ArtifactFamily;
  readonly markdownSibling?: string;
  readonly requiredHeadingPrefix?: string;
}
export type StaticArtifactName = (typeof STATIC_ARTIFACTS)[number]["name"];
export type NumberedArtifactName = (typeof NUMBERED_ARTIFACTS)[number]["name"];
export type ArtifactRef =
  | StaticArtifactName
  | { name: NumberedArtifactName; pass: number };
export interface StaticArtifactDefinition extends Omit<
  StaticArtifactMetadata,
  "name" | "markdownSibling"
> {
  readonly name: StaticArtifactName;
  readonly markdownSibling?: StaticArtifactName;
}
export interface NumberedArtifactDefinition extends Omit<
  NumberedArtifactMetadata,
  "name" | "markdownSibling"
> {
  readonly name: NumberedArtifactName;
  readonly markdownSibling?: NumberedArtifactName;
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

export const STATIC_ARTIFACTS = [
  {
    name: "continuationState",
    filename: "continuation-state.json",
    displayName: "Continuation checkpoint",
  },
  {
    name: "continuationInput",
    filename: "continuation-input.json",
    displayName: "Current issue feedback",
  },
  {
    name: "continuationReview",
    filename: "continuation-review.json",
    displayName: "Continuation review",
  },
  {
    name: "continuationReviewMarkdown",
    filename: "continuation-review.md",
    displayName: "Continuation review",
  },
  { name: "issue", filename: "issue.md", displayName: "Issue" },
  { name: "triage", filename: "triage.json", displayName: "Triage" },
  {
    name: "executionStop",
    filename: "execution-stop.json",
    displayName: "Active Execution Stop",
  },
  {
    name: "triageMarkdown",
    filename: "triage.md",
    displayName: "Triage Markdown",
  },
  {
    name: "implementationPlanDraft",
    filename: "implementation-plan-draft.json",
    displayName: "Implementation Plan Draft",
  },
  {
    name: "implementationPlanDraftMarkdown",
    filename: "implementation-plan-draft.md",
    displayName: "Implementation Plan Draft Markdown",
  },
  {
    name: "implementationPlan",
    filename: "implementation-plan.json",
    displayName: "Implementation Plan",
  },
  {
    name: "implementationPlanMarkdown",
    filename: "implementation-plan.md",
    displayName: "Implementation Plan Markdown",
  },
  {
    name: "preImplementationBaseline",
    filename: "pre-implementation-baseline.json",
    displayName: "Pre-implementation Baseline",
  },
  {
    name: "implementationLog",
    family: "change-report",
    markdownSibling: "implementationLogMarkdown",
    filename: "implementation-log.json",
    displayName: "Implementation Log",
  },
  {
    name: "implementationLogMarkdown",
    filename: "implementation-log.md",
    displayName: "Implementation Log Markdown",
  },
  { name: "prDraft", filename: "pr-draft.json", displayName: "PR Draft" },
  {
    name: "prDraftMarkdown",
    filename: "pr-draft.md",
    displayName: "PR Draft Markdown",
  },
  { name: "readiness", filename: "readiness.json", displayName: "Readiness" },
  {
    name: "readinessMarkdown",
    filename: "readiness.md",
    displayName: "Readiness Markdown",
  },
  {
    name: "verification",
    filename: "verification.md",
    displayName: "Verification",
  },
  {
    name: "verificationFull",
    filename: "verification-full.md",
    displayName: "Complete Verification",
  },
  { name: "metadata", filename: "metadata.json", displayName: "Metadata" },
  {
    name: "issueCurationPlan",
    filename: "issue-curation-plan.json",
    displayName: "Issue Curation Plan",
  },
  {
    name: "issueDrafts",
    filename: "issue-drafts.json",
    displayName: "Issue Drafts",
  },
  {
    name: "issueDraftsMarkdown",
    filename: "issue-drafts.md",
    displayName: "Issue Drafts Markdown",
  },
  {
    name: "issueCreationResults",
    filename: "issue-creation-results.json",
    displayName: "Issue Creation Results",
  },
] as const satisfies readonly StaticArtifactMetadata[];

export const NUMBERED_ARTIFACTS = [
  {
    name: "fixLog",
    family: "change-report",
    markdownSibling: "fixLogMarkdown",
    filenamePrefix: "fix-log",
    displayName: "Fix Log",
    extension: "json",
  },
  {
    name: "fixLogMarkdown",
    filenamePrefix: "fix-log",
    displayName: "Fix Log Markdown",
  },
  {
    name: "verificationBeforeFix",
    filenamePrefix: "verification-before-fix",
    displayName: "Verification Before Fix",
  },
  {
    name: "verificationBeforeFixFull",
    filenamePrefix: "verification-before-fix",
    filenameSuffix: "-full",
    displayName: "Complete Verification Before Fix",
  },
  {
    name: "implementationRestartLog",
    requiredHeadingPrefix: "Implementation Restart Log",
    filenamePrefix: "implementation-restart-log",
    displayName: "Implementation Restart Log",
  },
  {
    name: "refinementLog",
    family: "change-report",
    markdownSibling: "refinementLogMarkdown",
    filenamePrefix: "refinement-log",
    displayName: "Refinement Log",
    extension: "json",
  },
  {
    name: "refinementLogMarkdown",
    filenamePrefix: "refinement-log",
    displayName: "Refinement Log Markdown",
  },
  {
    name: "reviewA",
    family: "review",
    markdownSibling: "reviewAMarkdown",
    filenamePrefix: "review-a",
    displayName: "Review A",
    extension: "json",
  },
  {
    name: "reviewB",
    family: "review",
    markdownSibling: "reviewBMarkdown",
    filenamePrefix: "review-b",
    displayName: "Review B",
    extension: "json",
  },
  {
    name: "reviewAMarkdown",
    filenamePrefix: "review-a",
    displayName: "Review A Markdown",
  },
  {
    name: "reviewBMarkdown",
    filenamePrefix: "review-b",
    displayName: "Review B Markdown",
  },
  {
    name: "baselineResetLog",
    requiredHeadingPrefix: "Baseline Reset",
    filenamePrefix: "baseline-reset",
    displayName: "Baseline Reset",
  },
] as const satisfies readonly NumberedArtifactMetadata[];

export const ISSUE_CURATION_STATIC_ARTIFACT_REFS: readonly StaticArtifactName[] =
  [
    "issue",
    "metadata",
    "triage",
    "implementationPlanDraft",
    "implementationPlan",
    "implementationLog",
    "readiness",
    "verification",
  ] as const;

const staticDefinitions = new Map<StaticArtifactName, StaticArtifactDefinition>(
  STATIC_ARTIFACTS.map((artifact) => [artifact.name, artifact]),
);
const numberedDefinitions = new Map<
  NumberedArtifactName,
  NumberedArtifactDefinition
>(NUMBERED_ARTIFACTS.map((artifact) => [artifact.name, artifact]));

function staticArtifactByName(
  name: StaticArtifactName,
): StaticArtifactDefinition {
  const definition = staticDefinitions.get(name);
  if (!definition) throw new Error(`Unknown static artifact: ${name}`);
  return definition;
}
function numberedArtifactByName(
  name: NumberedArtifactName,
): NumberedArtifactDefinition {
  const definition = numberedDefinitions.get(name);
  if (!definition) throw new Error(`Unknown numbered artifact: ${name}`);
  return definition;
}
type ArtifactOfFamily<F extends ArtifactFamily> =
  | Extract<(typeof STATIC_ARTIFACTS)[number], { family: F }>["name"]
  | {
      name: Extract<(typeof NUMBERED_ARTIFACTS)[number], { family: F }>["name"];
      pass: number;
    };

export function artifactFamily(
  artifact: ArtifactRef,
): ArtifactFamily | undefined {
  return typeof artifact === "string"
    ? staticArtifactByName(artifact).family
    : numberedArtifactByName(artifact.name).family;
}
export function isReviewArtifact(
  artifact: ArtifactRef | undefined,
): artifact is ArtifactOfFamily<"review"> {
  return artifact !== undefined && artifactFamily(artifact) === "review";
}
export function isChangeReportArtifact(
  artifact: ArtifactRef | undefined,
): artifact is ArtifactOfFamily<"change-report"> {
  return artifact !== undefined && artifactFamily(artifact) === "change-report";
}
export function artifactMarkdownSibling(
  artifact: ArtifactRef,
): ArtifactRef | undefined {
  if (typeof artifact === "string")
    return staticArtifactByName(artifact).markdownSibling;
  const name = numberedArtifactByName(artifact.name).markdownSibling;
  return name === undefined ? undefined : { name, pass: artifact.pass };
}

export function fixLogRef(pass: number): { name: "fixLog"; pass: number } {
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

export function refinementLogRef(pass: number): {
  name: "refinementLog";
  pass: number;
} {
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
  if (typeof artifact === "string")
    return staticArtifactByName(artifact).filename;
  const definition = numberedArtifactByName(artifact.name);
  return `${definition.filenamePrefix}-${artifact.pass}${definition.filenameSuffix ?? ""}.${definition.extension ?? "md"}`;
}

export function formatArtifactRef(artifact: ArtifactRef): string {
  if (typeof artifact === "string") return artifact;
  return `${artifact.name}-${artifact.pass}`;
}

export function artifactIdentity(artifact: ArtifactRef): ArtifactIdentity {
  if (typeof artifact === "string") {
    const definition = staticArtifactByName(artifact);
    return {
      name: definition.name,
      kind: "static",
      filename: definition.filename,
      displayName: definition.displayName,
    };
  }

  const definition = numberedArtifactByName(artifact.name);
  return {
    name: definition.name,
    kind: "numbered",
    filename: artifactFilename(artifact),
    displayName: `${definition.displayName} Pass ${artifact.pass}`,
    pass: artifact.pass,
  };
}

export function artifactContract(
  artifact: ArtifactRef,
): ArtifactContract | undefined {
  if (typeof artifact === "string") return undefined;
  const prefix = numberedArtifactByName(artifact.name).requiredHeadingPrefix;
  return prefix === undefined
    ? {}
    : { requiredHeading: `${prefix} Pass ${artifact.pass}` };
}

export function artifactFromFilename(
  filename: string,
): ArtifactRef | undefined {
  const fixed = STATIC_ARTIFACTS.find((item) => item.filename === filename);
  if (fixed) return fixed.name;
  for (const item of numberedDefinitions.values()) {
    const prefix = `${item.filenamePrefix}-`;
    const suffix = `${item.filenameSuffix ?? ""}.${item.extension ?? "md"}`;
    if (!filename.startsWith(prefix) || !filename.endsWith(suffix)) continue;
    const pass = filename.slice(prefix.length, -suffix.length);
    if (/^\d+$/.test(pass) && Number.isSafeInteger(Number(pass)))
      return { name: item.name, pass: Number(pass) };
  }
  return undefined;
}
