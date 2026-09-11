import { Effect, Schema } from "effect";
import { runProcessOrThrow } from "../cli/process.ts";
import { GitHubResponseError } from "./errors.ts";

const commentSchema = Schema.Struct({
  id: Schema.Number,
  body: Schema.NullOr(Schema.String),
  html_url: Schema.String,
  created_at: Schema.String,
  updated_at: Schema.String,
  author_association: Schema.optional(Schema.String),
  user: Schema.NullOr(Schema.Struct({ login: Schema.String })),
});
const decodePages = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(Schema.Array(commentSchema))),
);
export const fetchIssueComments = Effect.fn("GitHub.fetchIssueComments")(
  function* (input: { cwd: string; repo: string; issueNumber: string }) {
    const parts = input.repo.split("/");
    const hostname = parts.length === 3 ? parts[0] : undefined;
    const repo = parts.length === 3 ? parts.slice(1).join("/") : input.repo;
    const raw = yield* runProcessOrThrow(
      [
        "gh",
        "api",
        `repos/${repo}/issues/${input.issueNumber}/comments`,
        "--paginate",
        "--slurp",
        ...(hostname ? ["--hostname", hostname] : []),
      ],
      { cwd: input.cwd, label: "gh api issue comments" },
    );
    const pages = yield* decodePages(raw).pipe(
      Effect.mapError((cause) => new GitHubResponseError({ cause })),
    );
    return pages.flat().map((comment) => ({
      id: String(comment.id),
      url: comment.html_url,
      body: comment.body ?? "",
      createdAt: comment.created_at,
      updatedAt: comment.updated_at,
      authorAssociation: comment.author_association,
      author: comment.user === null ? undefined : { login: comment.user.login },
    }));
  },
);
