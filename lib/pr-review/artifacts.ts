import { Effect, FileSystem } from "effect";

import path from "node:path";
import type { ReviewPrCliOptions } from "../cli/args.ts";
import { runProcessOrThrow } from "../cli/process.ts";
import {
  getWorkflowThinkingConfig,
  type WorkflowThinkingConfig,
} from "../workflow/thinking.ts";
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
export const createPrReviewContext = Effect.fn("createPrReviewContext")(
  function* (
    options: ReviewPrCliOptions & {
      repo: string;
      agentCwd: string;
    },
  ) {
    const controlCwd = path.resolve(options.cwd);
    const outDir = path.resolve(controlCwd, options.outDir);
    const prDir = path.join(outDir, "pr", String(options.prNumber));
    const generation = yield* nextReviewGeneration(prDir);
    const reviewDir = path.join(prDir, `review-${generation}`);
    const agentCwd = path.resolve(options.agentCwd);
    const gitDir = (yield* runProcessOrThrow(
      ["git", "rev-parse", "--absolute-git-dir"],
      {
        cwd: agentCwd,
        label: "git rev-parse --absolute-git-dir",
      },
    )).trim();
    const agentReviewDir = path.join(
      gitDir,
      "roark",
      "pr-review",
      String(options.prNumber),
      `review-${generation}`,
    );
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
      thinkingConfig: getWorkflowThinkingConfig({
        profile: options.thinkingProfile,
        explicitThinkingLevel: options.thinkingLevel,
      }),
      comment: options.comment,
    };
  },
);
export const nextReviewGeneration = Effect.fn("nextReviewGeneration")(
  function* (prDir: string) {
    const fs = yield* FileSystem.FileSystem;
    if (!(yield* fs.exists(prDir))) return 1;
    const values: number[] = [];
    for (const entry of yield* fs.readDirectory(prDir)) {
      const value = /^review-(\d+)$/.exec(entry)?.[1];
      if (value === undefined) continue;
      if ((yield* fs.stat(path.join(prDir, entry))).type === "Directory")
        values.push(Number(value));
    }
    return values.length === 0 ? 1 : Math.max(...values) + 1;
  },
);
export function prReviewArtifactPath(
  context: PrReviewContext,
  filename: string,
): string {
  return path.join(context.reviewDir, filename);
}
export const writePrReviewArtifact = Effect.fn("writePrReviewArtifact")(
  function* (context: PrReviewContext, filename: string, content: string) {
    const normalized = content.endsWith("\n") ? content : `${content}\n`;
    yield* (yield* FileSystem.FileSystem).makeDirectory(context.reviewDir, {
      recursive: true,
    });
    yield* (yield* FileSystem.FileSystem).writeFileString(
      prReviewArtifactPath(context, filename),
      normalized,
    );
  },
  Effect.uninterruptible,
);
export const writePrReviewJson = Effect.fn("writePrReviewJson")(function* (
  context: PrReviewContext,
  filename: string,
  value: unknown,
) {
  yield* writePrReviewArtifact(
    context,
    filename,
    JSON.stringify(value, null, 2),
  );
});
export const writePrReviewInputArtifact = Effect.fn(
  "writePrReviewInputArtifact",
)(function* (context: PrReviewContext, filename: string, content: string) {
  const normalized = content.endsWith("\n") ? content : `${content}\n`;
  yield* writePrReviewArtifact(context, filename, normalized);
  yield* (yield* FileSystem.FileSystem).makeDirectory(context.agentReviewDir, {
    recursive: true,
  });
  yield* (yield* FileSystem.FileSystem).writeFileString(
    path.join(context.agentReviewDir, filename),
    normalized,
  );
}, Effect.uninterruptible);
export const writePrReviewInputJson = Effect.fn("writePrReviewInputJson")(
  function* (context: PrReviewContext, filename: string, value: unknown) {
    yield* writePrReviewInputArtifact(
      context,
      filename,
      JSON.stringify(value, null, 2),
    );
  },
);
export const removeAgentPrReviewArtifacts = Effect.fn(
  "removeAgentPrReviewArtifacts",
)(function* (context: PrReviewContext) {
  if (path.resolve(context.agentReviewDir) === path.resolve(context.reviewDir))
    return;
  yield* (yield* FileSystem.FileSystem).remove(context.agentReviewDir, {
    recursive: true,
    force: true,
  });
});
