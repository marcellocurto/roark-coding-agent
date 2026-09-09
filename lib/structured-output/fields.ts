import path from "node:path";
import { Schema, SchemaGetter } from "effect";

const nonBlank = Schema.String.check(
  Schema.makeFilter((value) => value.length > 0 || "must not be blank"),
);

export function trimmedText(description: string) {
  return Schema.String.check(Schema.isMinLength(1))
    .annotate({ description })
    .pipe(
      Schema.decodeTo(nonBlank, {
        decode: SchemaGetter.transform((value) => value.trim()),
        encode: SchemaGetter.passthrough(),
      }),
    );
}

// Historical scalar fields require non-empty input but allow whitespace to
// normalize to empty text. List entries and report fields use trimmedText.
export function trimmedScalar(description: string) {
  return Schema.String.check(Schema.isMinLength(1))
    .annotate({ description })
    .pipe(
      Schema.decodeTo(Schema.String, {
        decode: SchemaGetter.transform((value) => value.trim()),
        encode: SchemaGetter.passthrough(),
      }),
    );
}

const portablePath = trimmedText(
  "Repository-relative path changed during this phase.",
)
  .pipe(
    Schema.decodeTo(Schema.String, {
      decode: SchemaGetter.transform((value) => value.replaceAll("\\", "/")),
      encode: SchemaGetter.passthrough(),
    }),
  )
  .check(
    Schema.makeFilter((value) => {
      if (path.posix.isAbsolute(value) || /^[A-Za-z]:\//.test(value))
        return "must be repository-relative.";
      if (value.split("/").includes(".."))
        return "must not escape the repository.";
    }),
  );
export const repositoryRelativePath = portablePath.pipe(
  Schema.decodeTo(nonBlank, {
    decode: SchemaGetter.transform((value) => value.replace(/^\.\//, "")),
    encode: SchemaGetter.passthrough(),
  }),
);
export const changedFileSchema = Schema.Struct({
  path: repositoryRelativePath,
  description: trimmedText("What changed in this file and why."),
});
export const changedFilesSchema = Schema.mutable(
  Schema.Array(changedFileSchema),
).check(
  Schema.makeFilter((files) => {
    const paths = files.map((file) => file.path);
    const duplicates = [
      ...new Set(
        paths.filter((value, index) => paths.indexOf(value) !== index),
      ),
    ];
    if (duplicates.length > 0)
      return `changedFiles paths must not contain duplicates: ${duplicates.join(", ")}.`;
  }),
);
export const validationEntrySchema = Schema.Struct({
  command: trimmedText("Exact validation command that ran or should run."),
  status: Schema.Literals(["passed", "failed", "not-run"]),
  details: trimmedText(
    "Observed result or concrete reason the command was not run.",
  ),
});
export const validationEntriesSchema = Schema.mutable(
  Schema.Array(validationEntrySchema),
).check(Schema.isMinLength(1));
