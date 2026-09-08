import { Effect, Schema, SchemaIssue } from "effect";
export class ArtifactContractError extends Schema.TaggedError<ArtifactContractError>()(
  "ArtifactContractError",
  {
    artifact: Schema.String,
    message: Schema.String,
    cause: Schema.optionalKey(Schema.instanceOf(Schema.SchemaError)),
  },
) {}
// Domain transformations fail with schema issues; unexpected exceptions remain defects.
export const invalidArtifact = (message: string) =>
  Effect.fail(new SchemaIssue.InvalidValue({ message }));
export function artifactContract<S extends Schema.ConstraintDecoder<unknown>>(
  artifact: string,
  schema: S,
) {
  const decodeValue = Schema.decodeUnknownEffect(schema, {
    onExcessProperty: "error",
  });
  const decode = Effect.fnUntraced(function* (value: unknown) {
    return yield* decodeValue(value).pipe(
      Effect.mapError(
        (error) =>
          new ArtifactContractError({
            artifact,
            message: `${artifact} does not satisfy the structured contract: ${error.message}`,
            cause: error,
          }),
      ),
    );
  });
  return {
    decode,
    parse: Effect.fnUntraced(function* (content: string) {
      const value = yield* decodeJson(content).pipe(
        Effect.mapError(
          (error) =>
            new ArtifactContractError({
              artifact,
              message: `${artifact} artifact is not valid JSON: ${error.message}`,
              cause: error,
            }),
        ),
      );
      return yield* decode(value);
    }),
  };
}
const decodeJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Unknown),
);
