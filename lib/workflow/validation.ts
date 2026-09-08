import { Effect, Schema } from "effect";

export const decodeJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Unknown),
);

// The existing artifact codecs throw at their synchronous validation boundary.
export const decodeArtifact = Effect.fnUntraced(function* <
  A,
  Args extends readonly unknown[],
>(decode: (...args: Args) => A, ...args: Args) {
  return yield* Effect.try(() => decode(...args));
});
