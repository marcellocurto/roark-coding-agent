import { Effect, FileSystem, Schema } from "effect";
import path from "node:path";
import { artifactContract } from "../structured-output/contract.ts";
import {
  artifactFromFilename,
  type ArtifactRef,
} from "../workflow/artifact-catalog.ts";
import type { WorkflowContext } from "../workflow/artifacts.ts";
import { continuationPhaseSchema, type ContinuationPhase } from "./result.ts";

const filenameSchema = Schema.String.check(
  Schema.makeFilter((value) =>
    artifactFromFilename(value) === undefined
      ? "Unknown workflow artifact filename."
      : undefined,
  ),
);
const stateSchema = Schema.Struct({
  version: Schema.Literal(1),
  id: Schema.Int.check(Schema.isGreaterThan(0)),
  status: Schema.Literals(["checking", "applying", "ready", "blocked"]),
  mode: Schema.Literals(["continue", "restart"]),
  resumeFrom: continuationPhaseSchema,
  pass: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  invalidated: Schema.mutable(Schema.Array(filenameSchema)),
  replacements: Schema.Record(filenameSchema, Schema.String),
  restartBaseline: Schema.NullOr(Schema.String),
});
export type ContinuationState = typeof stateSchema.Type;
const contract = artifactContract("Continuation checkpoint", stateSchema);
export const readContinuationState = Effect.fn("readContinuationState")(
  function* (context: WorkflowContext) {
    const fs = yield* FileSystem.FileSystem;
    const filename = path.join(context.runDir, "continuation-state.json");
    if (!(yield* fs.exists(filename))) return undefined;
    return yield* contract.parse(yield* fs.readFileString(filename));
  },
);
export const writeContinuationState = Effect.fn("writeContinuationState")(
  function* (context: WorkflowContext, state: ContinuationState) {
    const fs = yield* FileSystem.FileSystem;
    const filename = path.join(context.runDir, "continuation-state.json");
    yield* fs.writeFileString(
      `${filename}.tmp`,
      JSON.stringify(state, null, 2),
    );
    yield* fs.rename(`${filename}.tmp`, filename);
  },
  Effect.uninterruptible,
);
export function continuationHistoryDir(
  context: WorkflowContext,
  id: number,
): string {
  return path.join(context.runDir, "continuations", String(id));
}
export const recordWorkflowPosition = Effect.fn("recordWorkflowPosition")(
  function* (context: WorkflowContext, pass: number) {
    const previous = yield* readContinuationState(context);
    yield* writeContinuationState(context, {
      version: 1,
      id: previous?.id ?? 1,
      mode: "continue",
      status: "ready",
      resumeFrom: "fix",
      pass,
      invalidated: [],
      replacements: {},
      restartBaseline: null,
    });
  },
);
export const archiveContinuation = Effect.fn("archiveContinuation")(function* (
  context: WorkflowContext,
  id: number,
) {
  const fs = yield* FileSystem.FileSystem;
  const directory = continuationHistoryDir(context, id);
  yield* fs.makeDirectory(directory, { recursive: true });
  const files = (yield* fs.readDirectory(context.runDir)).filter(
    (filename) => artifactFromFilename(filename) !== undefined,
  );
  for (const filename of files)
    yield* fs.copyFile(
      path.join(context.runDir, filename),
      path.join(directory, filename),
    );
  return files;
});

export function invalidatedArtifacts(
  files: readonly string[],
  phase: ContinuationPhase,
  pass: number | null,
): string[] {
  if (phase === "unchanged") return [];
  const from = phaseOrder(phase, pass ?? 0);
  return files.filter((filename) => {
    const artifact = artifactFromFilename(filename);
    if (
      artifact === undefined ||
      artifact === "preImplementationBaseline" ||
      filename.startsWith("continuation-")
    )
      return false;
    if (artifact === "issue" || artifact === "metadata") return false;
    if (
      typeof artifact === "object" &&
      (artifact.name === "verificationBeforeFix" ||
        artifact.name === "verificationBeforeFixFull") &&
      artifact.pass <= (pass ?? 0)
    )
      return false;
    return artifactOrder(artifact) >= from;
  });
}
function phaseOrder(phase: ContinuationPhase, pass: number): number {
  switch (phase) {
    case "triage":
      return 0;
    case "plan-draft":
      return 1;
    case "plan":
      return 2;
    case "implement":
      return 3;
    case "fix":
      return 3 + pass * 3;
    case "refine-code":
      return 4 + pass * 3;
    case "review":
      return 5 + pass * 3;
    case "unchanged":
      return Infinity;
  }
}
function artifactOrder(artifact: ArtifactRef): number {
  if (typeof artifact === "string") {
    if (artifact === "triage" || artifact === "triageMarkdown") return 0;
    if (
      artifact === "implementationPlanDraft" ||
      artifact === "implementationPlanDraftMarkdown"
    )
      return 1;
    if (
      artifact === "implementationPlan" ||
      artifact === "implementationPlanMarkdown"
    )
      return 2;
    if (
      artifact === "implementationLog" ||
      artifact === "implementationLogMarkdown"
    )
      return 3;
    return Infinity;
  }
  if (
    artifact.name === "refinementLog" ||
    artifact.name === "refinementLogMarkdown"
  )
    return 4 + artifact.pass * 3;
  if (
    ["reviewA", "reviewB", "reviewAMarkdown", "reviewBMarkdown"].includes(
      artifact.name,
    )
  )
    return 5 + artifact.pass * 3;
  return 3 + artifact.pass * 3;
}

// The intent is durable before old results are removed. A retry finishes this
// operation before any agent runs, so interrupted invalidation cannot reuse old approvals.
export const applyContinuation = Effect.fn("applyContinuation")(function* (
  context: WorkflowContext,
  state: ContinuationState,
) {
  const fs = yield* FileSystem.FileSystem;
  for (const filename of state.invalidated)
    yield* fs.remove(path.join(context.runDir, filename), { force: true });
  for (const [filename, content] of Object.entries(state.replacements)) {
    const target = path.join(context.runDir, filename);
    yield* fs.writeFileString(`${target}.tmp`, content);
    yield* fs.rename(`${target}.tmp`, target);
  }
  yield* writeContinuationState(context, { ...state, status: "ready" });
});
