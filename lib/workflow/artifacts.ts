import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { IssueCliOptions, ThinkingLevel } from "../cli/args.ts";
import { parseIssueRef } from "../github/issue.ts";

export type StaticArtifactName =
  | "issue"
  | "triage"
  | "implementationPlan"
  | "implementationLog"
  | "reviewA"
  | "reviewB"
  | "readiness"
  | "verification"
  | "metadata"
  | "issueCurationPlan"
  | "issueCreationResults";

export type NumberedArtifactName = "fixLog" | "finalReview";

export type ArtifactRef = StaticArtifactName | { name: NumberedArtifactName; pass: number };

export type WorkflowContext = {
  cwd: string;
  outDir: string;
  runDir: string;
  runDirRelative: string;
  issueInput: string;
  issueNumber: string;
  attempt?: number;
  repo?: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  force: boolean;
  yes: boolean;
  maxFixPasses: number;
  fixPass?: number;
  observer?: import("../observability/observer.ts").RunObserver;
};

const filenames: Record<StaticArtifactName, string> = {
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

export function fixLogRef(pass: number): ArtifactRef {
  return { name: "fixLog", pass };
}

export function finalReviewRef(pass: number): ArtifactRef {
  return { name: "finalReview", pass };
}

export function createWorkflowContext(options: IssueCliOptions): WorkflowContext {
  const cwd = path.resolve(options.cwd);
  const parsed = parseIssueRef(options.issue, options.repo);
  const outDir = path.resolve(cwd, options.outDir);
  const issueDir = path.join(outDir, "issue", parsed.issueNumber);
  const runDir = options.attempt !== undefined
    ? path.join(issueDir, "attempts", String(options.attempt))
    : issueDir;
  const runDirRelative = path.relative(cwd, runDir) || ".";

  return {
    cwd,
    outDir,
    runDir,
    runDirRelative,
    issueInput: options.issue,
    issueNumber: parsed.issueNumber,
    attempt: options.attempt,
    repo: parsed.repo,
    model: options.model,
    thinkingLevel: options.thinkingLevel,
    force: options.force,
    yes: options.yes,
    maxFixPasses: options.maxFixPasses,
    fixPass: options.fixPass,
  };
}

export function artifactPath(context: WorkflowContext, artifact: ArtifactRef): string {
  return path.join(context.runDir, artifactFilename(artifact));
}

export function artifactRelativePath(context: WorkflowContext, artifact: ArtifactRef): string {
  return path.join(context.runDirRelative, artifactFilename(artifact));
}

export async function ensureRunDir(context: WorkflowContext): Promise<void> {
  await mkdir(context.runDir, { recursive: true });
}

export function artifactExists(context: WorkflowContext, artifact: ArtifactRef): boolean {
  return existsSync(artifactPath(context, artifact));
}

export async function readArtifact(context: WorkflowContext, artifact: ArtifactRef): Promise<string> {
  return readFile(artifactPath(context, artifact), "utf8");
}

export async function writeArtifact(context: WorkflowContext, artifact: ArtifactRef, content: string): Promise<void> {
  await ensureRunDir(context);
  await writeFile(artifactPath(context, artifact), content.endsWith("\n") ? content : `${content}\n`, "utf8");
}

export async function writeJsonArtifact(context: WorkflowContext, artifact: StaticArtifactName, value: unknown): Promise<void> {
  await writeArtifact(context, artifact, JSON.stringify(value, null, 2));
}

export async function produceArtifact(
  context: WorkflowContext,
  artifact: ArtifactRef,
  label: string,
  produce: () => Promise<string>,
): Promise<string> {
  if (!context.force && artifactExists(context, artifact)) {
    console.log(`✓ ${label}: using existing ${artifactRelativePath(context, artifact)}`);
    return readArtifact(context, artifact);
  }

  console.log(`\n=== ${label} ===`);
  const content = await produce();
  await writeArtifact(context, artifact, content);
  console.log(`\n✓ ${label}: wrote ${artifactRelativePath(context, artifact)}`);
  return content;
}

export function requireArtifacts(context: WorkflowContext, ...artifacts: ArtifactRef[]): void {
  const missing = artifacts.filter((artifact) => !artifactExists(context, artifact));
  if (missing.length === 0) return;
  throw new Error(`Missing prerequisite artifact(s): ${missing.map(formatArtifactRef).join(", ")}. Run earlier phases or use 'do'.`);
}

export function inferNextFixPass(context: WorkflowContext): number {
  for (let pass = 1; ; pass++) {
    if (!artifactExists(context, fixLogRef(pass))) return pass;
    if (!artifactExists(context, finalReviewRef(pass))) {
      throw new Error(`Fix pass ${pass} already exists. Run final-review before starting another fix pass.`);
    }
  }
}

export function inferNextFinalReviewPass(context: WorkflowContext): number {
  for (let pass = 1; ; pass++) {
    if (!artifactExists(context, fixLogRef(pass))) break;
    if (!artifactExists(context, finalReviewRef(pass))) return pass;
  }
  throw new Error("No fix pass is ready for final review. Run 'fix' first or pass --fix-pass.");
}

export function latestFinalReviewPass(context: WorkflowContext): number | undefined {
  let latest: number | undefined;
  for (let pass = 1; artifactExists(context, finalReviewRef(pass)); pass++) {
    latest = pass;
  }
  return latest;
}

export function formatArtifactRef(artifact: ArtifactRef): string {
  if (typeof artifact === "string") return artifact;
  return `${artifact.name}-${artifact.pass}`;
}

function artifactFilename(artifact: ArtifactRef): string {
  if (typeof artifact === "string") return filenames[artifact];
  const prefix = artifact.name === "fixLog" ? "fix-log" : "final-review";
  return `${prefix}-${artifact.pass}.md`;
}
