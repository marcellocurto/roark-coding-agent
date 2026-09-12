import { Effect } from "effect";
import { ArtifactStore } from "./artifact-store.ts";
import { Presentation } from "../runtime/services.ts";
import path from "node:path";
import type { IssueCliOptions, ThinkingLevel } from "../cli/args.ts";
import {
  getWorkflowThinkingConfig,
  type ThinkingProfileName,
  type WorkflowThinkingConfig,
} from "./thinking.ts";
import { parseIssueRef } from "../github/issue.ts";
import {
  artifactFilename,
  fixLogRef,
  formatArtifactRef,
  refinementLogRef,
  reviewARef,
  reviewBRef,
} from "./artifact-catalog.ts";
import type { ArtifactRef, StaticArtifactName } from "./artifact-catalog.ts";
import { parseReviewResultJson } from "../review/result.ts";
export type {
  ArtifactRef,
  NumberedArtifactName,
  StaticArtifactName,
} from "./artifact-catalog.ts";
export {
  artifactFilename,
  baselineResetLogRef,
  fixLogRef,
  fixLogMarkdownRef,
  formatArtifactRef,
  implementationRestartLogRef,
  refinementLogRef,
  refinementLogMarkdownRef,
  reviewARef,
  reviewAMarkdownRef,
  reviewBRef,
  reviewBMarkdownRef,
  verificationBeforeFixRef,
  verificationBeforeFixFullRef,
} from "./artifact-catalog.ts";
export interface WorkflowContext {
  controlCwd: string;
  agentCwd: string;
  outDir: string;
  runDir: string;
  runDirRelative: string;
  issueInput: string;
  issueNumber: string;
  displayCommand?: string | undefined;
  attempt?: number | undefined;
  repo?: string | undefined;
  model?: string | undefined;
  thinkingLevel?: ThinkingLevel | undefined;
  thinkingProfile?: ThinkingProfileName | undefined;
  thinkingConfig: WorkflowThinkingConfig;
  force: boolean;
  continuing?: boolean;
  yes: boolean;
  maxFixPasses: number;
  fixPass?: number | undefined;
}
export function createWorkflowContext(
  options: IssueCliOptions,
  overrides: {
    agentCwd?: string | undefined;
    displayCommand?: string | undefined;
  } = {},
): WorkflowContext {
  const controlCwd = path.resolve(options.cwd);
  const agentCwd = path.resolve(overrides.agentCwd ?? controlCwd);
  const parsed = parseIssueRef(options.issue, options.repo);
  const outDir = path.resolve(controlCwd, options.outDir);
  const issueDir = path.join(outDir, "issue", parsed.issueNumber);
  const runDir =
    options.attempt !== undefined
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
    displayCommand: overrides.displayCommand ?? options.command,
    attempt: options.attempt,
    repo: parsed.repo,
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
    fixPass: options.fixPass,
  };
}
export function artifactPath(
  context: WorkflowContext,
  artifact: ArtifactRef,
): string {
  return path.join(context.runDir, artifactFilename(artifact));
}
export function artifactRelativePath(
  context: WorkflowContext,
  artifact: ArtifactRef,
): string {
  return path.join(context.runDirRelative, artifactFilename(artifact));
}
export function artifactAgentPath(
  context: WorkflowContext,
  artifact: ArtifactRef,
): string {
  return (
    path.relative(context.agentCwd, artifactPath(context, artifact)) || "."
  );
}
export const ensureRunDir = Effect.fn("ensureRunDir")(function* (
  context: WorkflowContext,
) {
  const store = yield* ArtifactStore;
  yield* store.ensure(context);
});
export const artifactExists = Effect.fn("artifactExists")(function* (
  context: WorkflowContext,
  artifact: ArtifactRef,
) {
  const store = yield* ArtifactStore;
  return yield* store.exists(context, artifact);
});
export const readArtifact = Effect.fn("readArtifact")(function* (
  context: WorkflowContext,
  artifact: ArtifactRef,
) {
  const store = yield* ArtifactStore;
  return yield* store.read(context, artifact);
});
export const writeArtifact = Effect.fn("writeArtifact")(function* (
  context: WorkflowContext,
  artifact: ArtifactRef,
  content: string,
) {
  const store = yield* ArtifactStore;
  yield* store.write(context, artifact, content);
});
export const writeJsonArtifact = Effect.fn("writeJsonArtifact")(function* (
  context: WorkflowContext,
  artifact: StaticArtifactName,
  value: unknown,
) {
  yield* writeArtifact(context, artifact, JSON.stringify(value, null, 2));
});
export const produceArtifact = Effect.fn("produceArtifact")(function* <E, R>(
  context: WorkflowContext,
  artifact: ArtifactRef,
  label: string,
  produce: Effect.Effect<string, E, R>,
) {
  const store = yield* ArtifactStore;
  const presentation = yield* Presentation;
  if (!context.force && (yield* store.exists(context, artifact))) {
    presentation.line(
      `${label}: using existing ${artifactRelativePath(context, artifact)}`,
    );
    return yield* store.read(context, artifact);
  }
  presentation.line(label);
  const content = yield* produce;
  yield* store.write(context, artifact, content);
  presentation.line(
    `${label}: wrote ${artifactRelativePath(context, artifact)}`,
  );
  return content;
});
export const requireArtifacts = Effect.fn("requireArtifacts")(function* (
  context: WorkflowContext,
  ...artifacts: ArtifactRef[]
) {
  const missing: ArtifactRef[] = [];
  for (const artifact of artifacts)
    if (!(yield* artifactExists(context, artifact))) missing.push(artifact);
  if (missing.length > 0)
    return yield* Effect.fail(
      new Error(
        `Missing prerequisite artifact(s): ${missing.map(formatArtifactRef).join(", ")}. Run earlier phases or use 'do'.`,
      ),
    );
});
export const inferNextFixPass = Effect.fn("inferNextFixPass")(function* (
  context: WorkflowContext,
) {
  for (let pass = 1; ; pass++) {
    if (!(yield* artifactExists(context, fixLogRef(pass)))) return pass;
    if (!(yield* artifactExists(context, refinementLogRef(pass))))
      return yield* Effect.fail(
        new Error(
          `Fix pass ${pass} already exists. Run refine-code before starting another fix pass.`,
        ),
      );
    if (
      !(yield* artifactExists(context, reviewARef(pass))) ||
      !(yield* artifactExists(context, reviewBRef(pass)))
    )
      return yield* Effect.fail(
        new Error(
          `Fix pass ${pass} already exists. Run review before starting another fix pass.`,
        ),
      );
  }
});
const validReviewArtifactExists = Effect.fn("validReviewArtifactExists")(
  function* (context: WorkflowContext, artifact: ArtifactRef) {
    const content = yield* readArtifact(context, artifact);
    yield* parseReviewResultJson(content, { allowRestart: true });
    return true;
  },
  Effect.catch(() => Effect.succeed(false)),
);
export const latestCompleteReviewCycle = Effect.fn("latestCompleteReviewCycle")(
  function* (context: WorkflowContext) {
    let latest: number | undefined;
    for (
      let pass = 0;
      (yield* validReviewArtifactExists(context, reviewARef(pass))) &&
      (yield* validReviewArtifactExists(context, reviewBRef(pass)));
      pass++
    )
      latest = pass;
    return latest;
  },
);
export const inferNextRefinementPass = Effect.fn("inferNextRefinementPass")(
  function* (context: WorkflowContext) {
    for (let pass = 0; ; pass++) {
      if (!(yield* artifactExists(context, refinementLogRef(pass))))
        return pass;
      if (
        !(yield* artifactExists(context, reviewARef(pass))) ||
        !(yield* artifactExists(context, reviewBRef(pass)))
      )
        return pass;
    }
  },
);
