import { Effect } from "effect";
import {
  AttemptStore,
  type AttemptMetadata,
  type AttemptSummary,
} from "./attempts.ts";
import {
  runApplicationPromise,
  type ApplicationExecution,
} from "../runtime/application.ts";

export function allocateNextAttemptPromise(
  issueDir: string,
  application?: ApplicationExecution,
) {
  return runApplicationPromise(
    Effect.flatMap(AttemptStore, (store) => store.allocate(issueDir)),
    application,
  );
}
export function writeAttemptMetadataPromise(
  issueDir: string,
  metadata: AttemptMetadata,
  application?: ApplicationExecution,
) {
  return runApplicationPromise(
    Effect.flatMap(AttemptStore, (store) => store.write(issueDir, metadata)),
    application,
  );
}
export function readAttemptMetadataPromise(
  issueDir: string,
  attempt: number,
  application?: ApplicationExecution,
) {
  return runApplicationPromise(
    Effect.flatMap(AttemptStore, (store) => store.read(issueDir, attempt)),
    application,
  );
}
export function readAttemptIndexPromise(
  issueDir: string,
  application?: ApplicationExecution,
) {
  return runApplicationPromise(
    Effect.flatMap(AttemptStore, (store) => store.list(issueDir)),
    application,
  );
}
export function latestAttemptNumberPromise(
  issueDir: string,
  application?: ApplicationExecution,
) {
  return runApplicationPromise(
    Effect.flatMap(AttemptStore, (store) => store.latest(issueDir)),
    application,
  );
}
export function updateAttemptIndexPromise(
  issueDir: string,
  summary: AttemptSummary,
  application?: ApplicationExecution,
) {
  return runApplicationPromise(
    Effect.flatMap(AttemptStore, (store) =>
      store.updateIndex(issueDir, summary),
    ),
    application,
  );
}
