import { RepositoryConfiguration } from "../runtime/services.ts";
import path from "node:path";
import {
  Effect,
  FileSystem,
  Layer,
  Option,
  PlatformError,
  Schema,
  SchemaGetter,
  SchemaIssue,
} from "effect";
import {
  defaultLifecycleHooks,
  defaultWorkspaceConfig,
} from "../autorun/workspace-config.ts";
import { copyToWorktreePathSchema } from "../autorun/copy-path.ts";

const nonEmptyString = Schema.String.check(
  Schema.makeFilter((value) => value.trim().length > 0, {
    message: "must be a non-empty string.",
  }),
).annotate({ message: "must be a non-empty string." });

const positiveInteger = Schema.Int.check(
  Schema.isGreaterThan(0, { message: "must be a positive safe integer." }),
).annotate({ message: "must be a positive safe integer." });

const cloneSchema = Schema.Struct({
  filter: Schema.optional(Schema.NullOr(nonEmptyString)).pipe(
    Schema.withDecodingDefault(
      Effect.succeed(defaultWorkspaceConfig.clone.filter),
    ),
  ),
  depth: Schema.optional(Schema.NullOr(positiveInteger)).pipe(
    Schema.withDecodingDefault(
      Effect.succeed(defaultWorkspaceConfig.clone.depth),
    ),
  ),
}).annotate({ message: "must be an object." });

const workspaceSchema = Schema.Struct({
  root: Schema.NullOr(nonEmptyString).pipe(
    Schema.decodeTo(nonEmptyString, {
      decode: SchemaGetter.transform(
        (value) => value ?? defaultWorkspaceConfig.root,
      ),
      encode: SchemaGetter.passthrough(),
    }),
    Schema.withDecodingDefault(Effect.succeed(defaultWorkspaceConfig.root)),
  ),
  strategy: Schema.NullOr(Schema.Literal("clone"))
    .annotate({ message: "must be 'clone'." })
    .pipe(
      Schema.decodeTo(Schema.Literal("clone"), {
        decode: SchemaGetter.transform((value) => value ?? "clone"),
        encode: SchemaGetter.passthrough(),
      }),
      Schema.withDecodingDefault(Effect.succeed("clone" as const)),
    )
    .annotate({ message: "must be 'clone'." }),
  cloneRemote: Schema.NullOr(nonEmptyString).pipe(
    Schema.decodeTo(nonEmptyString, {
      decode: SchemaGetter.transform(
        (value) => value ?? defaultWorkspaceConfig.cloneRemote,
      ),
      encode: SchemaGetter.passthrough(),
    }),
    Schema.withDecodingDefault(
      Effect.succeed(defaultWorkspaceConfig.cloneRemote),
    ),
  ),
  clone: cloneSchema.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  copyToWorktree: Schema.mutable(Schema.Array(copyToWorktreePathSchema))
    .annotate({ message: "must be an array of relative paths." })
    .pipe(
      Schema.withDecodingDefault(
        Effect.sync(() => [...defaultWorkspaceConfig.copyToWorktree]),
      ),
    ),
}).annotate({ message: "must be an object." });

const hooksSchema = Schema.Struct({
  afterCreate: Schema.optional(nonEmptyString).annotate({
    message: "must be a non-empty string.",
  }),
  beforeRun: Schema.optional(nonEmptyString).annotate({
    message: "must be a non-empty string.",
  }),
  beforeVerify: Schema.optional(nonEmptyString).annotate({
    message: "must be a non-empty string.",
  }),
  afterRun: Schema.optional(nonEmptyString).annotate({
    message: "must be a non-empty string.",
  }),
  beforeRemove: Schema.optional(nonEmptyString).annotate({
    message: "must be a non-empty string.",
  }),
  timeoutMs: positiveInteger.pipe(
    Schema.withDecodingDefault(Effect.succeed(defaultLifecycleHooks.timeoutMs)),
  ),
}).annotate({ message: "must be an object." });

