import { Clock, DateTime, Effect, Layer } from "effect";

// Integration tests can fix artifact timestamps without freezing real sleeps
// or changing the monotonic clock used for elapsed-time measurements.
export function fixedWallClock(iso: string) {
  const millis = DateTime.toEpochMillis(DateTime.makeUnsafe(iso));
  const nanos = BigInt(millis) * 1_000_000n;
  return Layer.effect(
    Clock.Clock,
    Effect.map(Clock.Clock, (live) => ({
      currentTimeMillisUnsafe: () => millis,
      currentTimeMillis: Effect.succeed(millis),
      currentTimeNanosUnsafe: () => nanos,
      currentTimeNanos: Effect.succeed(nanos),
      monotonicTimeNanosUnsafe: () => live.monotonicTimeNanosUnsafe(),
      monotonicTimeNanos: live.monotonicTimeNanos,
      sleep: (duration) => live.sleep(duration),
    })),
  );
}
