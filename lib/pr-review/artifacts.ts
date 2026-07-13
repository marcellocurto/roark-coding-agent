import { existsSync } from "node:fs";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ReviewPrCliOptions } from "../cli/args.ts";
import { runProcessOrThrow } from "../cli/process.ts";
import { getWorkflowThinkingConfig, type WorkflowThinkingConfig } from "../workflow/thinking.ts";

export interface PrReviewContext {
  controlCwd: string;
  agentCwd: string;
  outDir: string;
  repo: string;
  prNumber: number;
  generation: number;
  reviewDir: string;
  reviewDirRelative: string;
  agentReviewDir: string;
  agentReviewDirRelative: string;
  model?: string | undefined;
  thinkingConfig: WorkflowThinkingConfig;
  comment: boolean;
}

export async function createPrReviewContext(options: ReviewPrCliOptions & { repo: string; agentCwd: string }): Promise<PrReviewContext> {
  const controlCwd = path.resolve(options.cwd);
  const outDir = path.resolve(controlCwd, options.outDir);
  const prDir = path.join(outDir, "pr", String(options.prNumber));
  const generation = await nextReviewGeneration(prDir);
  const reviewDir = path.join(prDir, `review-${generation}`);
  const agentCwd = path.resolve(options.agentCwd);
  const gitDir = (await runProcessOrThrow(["git", "rev-parse", "--absolute-git-dir"], {
    cwd: agentCwd,
    label: "git rev-parse --absolute-git-dir",
  })).trim();
  const agentReviewDir = path.join(gitDir, "roark", "pr-review", String(options.prNumber), `review-${generation}`);
  return {
    controlCwd,
    agentCwd,
    outDir,
    repo: options.repo,
    prNumber: options.prNumber,
    generation,
    reviewDir,
    reviewDirRelative: path.relative(controlCwd, reviewDir) || ".",
    agentReviewDir,
    agentReviewDirRelative: path.relative(agentCwd, agentReviewDir) || ".",
    model: options.model,
    thinkingConfig: getWorkflowThinkingConfig({ profile: options.thinkingProfile, explicitThinkingLevel: options.thinkingLevel }),
    comment: options.comment,
  };
}

export async function nextReviewGeneration(prDir: string): Promise<number> {
  if (!existsSync(prDir)) return 1;
  const values = (await readdir(prDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => /^review-(\d+)$/.exec(entry.name)?.[1])
    .filter((value): value is string => value !== undefined)
    .map(Number);
  return values.length === 0 ? 1 : Math.max(...values) + 1;
}

export function prReviewArtifactPath(context: PrReviewContext, filename: string): string {
  return path.join(context.reviewDir, filename);
}

export async function writePrReviewArtifact(context: PrReviewContext, filename: string, content: string): Promise<void> {
  const normalized = content.endsWith("\n") ? content : `${content}\n`;
  await mkdir(context.reviewDir, { recursive: true });
  await writeFile(prReviewArtifactPath(context, filename), normalized, "utf8");
}

export async function writePrReviewJson(context: PrReviewContext, filename: string, value: unknown): Promise<void> {
  await writePrReviewArtifact(context, filename, JSON.stringify(value, null, 2));
}

export async function writePrReviewInputArtifact(context: PrReviewContext, filename: string, content: string): Promise<void> {
  const normalized = content.endsWith("\n") ? content : `${content}\n`;
  await writePrReviewArtifact(context, filename, normalized);
  await mkdir(context.agentReviewDir, { recursive: true });
  await writeFile(path.join(context.agentReviewDir, filename), normalized, "utf8");
}

export async function writePrReviewInputJson(context: PrReviewContext, filename: string, value: unknown): Promise<void> {
  await writePrReviewInputArtifact(context, filename, JSON.stringify(value, null, 2));
}

export async function removeAgentPrReviewArtifacts(context: PrReviewContext): Promise<void> {
  if (path.resolve(context.agentReviewDir) === path.resolve(context.reviewDir)) return;
  await rm(context.agentReviewDir, { recursive: true, force: true });
}
