import {
  artifactExists,
  requireArtifacts,
  inferNextFixPass,
  latestCompleteReviewCycle,
  inferNextRefinementPass,
} from "./artifacts.ts";
import {
  fromLegacyPromise,
  runApplicationPromise,
  type ApplicationExecution,
} from "../runtime/application.ts";
import {
  ensureRunDir,
  readArtifact,
  writeArtifact,
  writeJsonArtifact,
  produceArtifact,
  type WorkflowContext,
  type ArtifactRef,
  type StaticArtifactName,
} from "./artifacts.ts";

export function ensureRunDirPromise(
  context: WorkflowContext,
  application?: ApplicationExecution,
) {
  return runApplicationPromise(ensureRunDir(context), application);
}
export function readArtifactPromise(
  context: WorkflowContext,
  artifact: ArtifactRef,
  application?: ApplicationExecution,
) {
  return runApplicationPromise(readArtifact(context, artifact), application);
}
export function writeArtifactPromise(
  context: WorkflowContext,
  artifact: ArtifactRef,
  content: string,
  application?: ApplicationExecution,
) {
  return runApplicationPromise(
    writeArtifact(context, artifact, content),
    application,
  );
}
export function writeJsonArtifactPromise(
  context: WorkflowContext,
  artifact: StaticArtifactName,
  value: unknown,
  application?: ApplicationExecution,
) {
  return runApplicationPromise(
    writeJsonArtifact(context, artifact, value),
    application,
  );
}
export function produceArtifactPromise(
  context: WorkflowContext,
  artifact: ArtifactRef,
  label: string,
  produce: () => Promise<string>,
  application?: ApplicationExecution,
) {
  return runApplicationPromise(
    produceArtifact(context, artifact, label, fromLegacyPromise(produce)),
    application,
  );
}

export function artifactExistsPromise(
  context: WorkflowContext,
  artifact: ArtifactRef,
  application?: ApplicationExecution,
) {
  return runApplicationPromise(artifactExists(context, artifact), application);
}
export function requireArtifactsPromise(
  context: WorkflowContext,
  artifacts: ArtifactRef[],
  application?: ApplicationExecution,
) {
  return runApplicationPromise(
    requireArtifacts(context, ...artifacts),
    application,
  );
}
export function inferNextFixPassPromise(
  context: WorkflowContext,
  application?: ApplicationExecution,
) {
  return runApplicationPromise(inferNextFixPass(context), application);
}
export function latestCompleteReviewCyclePromise(
  context: WorkflowContext,
  application?: ApplicationExecution,
) {
  return runApplicationPromise(latestCompleteReviewCycle(context), application);
}
export function inferNextRefinementPassPromise(
  context: WorkflowContext,
  application?: ApplicationExecution,
) {
  return runApplicationPromise(inferNextRefinementPass(context), application);
}
