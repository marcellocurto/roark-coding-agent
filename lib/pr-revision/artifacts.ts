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

export type PrRevisionContext = {
  cwd: string;
  outDir: string;
  repo?: string;
  prNumber: number;
  revision: number;
  prDir: string;
  revisionDir: string;
  revisionDirRelative: string;
  model?: string;
  thinkingLevel?: RevisePrCliOptions["thinkingLevel"];
  thinkingProfile?: ThinkingProfileName;
  thinkingConfig: WorkflowThinkingConfig;
  force: boolean;
  yes: boolean;
  maxFixPasses: number;
  verifyCommand: string;
  remote: string;
  comment: boolean;
};

const artifactFilenames: Record<PrRevisionArtifactName, string> = {
  metadata: "metadata.json",
  prFeedbackJson: "pr-feedback.json",
  prFeedbackMarkdown: "pr-feedback.md",
  revisionPlan: "revision-plan.md",
  revisionLog: "revision-log.md",
  revisionReview: "revision-review.md",
  verification: "verification.md",
};

export async function createPrRevisionContext(options: RevisePrCliOptions): Promise<PrRevisionContext> {
  const cwd = path.resolve(options.cwd);
  const outDir = path.resolve(cwd, options.outDir);
  const prDir = path.join(outDir, "pr", String(options.prNumber));
  const revision = await allocateNextRevision(prDir);
  const revisionDir = path.join(prDir, `revision-${revision}`);
  return {
    cwd,
    outDir,
    repo: options.repo,
    prNumber: options.prNumber,
    revision,
    prDir,
    revisionDir,
    revisionDirRelative: path.relative(cwd, revisionDir) || ".",
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
  if (!existsSync(prDir)) return 1;
  const entries = await readdir(prDir, { withFileTypes: true });
  const revisions = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name.match(/^revision-(\d+)$/)?.[1])
    .filter((value): value is string => value !== undefined)
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0);
  return revisions.length === 0 ? 1 : Math.max(...revisions) + 1;
}

export function prRevisionArtifactPath(context: PrRevisionContext, artifact: PrRevisionArtifactName | string): string {
  const filename = artifact in artifactFilenames ? artifactFilenames[artifact as PrRevisionArtifactName] : artifact;
  return path.join(context.revisionDir, filename);
}

export function prRevisionArtifactRelativePath(context: PrRevisionContext, artifact: PrRevisionArtifactName | string): string {
  const filename = artifact in artifactFilenames ? artifactFilenames[artifact as PrRevisionArtifactName] : artifact;
  return path.join(context.revisionDirRelative, filename);
}

export async function writePrRevisionArtifact(context: PrRevisionContext, artifact: PrRevisionArtifactName | string, content: string): Promise<void> {
  await mkdir(context.revisionDir, { recursive: true });
  await writeFile(prRevisionArtifactPath(context, artifact), content.endsWith("\n") ? content : `${content}\n`, "utf8");
}

export async function readPrRevisionArtifact(context: PrRevisionContext, artifact: PrRevisionArtifactName | string): Promise<string> {
  return readFile(prRevisionArtifactPath(context, artifact), "utf8");
}

export async function writePrRevisionJsonArtifact(context: PrRevisionContext, artifact: PrRevisionArtifactName | string, value: unknown): Promise<void> {
  await writePrRevisionArtifact(context, artifact, JSON.stringify(value, null, 2));
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
  const match = body.match(/(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+(?:[^\n#]+\/[^\n#]+)?#(\d+)/i);
  return match?.[1] ? Number(match[1]) : undefined;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 500);
}
