import { Effect, FileSystem, Option, Schema } from "effect";
import path from "node:path";
import { type RevisePrCliOptions } from "../cli/args.ts";
import {
  getWorkflowThinkingConfig,
  type ThinkingProfileName,
  type WorkflowThinkingConfig,
} from "../workflow/thinking.ts";
import { type PullRequestFeedback } from "../github/pr.ts";
export type PrRevisionArtifactName =
  | "metadata"
  | "prFeedbackJson"
  | "prFeedbackMarkdown"
  | "revisionPlan"
  | "revisionLog"
  | "revisionLogMarkdown"
  | "revisionReview"
  | "verification";
export interface PrRevisionContext {
  controlCwd: string;
  agentCwd: string;
  outDir: string;
  repo?: string | undefined;
  prNumber: number;
  revision: number;
  prDir: string;
  revisionDir: string;
  revisionDirRelative: string;
  agentRevisionDir: string;
  agentRevisionDirRelative: string;
  model?: string | undefined;
  thinkingLevel?: RevisePrCliOptions["thinkingLevel"] | undefined;
  thinkingProfile?: ThinkingProfileName | undefined;
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
  revisionLog: "revision-log.json",
  revisionLogMarkdown: "revision-log.md",
  revisionReview: "revision-review.json",
  verification: "verification.md",
};
export const createPrRevisionContext = Effect.fn("createPrRevisionContext")(
  function* (
    options: RevisePrCliOptions & {
      controlCwd?: string | undefined;
      agentCwd?: string | undefined;
    },
  ) {
    const controlCwd = path.resolve(options.controlCwd ?? options.cwd);
    const agentCwd = path.resolve(options.agentCwd ?? options.cwd);
    const outDir = path.resolve(controlCwd, options.outDir);
    const prDir = path.join(outDir, "pr", String(options.prNumber));
    const agentOutDir = path.resolve(agentCwd, options.outDir);
    const agentPrDir = path.join(agentOutDir, "pr", String(options.prNumber));
    const revision = yield* allocateNextRevisionAcross([prDir, agentPrDir]);
    const revisionDir = path.join(prDir, `revision-${revision}`);
    const agentRevisionDir = path.join(agentPrDir, `revision-${revision}`);
    return {
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
      agentRevisionDirRelative:
        path.relative(agentCwd, agentRevisionDir) || ".",
      model: options.model,
      thinkingLevel: options.thinkingLevel,
      thinkingProfile: options.thinkingProfile,
      thinkingConfig: getWorkflowThinkingConfig({
        profile: options.thinkingProfile,
        explicitThinkingLevel: options.thinkingLevel,
      }),
      force: options.force,
      yes: options.yes,
      maxFixPasses: options.maxFixPasses,
      verifyCommand: options.verifyCommand,
      remote: options.remote,
      comment: options.comment,
    };
  },
);
export const allocateNextRevision = Effect.fn("allocateNextRevision")(
  function* (prDir: string) {
    return yield* allocateNextRevisionAcross([prDir]);
  },
);
const positiveRevision = Schema.Int.check(Schema.isGreaterThan(0));
export const allocateNextRevisionAcross = Effect.fn(
  "allocateNextRevisionAcross",
)(function* (prDirs: string[]) {
  const fs = yield* FileSystem.FileSystem;
  let latest = 0;
  for (const prDir of prDirs) {
    if (!(yield* fs.exists(prDir))) continue;
    for (const entry of yield* fs.readDirectory(prDir)) {
      const match = /^revision-(\d+)$/.exec(entry);
      if (!match) continue;
      const value = Number(match[1]);
      if (!Schema.is(positiveRevision)(value)) continue;
      const fullPath = path.join(prDir, entry);
      if (Option.isSome(yield* fs.readLink(fullPath).pipe(Effect.option)))
        continue;
      if ((yield* fs.stat(fullPath)).type === "Directory")
        latest = Math.max(latest, value);
    }
  }
  if (latest === Number.MAX_SAFE_INTEGER)
    return yield* new RevisionArtifactError({
      message:
        "Revision directory numbering has reached the largest safe integer.",
    });
  return latest + 1;
});
export class RevisionArtifactError extends Schema.TaggedError<RevisionArtifactError>()(
  "RevisionArtifactError",
  { message: Schema.String },
) {}
export function prRevisionArtifactPath(
  context: PrRevisionContext,
  artifact: string,
): string {
  const filename = artifactFilename(artifact);
  return path.join(context.revisionDir, filename);
}
export function agentPrRevisionArtifactPath(
  context: PrRevisionContext,
  artifact: string,
): string {
  const filename = artifactFilename(artifact);
  return path.join(context.agentRevisionDir, filename);
}
export function prRevisionArtifactRelativePath(
  context: PrRevisionContext,
  artifact: string,
): string {
  const filename = artifactFilename(artifact);
  return path.join(context.revisionDirRelative, filename);
}
export function agentPrRevisionArtifactRelativePath(
  context: PrRevisionContext,
  artifact: string,
): string {
  const filename = artifactFilename(artifact);
  return path.join(context.agentRevisionDirRelative, filename);
}
export const writePrRevisionArtifact = Effect.fn("writePrRevisionArtifact")(
  function* (context: PrRevisionContext, artifact: string, content: string) {
    const normalized = content.endsWith("\n") ? content : `${content}\n`;
    yield* (yield* FileSystem.FileSystem).makeDirectory(context.revisionDir, {
      recursive: true,
    });
    yield* (yield* FileSystem.FileSystem).writeFileString(
      prRevisionArtifactPath(context, artifact),
      normalized,
    );
    if (
      path.resolve(context.agentRevisionDir) !==
      path.resolve(context.revisionDir)
    ) {
      yield* (yield* FileSystem.FileSystem).makeDirectory(
        context.agentRevisionDir,
        { recursive: true },
      );
      yield* (yield* FileSystem.FileSystem).writeFileString(
        agentPrRevisionArtifactPath(context, artifact),
        normalized,
      );
    }
  },
  Effect.uninterruptible,
);
export const readPrRevisionArtifact = Effect.fn("readPrRevisionArtifact")(
  function* (context: PrRevisionContext, artifact: string) {
    return yield* (yield* FileSystem.FileSystem).readFileString(
      prRevisionArtifactPath(context, artifact),
    );
  },
);
export const removeAgentPrRevisionArtifacts = Effect.fn(
  "removeAgentPrRevisionArtifacts",
)(function* (context: PrRevisionContext) {
  if (
    path.resolve(context.agentRevisionDir) === path.resolve(context.revisionDir)
  )
    return;
  yield* (yield* FileSystem.FileSystem).remove(context.agentRevisionDir, {
    recursive: true,
    force: true,
  });
});
export const writePrRevisionJsonArtifact = Effect.fn(
  "writePrRevisionJsonArtifact",
)(function* (context: PrRevisionContext, artifact: string, value: unknown) {
  yield* writePrRevisionArtifact(
    context,
    artifact,
    JSON.stringify(value, null, 2),
  );
}, Effect.uninterruptible);
function artifactFilename(artifact: string): string {
  return artifact in artifactFilenames
    ? artifactFilenames[artifact as PrRevisionArtifactName]
    : artifact;
}
export function formatPrFeedbackMarkdown(
  feedback: PullRequestFeedback,
): string {
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
  if (feedback.reviewThreadsTruncated === true)
    lines.push(
      `- Feedback completeness: incomplete; additional review threads exist on GitHub`,
    );
  lines.push("");
  lines.push(`## Review Threads`);
  if (feedback.reviewThreads.length === 0) lines.push("None.");
  for (const thread of feedback.reviewThreads) {
    lines.push(
      `- Thread ${thread.id}: ${thread.isResolved ? "resolved" : "unresolved"}${thread.path ? ` (${thread.path})` : ""}`,
    );
    for (const comment of thread.comments) {
      lines.push(
        `  - ${comment.author ?? "unknown"}: ${oneLine(comment.body)}`,
      );
    }
  }
  lines.push("");
  lines.push(`## PR Comments`);
  if (feedback.plannerComments.length === 0) lines.push("None.");
  for (const comment of feedback.plannerComments) {
    lines.push(
      `- ${comment.author ?? "unknown"}${comment.createdAt ? ` at ${comment.createdAt}` : ""}: ${oneLine(comment.body)}`,
    );
  }
  lines.push("");
  lines.push(`## Excluded Roark Revision Summary Comments`);
  if (feedback.excludedRoarkSummaryCommentIds.length === 0) lines.push("None.");
  else
    for (const id of feedback.excludedRoarkSummaryCommentIds)
      lines.push(`- ${id}`);
  return `${lines.join("\n")}\n`;
}
export function inferIssueFromPrBody(body: string): number | undefined {
  const match =
    /(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+(?:[^\n#]+\/[^\n#]+)?#(\d+)/i.exec(
      body,
    );
  return match?.[1] ? Number(match[1]) : undefined;
}
function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 500);
}
