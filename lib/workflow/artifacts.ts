import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { IssueCliOptions, ThinkingLevel } from "../cli/args.ts";
import { getWorkflowThinkingConfig, type ThinkingProfileName, type WorkflowThinkingConfig } from "./thinking.ts";
import { parseIssueRef } from "../github/issue.ts";
import { artifactFilename, finalReviewRef, fixLogRef, formatArtifactRef, verificationBeforeFixRef } from "./artifact-catalog.ts";
import type { ArtifactRef, StaticArtifactName } from "./artifact-catalog.ts";
export type { ArtifactRef, NumberedArtifactName, StaticArtifactName } from "./artifact-catalog.ts";
export { artifactFilename, finalReviewRef, fixLogRef, formatArtifactRef, verificationBeforeFixRef } from "./artifact-catalog.ts";

export type WorkflowContext = {
  controlCwd: string;
  agentCwd: string;
  outDir: string;
  runDir: string;
  runDirRelative: string;
  issueInput: string;
  issueNumber: string;
  attempt?: number;
  repo?: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  thinkingProfile?: ThinkingProfileName;
  thinkingConfig: WorkflowThinkingConfig;
  force: boolean;
  yes: boolean;
  maxFixPasses: number;
  fixPass?: number;
  observer?: import("../observability/observer.ts").RunObserver;
};

export function createWorkflowContext(
  options: IssueCliOptions,
  overrides: { agentCwd?: string } = {},
): WorkflowContext {
  const controlCwd = path.resolve(options.cwd);
  const agentCwd = path.resolve(overrides.agentCwd ?? controlCwd);
  const parsed = parseIssueRef(options.issue, options.repo);
  const outDir = path.resolve(controlCwd, options.outDir);
  const issueDir = path.join(outDir, "issue", parsed.issueNumber);
  const runDir = options.attempt !== undefined
    ? path.join(issueDir, "attempts", String(options.attempt))
    : issueDir;
  const runDirRelative = path.relative(controlCwd, runDir) || ".";

  return {
    controlCwd,
    agentCwd,
    outDir,
    runDir,
    runDirRelative,
    issueInput: options.issue,
    issueNumber: parsed.issueNumber,
    attempt: options.attempt,
    repo: parsed.repo,
    model: options.model,
    thinkingLevel: options.thinkingLevel,
    thinkingProfile: options.thinkingProfile,
    thinkingConfig: getWorkflowThinkingConfig({ profile: options.thinkingProfile, explicitThinkingLevel: options.thinkingLevel }),
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

export function artifactAgentPath(context: WorkflowContext, artifact: ArtifactRef): string {
  return path.relative(context.agentCwd, artifactPath(context, artifact)) || ".";
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

