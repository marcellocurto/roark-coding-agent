import { Effect, Schema } from "effect";
import { artifactContract } from "../structured-output/contract.ts";
import {
  artifactExists,
  readArtifact,
  writeJsonArtifact,
  type WorkflowContext,
} from "./artifacts.ts";

const executionStopSchema = Schema.Struct({
  artifact: Schema.NullOr(
    Schema.Union([
      Schema.Literal("implementationLog"),
      Schema.Struct({
        name: Schema.Literals(["fixLog", "refinementLog"]),
        pass: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      }),
    ]),
  ),
});
export type ExecutionStopArtifact = Exclude<
  (typeof executionStopSchema)["Type"]["artifact"],
  null
>;
const contract = artifactContract("Execution stop", executionStopSchema);

// The active stop outlives phase routing, including verification repairs after
// an approved review cycle. A full forced reassessment clears it only after
// replacement implementation succeeds, so interruptions cannot erase the stop.
export const readExecutionStop = Effect.fn("readExecutionStop")(function* (
  context: WorkflowContext,
) {
  if (!(yield* artifactExists(context, "executionStop"))) return undefined;
  return (
    (yield* contract.parse(yield* readArtifact(context, "executionStop")))
      .artifact ?? undefined
  );
});
export const recordExecutionStop = Effect.fn("recordExecutionStop")(function* (
  context: WorkflowContext,
  artifact: ExecutionStopArtifact | null,
) {
  yield* writeJsonArtifact(context, "executionStop", { artifact });
});
