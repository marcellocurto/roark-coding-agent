import { Context, Effect, FileSystem, Layer, type PlatformError } from "effect";
import path from "node:path";
import { artifactFilename, type ArtifactRef } from "./artifact-catalog.ts";

export interface ArtifactLocation {
  readonly runDir: string;
}

export class ArtifactStore extends Context.Service<
  ArtifactStore,
  {
    ensure(
      location: ArtifactLocation,
    ): Effect.Effect<void, PlatformError.PlatformError>;
    exists(
      location: ArtifactLocation,
      artifact: ArtifactRef,
    ): Effect.Effect<boolean, PlatformError.PlatformError>;
    read(
      location: ArtifactLocation,
      artifact: ArtifactRef,
    ): Effect.Effect<string, PlatformError.PlatformError>;
    write(
      location: ArtifactLocation,
      artifact: ArtifactRef,
      content: string,
    ): Effect.Effect<void, PlatformError.PlatformError>;
  }
>()("roark/workflow/ArtifactStore") {}

export const artifactStoreLayer = Layer.effect(
  ArtifactStore,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const ensure = (location: ArtifactLocation) =>
      fs.makeDirectory(location.runDir, { recursive: true });
    return ArtifactStore.of({
      ensure,
      exists: (location, artifact) =>
        fs.exists(path.join(location.runDir, artifactFilename(artifact))),
      read: (location, artifact) =>
        fs.readFileString(
          path.join(location.runDir, artifactFilename(artifact)),
        ),
      write: Effect.fn("ArtifactStore.write")(function* (
        location,
        artifact,
        content,
      ) {
        yield* ensure(location);
        yield* fs.writeFileString(
          path.join(location.runDir, artifactFilename(artifact)),
          content.endsWith("\n") ? content : `${content}\n`,
        );
      }, Effect.uninterruptible),
    });
  }),
);
