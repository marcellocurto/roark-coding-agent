import { GitHubResponseError } from "../github/errors.ts";
import { Effect, Schema } from "effect";

import { runProcess, runProcessOrThrow } from "../cli/process.ts";
export interface IssuePublishRequest {
  cwd: string;
  repo?: string | undefined;
  title: string;
  body: string;
  labels: readonly string[];
}
export interface IssuePublishResult {
  url: string;
  number?: number | undefined;
  stdout?: string | undefined;
}
export const publishIssueWithGitHub = Effect.fn("publishIssueWithGitHub")(
  function* (request: IssuePublishRequest) {
    const repoArgs = request.repo ? ["--repo", request.repo] : [];
    const duplicateSearch = yield* runProcess(
      [
        "gh",
        "issue",
        "list",
        "--state",
        "all",
        "--search",
        `\"${request.title}\" in:title`,
        "--json",
        "number,title,url",
        "--limit",
        "20",
        ...repoArgs,
      ],
      { cwd: request.cwd },
    );
    if (duplicateSearch.exitCode !== 0) {
      return yield* Effect.fail(
        new Error(
          `gh issue duplicate search failed with exit code ${duplicateSearch.exitCode}:\n${duplicateSearch.stderr || duplicateSearch.stdout}`,
        ),
      );
    }
    const duplicate = yield* exactTitleMatch(
      duplicateSearch.stdout,
      request.title,
    );
    if (duplicate)
      return yield* Effect.fail(
        new Error(
          `An issue with the same title already exists: ${duplicate.url ?? `#${duplicate.number ?? "unknown"}`}`,
        ),
      );
    const stdout = yield* runProcessOrThrow(
      [
        "gh",
        "issue",
        "create",
        "--title",
        request.title,
        "--body-file",
        "-",
        ...request.labels.flatMap((label) => ["--label", label]),
        ...repoArgs,
      ],
      { cwd: request.cwd, label: "gh issue create", input: request.body },
    );
    const url = /https?:\/\/\S+\/issues\/\d+/
      .exec(stdout)?.[0]
      ?.replace(/[),.;]+$/, "");
    if (!url)
      return yield* Effect.fail(
        new Error("gh issue create succeeded but did not return an issue URL."),
      );
    const number = Number.parseInt(/\/issues\/(\d+)/.exec(url)?.[1] ?? "", 10);
    return { url, ...(Number.isInteger(number) ? { number } : {}), stdout };
  },
);
const duplicateSearchSchema = Schema.Array(
  Schema.Struct({
    title: Schema.String,
    number: Schema.optional(Schema.Int),
    url: Schema.optional(Schema.String),
  }),
);
const decodeDuplicateSearch = Schema.decodeUnknownEffect(
  Schema.fromJsonString(duplicateSearchSchema),
);
const exactTitleMatch = Effect.fnUntraced(function* (
  output: string,
  title: string,
) {
  const issues = yield* decodeDuplicateSearch(output).pipe(
    Effect.mapError((cause) => new GitHubResponseError({ cause })),
  );
  const normalizedTitle = normalizeTitle(title);
  return issues.find(
    (issue) => normalizeTitle(issue.title) === normalizedTitle,
  );
});
function normalizeTitle(title: string): string {
  return title.replace(/\s+/g, " ").trim().toLocaleLowerCase();
}
