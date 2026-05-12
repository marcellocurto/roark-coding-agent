import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RevisePrCliOptions } from "../cli/args.ts";
import { getWorkflowThinkingConfig, type ThinkingProfileName, type WorkflowThinkingConfig } from "../workflow/thinking.ts";
import type { PullRequestFeedback } from "../github/pr.ts";

export type PrRevisionArtifactName =
  | "metadata"
  | "prFeedbackJson"
  | "prFeedbackMarkdown"
  | "revisionPlan"
  | "revisionLog"
  | "revisionReview"
  | "verification";

export interface PrRevisionContext {
  /** @deprecated Use agentCwd for mutation/agent work and controlCwd for control-plane work. */
  cwd: string;
  controlCwd: string;
  agentCwd: string;
  outDir: string;
  repo?: string | undefined  ;
  prNumber: number;
  revision: number;
  prDir: string;
  revisionDir: string;
  revisionDirRelative: string;
  agentRevisionDir: string;
  agentRevisionDirRelative: string;
  model?: string | undefined  ;
  thinkingLevel?: RevisePrCliOptions["thinkingLevel"] | undefined  ;
  thinkingProfile?: ThinkingProfileName | undefined  ;
  thinkingConfig: WorkflowThinkingConfig;
  force: boolean;
  yes: boolean;
  maxFixPasses: number;
  verifyCommand: string;
  remote: string;
  comment: boolean;
}

const artifactFilenames: Record<PrRevisionArtifactName, string> = {
  metadata: "metadata.json",
  prFeedbackJson: "pr-feedback.json",
  prFeedbackMarkdown: "pr-feedback.md",
  revisionPlan: "revision-plan.md",
  revisionLog: "revision-log.md",
  revisionReview: "revision-review.md",
  verification: "verification.md",
};

export async function createPrRevisionContext(options: RevisePrCliOptions & { controlCwd?: string | undefined; agentCwd?: string | undefined }): Promise<PrRevisionContext> {
  const controlCwd = path.resolve(options.controlCwd ?? options.cwd);
  const agentCwd = path.resolve(options.agentCwd ?? options.cwd);
  const outDir = path.resolve(controlCwd, options.outDir);
  const prDir = path.join(outDir, "pr", String(options.prNumber));
  const agentOutDir = path.resolve(agentCwd, options.outDir);
  const agentPrDir = path.join(agentOutDir, "pr", String(options.prNumber));
  const revision = await allocateNextRevisionAcross([prDir, agentPrDir]);
  const revisionDir = path.join(prDir, `revision-${revision}`);
  const agentRevisionDir = path.join(agentPrDir, `revision-${revision}`);
  return {
    cwd: agentCwd,
    controlCwd,
    agentCwd,
    outDir,
    repo: options.repo,
    prNumber: options.prNumber,
    revision,
    prDir,
    revisionDir,
    revisionDirRelative: path.relative(controlCwd, revisionDir) || ".",
    agentRevisionDir,
    agentRevisionDirRelative: path.relative(agentCwd, agentRevisionDir) || ".",
    model: options.model,
    thinkingLevel: options.thinkingLevel,
    thinkingProfile: options.thinkingProfile,
    thinkingConfig: getWorkflowThinkingConfig({ profile: options.thinkingProfile, explicitThinkingLevel: options.thinkingLevel }),
    force: options.force,
    yes: options.yes,
    maxFixPasses: options.maxFixPasses,
    verifyCommand: options.verifyCommand,
    remote: options.remote,
    comment: options.comment,
  };
}

export async function allocateNextRevision(prDir: string): Promise<number> {
  return allocateNextRevisionAcross([prDir]);
}

export async function allocateNextRevisionAcross(prDirs: string[]): Promise<number> {
  const revisions: number[] = [];
  for (const prDir of prDirs) {
    if (!existsSync(prDir)) continue;
    const entries = await readdir(prDir, { withFileTypes: true });
    revisions.push(...entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => (/^revision-(\d+)$/.exec(entry.name))?.[1])
      .filter((value): value is string => value !== undefined)
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value > 0));
  }
  return revisions.length === 0 ? 1 : Math.max(...revisions) + 1;
}

