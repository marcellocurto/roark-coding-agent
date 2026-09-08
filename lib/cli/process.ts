import { constants } from "node:os";
import { Effect, Ref, Schema, Stream, PlatformError } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

const processResultSchema = Schema.Struct({
  stdout: Schema.String,
  stderr: Schema.String,
  exitCode: Schema.Number,
});
export type ProcessResult = typeof processResultSchema.Type;

export interface ProcessOptions {
  cwd?: string | undefined;
  input?: string | undefined;
}

export class InvalidProcessCommandError extends Schema.TaggedError<InvalidProcessCommandError>()(
  "InvalidProcessCommandError",
  {
    args: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    return "A command is required.";
  }
}

export class ProcessExecutionError extends Schema.TaggedError<ProcessExecutionError>()(
  "ProcessExecutionError",
  {
    args: Schema.Array(Schema.String),
    cause: Schema.instanceOf(PlatformError.PlatformError),
  },
) {
  override get message(): string {
    return `Could not execute ${this.args.join(" ")}: ${this.cause.message}`;
  }
}

export class ProcessExitError extends Schema.TaggedError<ProcessExitError>()(
  "ProcessExitError",
  {
    label: Schema.String,
    result: processResultSchema,
  },
) {
  override get message(): string {
    return `${this.label} failed with exit code ${this.result.exitCode}:\n${this.result.stderr || this.result.stdout}`;
  }
}

export const executeProcess = Effect.fn("executeProcess")(
  function* (
    args: readonly string[],
    options: ProcessOptions & { timeoutMs?: number | undefined } = {},
  ) {
    const [command, ...arguments_] = args;
    if (!command)
      return yield* Effect.fail(new InvalidProcessCommandError({ args }));
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make(command, arguments_, {
        cwd: options.cwd,
        stdin: options.input === undefined ? "ignore" : "pipe",
        stdout: "pipe",
        stderr: "pipe",
        // Scope interruption and verification timeouts must terminate descendants,
        // including commands which ignore SIGTERM.
        killSignal: "SIGKILL",
      }),
    );
    // The platform skips group cleanup when the leader already exited with 0.
    // Its descendants can still own our output pipes; the group's lifetime is
    // this operation's scope even after the leader exits.
    yield* Effect.addFinalizer(() =>
      child.kill({ killSignal: "SIGKILL" }).pipe(Effect.ignore),
    );
    const timedOut = yield* Ref.make(false);
    const collect = Effect.all(
      {
        // Await delivery ourselves: the platform's Stream stdin option forks a
        // writer whose failure would otherwise be invisible to the result.
        input:
          options.input === undefined
            ? Effect.void
            : Stream.run(
                Stream.succeed(new TextEncoder().encode(options.input)),
                child.stdin,
              ),
        stdout: Stream.mkString(Stream.decodeText(child.stdout)),
        stderr: Stream.mkString(Stream.decodeText(child.stderr)),
        exitCode: child.exitCode.pipe(
          Effect.catch((error) => {
            const code = signalExitCode(error);
            return code === undefined
              ? Effect.fail(error)
              : Effect.succeed(code);
          }),
        ),
      },
      { concurrency: "unbounded" },
    ).pipe(
      Effect.map(({ stdout, stderr, exitCode }) => ({
        stdout,
        stderr,
        exitCode,
      })),
    );
    const result =
      options.timeoutMs === undefined
        ? yield* collect
        : yield* Effect.raceFirst(
            collect,
            Effect.gen(function* () {
              yield* Effect.sleep(options.timeoutMs ?? 0);
              yield* Ref.set(timedOut, true);
              yield* child.kill({ killSignal: "SIGKILL" });
              // Keep the collectors running until EOF so timeout diagnostics survive.
              return yield* Effect.never;
            }),
          );
    return { ...result, timedOut: yield* Ref.get(timedOut) };
  },
  Effect.scoped,
  (
    effect,
    ...[args]: [
      args: readonly string[],
      options?: ProcessOptions & { timeoutMs?: number | undefined },
    ]
  ) =>
    Effect.mapError(effect, (cause) =>
      cause._tag === "PlatformError"
        ? new ProcessExecutionError({ args, cause })
        : cause,
    ),
);

// The pinned platform reports signal exits as PlatformError rather than a code.
// Translate only that specific exit event to Bun's previous 128 + signal contract.
function signalExitCode(
  error: PlatformError.PlatformError,
): number | undefined {
  if (
    error.reason.module !== "ChildProcess" ||
    error.reason.method !== "exitCode"
  )
    return undefined;
  const cause = error.reason.cause;
  if (!(cause instanceof Error)) return undefined;
  const signal =
    /^Process interrupted due to receipt of signal: '(SIG[A-Z0-9]+)'$/.exec(
      cause.message,
    )?.[1];
  const entry = Object.entries(constants.signals).find(
    ([name]) => name === signal,
  );
  return entry === undefined ? undefined : 128 + entry[1];
}

export const runProcess = Effect.fnUntraced(function* (
  args: readonly string[],
  options: ProcessOptions = {},
): Effect.fn.Return<
  ProcessResult,
  InvalidProcessCommandError | ProcessExecutionError,
  ChildProcessSpawner.ChildProcessSpawner
> {
  const { stdout, stderr, exitCode } = yield* executeProcess(args, options);
  return { stdout, stderr, exitCode };
});

export const runProcessOrThrow = Effect.fnUntraced(function* (
  args: readonly string[],
  options: ProcessOptions & { label?: string } = {},
) {
  const result = yield* runProcess(args, options);
  if (result.exitCode !== 0)
    return yield* Effect.fail(
      new ProcessExitError({ label: options.label ?? args.join(" "), result }),
    );
  return result.stdout;
});
