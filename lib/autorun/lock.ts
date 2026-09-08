import {
  Clock,
  DateTime,
  Effect,
  FileSystem,
  Option,
  Predicate,
  Schema,
} from "effect";
import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

const LocalLockOwner = Schema.Struct({
  token: Schema.String,
  pid: Schema.Int.check(Schema.isGreaterThan(0)),
  checkout: Schema.String,
  description: Schema.String,
  acquiredAt: Schema.String,
});
const decodeOwner = Schema.decodeUnknownEffect(
  Schema.fromJsonString(LocalLockOwner),
);
const ownerlessLockGraceMs = 5_000;

export class CheckoutLockedError extends Schema.TaggedError<CheckoutLockedError>()(
  "CheckoutLockedError",
  {
    checkout: Schema.String,
    lockDir: Schema.String,
    description: Schema.String,
  },
) {
  override get message() {
    return `${this.description} is already running for checkout '${this.checkout}' (lock: ${this.lockDir}).`;
  }
}

export const withCheckoutLock = Effect.fnUntraced(function* <A, E, R>(
  input: { cwd: string; name: string; description: string },
  work: Effect.Effect<A, E, R>,
) {
  return yield* Effect.acquireUseRelease(
    acquireCheckoutLock(input),
    () => work,
    releaseCheckoutLock,
  );
});

export const withAutorunIssueLock = Effect.fnUntraced(function* <A, E, R>(
  input: { cwd: string; issueNumber: number | string; description: string },
  work: Effect.Effect<A, E, R>,
) {
  return yield* withCheckoutLock(
    { ...input, name: `autorun-issue-${input.issueNumber}` },
    work,
  );
});

const acquireCheckoutLock = Effect.fn("acquireCheckoutLock")(function* (input: {
  cwd: string;
  name: string;
  description: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const checkout = yield* fs
    .realPath(path.resolve(input.cwd))
    .pipe(Effect.catch(() => Effect.succeed(path.resolve(input.cwd))));
  const lockDir = checkoutLockDir({ checkout, name: input.name });
  const token = randomUUID();
  yield* fs.makeDirectory(path.dirname(lockDir), { recursive: true });
  for (let remainingAttempts = 2; remainingAttempts > 0; remainingAttempts--) {
    const created = yield* fs.makeDirectory(lockDir).pipe(
      Effect.as(true),
      Effect.catch((error) =>
        error.reason._tag === "AlreadyExists"
          ? Effect.succeed(false)
          : Effect.fail(error),
      ),
    );
    if (!created) {
      if (yield* removeStaleLock(lockDir)) continue;
      return yield* new CheckoutLockedError({
        checkout,
        lockDir,
        description: input.description,
      });
    }
    const owner = {
      token,
      pid: process.pid,
      checkout,
      description: input.description,
      acquiredAt: DateTime.formatIso(yield* DateTime.now),
    };
    // Acquisition owns the directory until ownership has been persisted successfully.
    yield* fs
      .writeFileString(
        path.join(lockDir, "owner.json"),
        `${JSON.stringify(owner, null, 2)}\n`,
      )
      .pipe(
        Effect.onError(() =>
          fs
            .remove(lockDir, { recursive: true, force: true })
            .pipe(Effect.orDie),
        ),
      );
    return { dir: lockDir, token };
  }
  return yield* new CheckoutLockedError({
    checkout,
    lockDir,
    description: input.description,
  });
});

const readOwner = Effect.fnUntraced(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs
    .readFileString(path.join(dir, "owner.json"))
    .pipe(Effect.flatMap(decodeOwner), Effect.option);
});

const releaseCheckoutLock = Effect.fn("releaseCheckoutLock")(function* (lock: {
  dir: string;
  token: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const owner = yield* readOwner(lock.dir);
  if (Option.isNone(owner) || owner.value.token !== lock.token) return;
  yield* fs.remove(lock.dir, { recursive: true, force: true });
});

const removeStaleLock = Effect.fnUntraced(function* (lockDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const owner = yield* readOwner(lockDir);
  if (Option.isSome(owner)) {
    if (owner.value.pid === process.pid || isProcessAlive(owner.value.pid))
      return false;
  } else {
    const info = yield* fs.stat(lockDir).pipe(Effect.option);
    if (Option.isNone(info) || Option.isNone(info.value.mtime)) return false;
    const age =
      (yield* Clock.currentTimeMillis) - info.value.mtime.value.getTime();
    if (age < ownerlessLockGraceMs) return false;
  }
  yield* fs.remove(lockDir, { recursive: true, force: true });
  return true;
});

function checkoutLockDir(input: { checkout: string; name: string }): string {
  const checkoutHash = createHash("sha256")
    .update(input.checkout)
    .digest("hex")
    .slice(0, 16);
  return path.join(
    os.tmpdir(),
    "roark-coding-agent-locks",
    `${checkoutHash}-${sanitizeLockName(input.name)}.lock`,
  );
}

function sanitizeLockName(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^[.-]+|[.-]+$/g, "") || "lock"
  );
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(Predicate.hasProperty(error, "code") && error.code === "ESRCH");
  }
}