export function prRevisionArtifactPath(context: PrRevisionContext, artifact: string): string {
  const filename = artifactFilename(artifact);
  return path.join(context.revisionDir, filename);
}

export function agentPrRevisionArtifactPath(context: PrRevisionContext, artifact: string): string {
  const filename = artifactFilename(artifact);
  return path.join(context.agentRevisionDir, filename);
}

export function prRevisionArtifactRelativePath(context: PrRevisionContext, artifact: string): string {
  const filename = artifactFilename(artifact);
  return path.join(context.revisionDirRelative, filename);
}

export function agentPrRevisionArtifactRelativePath(context: PrRevisionContext, artifact: string): string {
  const filename = artifactFilename(artifact);
  return path.join(context.agentRevisionDirRelative, filename);
}

export async function writePrRevisionArtifact(context: PrRevisionContext, artifact: string, content: string): Promise<void> {
  const normalized = content.endsWith("\n") ? content : `${content}\n`;
  await mkdir(context.revisionDir, { recursive: true });
  await writeFile(prRevisionArtifactPath(context, artifact), normalized, "utf8");
  if (path.resolve(context.agentRevisionDir) !== path.resolve(context.revisionDir)) {
    await mkdir(context.agentRevisionDir, { recursive: true });
    await writeFile(agentPrRevisionArtifactPath(context, artifact), normalized, "utf8");
  }
}

export async function readPrRevisionArtifact(context: PrRevisionContext, artifact: string): Promise<string> {
  return readFile(prRevisionArtifactPath(context, artifact), "utf8");
}

export async function writePrRevisionJsonArtifact(context: PrRevisionContext, artifact: string, value: unknown): Promise<void> {
  await writePrRevisionArtifact(context, artifact, JSON.stringify(value, null, 2));
}

function artifactFilename(artifact: string): string {
  return artifact in artifactFilenames ? artifactFilenames[artifact as PrRevisionArtifactName] : artifact;
}

export function formatPrFeedbackMarkdown(feedback: PullRequestFeedback): string {
  const lines: string[] = [];
  lines.push(`# PR Feedback`);
  lines.push("");
  lines.push(`## Pull Request`);
  lines.push(`- Repo: ${feedback.repo}`);
  lines.push(`- PR: #${feedback.pr.number} ${feedback.pr.title}`);
  lines.push(`- State: ${feedback.pr.state}`);
  lines.push(`- Base: ${feedback.pr.baseRefName}`);
  lines.push(`- Head: ${feedback.pr.headRefName}`);
  if (feedback.pr.url) lines.push(`- URL: ${feedback.pr.url}`);
  lines.push("");
  lines.push(`## Review Threads`);
  if (feedback.reviewThreads.length === 0) lines.push("None.");
  for (const thread of feedback.reviewThreads) {
    lines.push(`- Thread ${thread.id}: ${thread.isResolved ? "resolved" : "unresolved"}${thread.path ? ` (${thread.path})` : ""}`);
    for (const comment of thread.comments) {
      lines.push(`  - ${comment.author ?? "unknown"}: ${oneLine(comment.body)}`);
    }
  }
  lines.push("");
  lines.push(`## PR Comments`);
  if (feedback.plannerComments.length === 0) lines.push("None.");
  for (const comment of feedback.plannerComments) {
    lines.push(`- ${comment.author ?? "unknown"}${comment.createdAt ? ` at ${comment.createdAt}` : ""}: ${oneLine(comment.body)}`);
  }
  lines.push("");
  lines.push(`## Excluded Roark Revision Summary Comments`);
  if (feedback.excludedRoarkSummaryCommentIds.length === 0) lines.push("None.");
  else for (const id of feedback.excludedRoarkSummaryCommentIds) lines.push(`- ${id}`);
  return `${lines.join("\n")}\n`;
}

export function inferIssueFromPrBody(body: string): number | undefined {
  const match = /(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+(?:[^\n#]+\/[^\n#]+)?#(\d+)/i.exec(body);
  return match?.[1] ? Number(match[1]) : undefined;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 500);
}