export const roarkConfigSchema = Schema.Struct({
  repo: Schema.optional(nonEmptyString).annotate({
    message: "must be a non-empty string.",
  }),
  baseBranch: Schema.optional(nonEmptyString).annotate({
    message: "must be a non-empty string.",
  }),
  verify: Schema.optional(nonEmptyString).annotate({
    message: "must be a non-empty string.",
  }),
  readyLabel: Schema.optional(nonEmptyString).annotate({
    message: "must be a non-empty string.",
  }),
  inProgressLabel: Schema.optional(nonEmptyString).annotate({
    message: "must be a non-empty string.",
  }),
  successLabel: Schema.optional(nonEmptyString).annotate({
    message: "must be a non-empty string.",
  }),
  failureLabel: Schema.optional(nonEmptyString).annotate({
    message: "must be a non-empty string.",
  }),
  skipLabels: Schema.optional(
    Schema.mutable(Schema.Array(nonEmptyString)).annotate({
      message: "must be an array of non-empty strings.",
    }),
  ),
  maxFixPasses: Schema.optional(positiveInteger),
  workspace: Schema.optional(workspaceSchema),
  hooks: Schema.optional(hooksSchema),
  sandbox: Schema.optional(
    Schema.Struct({
      provider: Schema.optional(Schema.Literal("host"))
        .annotate({ message: "must be 'host'." })
        .pipe(
          Schema.decodeTo(Schema.Literal("host"), {
            decode: SchemaGetter.withDefault(Effect.succeed("host" as const)),
            encode: SchemaGetter.passthrough(),
          }),
        ),
    }).annotate({ message: "must be an object." }),
  ),
  notifications: Schema.optional(
    Schema.Struct({
      onExit: Schema.optional(Schema.NullOr(Schema.Boolean))
        .annotate({ message: "must be a boolean." })
        .pipe(
          Schema.decodeTo(Schema.Boolean, {
            decode: SchemaGetter.transformOptional((value) =>
              Option.some(Option.getOrUndefined(value) ?? false),
            ),
            encode: SchemaGetter.passthrough(),
          }),
        ),
    }).annotate({ message: "must be an object." }),
  ),
}).annotate({ message: "expected a JSON object." });

export type RoarkConfig = typeof roarkConfigSchema.Type;

const parseOptions = { onExcessProperty: "error" } as const;
const decodeValue = Schema.decodeUnknownEffect(roarkConfigSchema, parseOptions);
const decodeJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(roarkConfigSchema),
  parseOptions,
);
const unexpectedKey = "Unexpected config key";
const formatIssue = SchemaIssue.makeFormatterStandardSchemaV1({
  leafHook: (issue) =>
    issue._tag === "UnexpectedKey"
      ? unexpectedKey
      : SchemaIssue.defaultLeafHook(issue),
});
const unsupportedKeys = new Set(["model", "thinking", "updateStrategy"]);

export class RoarkConfigError extends Schema.TaggedError<RoarkConfigError>()(
  "RoarkConfigError",
  {
    configPath: Schema.String,
    cause: Schema.Union([
      Schema.declare(Schema.isSchemaError),
      Schema.instanceOf(PlatformError.PlatformError),
    ]),
  },
) {
  override get message(): string {
    if (this.cause._tag === "PlatformError")
      return `Invalid Roark config at ${this.configPath}: ${this.cause.message}`;
    const issue = formatIssue(this.cause.issue).issues[0];
    if (!issue)
      return `Invalid Roark config at ${this.configPath}: ${this.cause.message}`;
    const keys = (issue.path ?? []).map((part) =>
      typeof part === "object" ? part.key : part,
    );
    const key = keys.reduce<string>(
      (result, part) =>
        typeof part === "number"
          ? `${result}[${part}]`
          : `${result}${result ? "." : ""}${String(part)}`,
      "",
    );
    if (issue.message === unexpectedKey) {
      if (unsupportedKeys.has(key))
        return `Unsupported Roark config key '${key}' in ${this.configPath}. '${key}' is CLI-only or not supported in config v1.`;
      return `Unknown Roark config key '${key}' in ${this.configPath}.`;
    }
    return `Invalid Roark config at ${this.configPath}: ${key ? `'${key}' ` : ""}${issue.message}`;
  }
}

export const decodeRoarkConfig = Effect.fnUntraced(function* (
  input: unknown,
  configPath: string,
) {
  return yield* decodeValue(input).pipe(
    Effect.mapError((cause) => new RoarkConfigError({ configPath, cause })),
  );
});

export const decodeRoarkConfigJson = Effect.fnUntraced(function* (
  input: string,
  configPath: string,
) {
  return yield* decodeJson(input).pipe(
    Effect.mapError((cause) => new RoarkConfigError({ configPath, cause })),
  );
});

const readRoarkConfig = Effect.fn("loadRoarkConfig")(function* (
  workspace: string,
): Effect.fn.Return<
  RoarkConfig,
  RoarkConfigError | PlatformError.PlatformError,
  FileSystem.FileSystem
> {
  const configPath = path.join(workspace, ".roark", "config.json");
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(configPath))) return {};
  const content = yield* fs
    .readFileString(configPath)
    .pipe(
      Effect.mapError((cause) => new RoarkConfigError({ configPath, cause })),
    );
  return yield* decodeRoarkConfigJson(content, configPath);
});

export const repositoryConfigurationLayer = Layer.effect(
  RepositoryConfiguration,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return RepositoryConfiguration.of({
      load: (workspace) =>
        readRoarkConfig(workspace).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
        ),
    });
  }),
);

export const loadRoarkConfig = Effect.fnUntraced(function* (workspace: string) {
  const configuration = yield* RepositoryConfiguration;
  return yield* configuration.load(workspace);
});
