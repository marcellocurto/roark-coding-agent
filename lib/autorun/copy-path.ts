import path from "node:path";
import { Result, Schema, SchemaGetter, SchemaIssue } from "effect";

const normalizedPath = Schema.String.annotate({
  message: "must be a non-empty string.",
})
  .pipe(
    Schema.decodeTo(Schema.String, {
      decode: SchemaGetter.transform((value) =>
        value.trim().replace(/\\+/g, "/"),
      ),
      encode: SchemaGetter.passthrough(),
    }),
  )
  .check(
    Schema.makeFilter((value) => value.length > 0, {
      message: "entries must be non-empty strings.",
    }),
    Schema.makeFilter((value) => !/[\*?\[]/.test(value), {
      message: "must be a literal path; globs are not supported.",
    }),
    Schema.makeFilter(
      (value) =>
        !path.isAbsolute(value) &&
        !/^[A-Za-z]:\//.test(value) &&
        !value.startsWith("//"),
      { message: "must be a relative path." },
    ),
    Schema.makeFilter((value) => value.split("/").filter(Boolean).length > 0, {
      message: "must be a non-empty relative path.",
    }),
    Schema.makeFilter((value) => !value.split("/").includes(".."), {
      message: "must not contain parent traversal.",
    }),
    Schema.makeFilter((value) => !value.split("/").includes(".git"), {
      message: "must not target .git.",
    }),
  );

export const copyToWorktreePathSchema = normalizedPath.pipe(
  Schema.decodeTo(Schema.String, {
    decode: SchemaGetter.transform((value) =>
      value.split("/").filter(Boolean).join("/"),
    ),
    encode: SchemaGetter.passthrough(),
  }),
);

const decodePath = Schema.decodeUnknownResult(copyToWorktreePathSchema);
const formatIssue = SchemaIssue.makeFormatterStandardSchemaV1();

class InvalidCopyPathError extends Schema.TaggedError<InvalidCopyPathError>()(
  "InvalidCopyPathError",
  {
    keyPath: Schema.String,
    input: Schema.Unknown,
    cause: Schema.declare(Schema.isSchemaError),
  },
) {
  override get message(): string {
    const detail =
      formatIssue(this.cause.issue).issues[0]?.message ?? this.cause.message;
    return `${this.keyPath} entry '${String(this.input)}' ${detail}`;
  }
}

export function validateCopyToWorktreeEntry(
  value: string,
  keyPath = "workspace.copyToWorktree",
): string {
  const result = decodePath(value);
  if (Result.isFailure(result))
    throw new InvalidCopyPathError({
      keyPath,
      input: value,
      cause: result.failure,
    });
  return result.success;
}
