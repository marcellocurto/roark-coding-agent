import { getCurrentGitHubRepository } from "./gh.ts";
import { GitHubRequestError, GitHubResponseError } from "./errors.ts";
import { DateTime, Effect, Schema } from "effect";
import type { GitHubError, GitHubRequirements } from "./errors.ts";
import type { AutorunClaimPlan } from "../autorun/claim.ts";
import { runProcessOrThrow } from "../cli/process.ts";
import { postIssueComment } from "./comments.ts";
import { fetchIssueComments } from "./issue-comments.ts";
export interface ParsedIssueRef {
  issueNumber: string;
  repo?: string | undefined;
}
const issueLabelSchema = Schema.Struct({ name: Schema.String });
const issueListItemSchema = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  body: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
  createdAt: Schema.optional(Schema.String),
  labels: Schema.optional(Schema.mutable(Schema.Array(issueLabelSchema))),
});
const issueSchema = Schema.Struct({
  ...issueListItemSchema.fields,
  state: Schema.optional(Schema.String),
  assignees: Schema.optional(
    Schema.mutable(Schema.Array(Schema.Struct({ login: Schema.String }))),
  ),
  milestone: Schema.optional(
    Schema.NullOr(Schema.Struct({ title: Schema.String })),
  ),
});
const parseIssueList = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.mutable(Schema.Array(issueListItemSchema))),
);
const parseIssue = Schema.decodeUnknownEffect(
  Schema.fromJsonString(issueSchema),
);
export interface GitHubIssue {
  number: number;
  title: string;
  body?: string | undefined;
  state?: string | undefined;
  labels?:
    | {
        name: string;
      }[]
    | undefined;
  assignees?:
    | {
        login: string;
      }[]
    | undefined;
  milestone?:
    | {
        title: string;
      }
    | null
    | undefined;
  url?: string | undefined;
  comments?: {
    id?: string | undefined;
    url?: string | undefined;
    updatedAt?: string | undefined;
    authorAssociation?: string | undefined;
    author?:
      | {
          login: string;
        }
      | undefined;
    body?: string | undefined;
    createdAt?: string | undefined;
  }[];
}
export interface GitHubIssueListItem {
  number: number;
  title: string;
  body?: string | undefined;
  url?: string | undefined;
  createdAt?: string | undefined;
  labels?:
    | {
        name: string;
      }[]
    | undefined;
}
export interface GitHubIssueDependency {
  number: number;
  title: string;
  url?: string | undefined;
  state: string;
  stateReason?: string | null | undefined;
  closedAt?: string | null | undefined;
}
export interface GitHubIssueDependenciesSummary {
  blockedBy: number;
  blocking: number;
  totalBlockedBy: number;
  totalBlocking: number;
}
export interface BodyDeclaredBlocker {
  raw: string;
  repo: string;
  number: number;
  verified: boolean;
  title?: string | undefined;
  url?: string | undefined;
  state?: string | undefined;
  stateReason?: string | null | undefined;
  closed?: boolean | undefined;
  closedAt?: string | null | undefined;
  unavailableReason?: string | undefined;
}
export interface GitHubIssueRelationships {
  fetchedAt: string;
  repo?: string | undefined;
  nativeDependenciesAvailable: boolean;
  issueDependenciesSummary?: GitHubIssueDependenciesSummary | undefined;
  blockedBy: GitHubIssueDependency[];
  blocking: GitHubIssueDependency[];
  bodyDeclaredBlockers: BodyDeclaredBlocker[];
  unavailableReason?: string | undefined;
}
export interface GitHubIssueSnapshot {
  issue: GitHubIssue;
  issueNumber: string;
  repo?: string | undefined;
  fetchedAt: string;
  relationships: GitHubIssueRelationships;
}
interface BodyBlockerRef {
  raw: string;
  repo: string;
  number: number;
}
export function parseIssueRef(
  input: string,
  explicitRepo?: string,
): ParsedIssueRef {
  const urlMatch =
    /^https?:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/(\d+)/i.exec(input);
  if (urlMatch?.[1] && urlMatch[2])
    return { repo: explicitRepo ?? urlMatch[1], issueNumber: urlMatch[2] };
  const shorthandMatch = /^([^/\s]+\/[^#\s]+)#(\d+)$/.exec(input);
  if (shorthandMatch?.[1] && shorthandMatch[2]) {
    return {
      repo: explicitRepo ?? shorthandMatch[1],
      issueNumber: shorthandMatch[2],
    };
  }
  const numberMatch = /^#?(\d+)$/.exec(input);
  if (numberMatch?.[1])
    return { repo: explicitRepo, issueNumber: numberMatch[1] };
  throw new Error(
    `Could not parse issue '${input}'. Use a number, GitHub issue URL, or owner/repo#123.`,
  );
}
export const listOpenGitHubIssues = Effect.fn("GitHub.listOpenGitHubIssues")(
  function* (options: {
    cwd: string;
    repo?: string | undefined;
    limit: number;
  }): Effect.fn.Return<GitHubIssueListItem[], GitHubError, GitHubRequirements> {
    const args = [
      "gh",
      "issue",
      "list",
      "--state",
      "open",
      "--limit",
      String(options.limit),
      "--json",
      "number,title,body,url,createdAt,labels",
    ];
    if (options.repo) args.push("--repo", options.repo);
    const stdout = yield* runProcessOrThrow(args, {
      cwd: options.cwd,
      label: "gh issue list",
    });
    return yield* parseIssueList(stdout).pipe(
      Effect.mapError((cause) => new GitHubResponseError({ cause })),
    );
  },
);
export const claimGitHubIssue = Effect.fn("GitHub.claimGitHubIssue")(
  function* (options: {
    cwd: string;
    repo?: string | undefined;
    plan: AutorunClaimPlan;
    postComment?: boolean;
  }): Effect.fn.Return<void, GitHubError, GitHubRequirements> {
    const issueNumber = String(options.plan.issueNumber);
    const repoArgs = options.repo ? ["--repo", options.repo] : [];
    yield* transitionGitHubIssueLabels({
      cwd: options.cwd,
      repo: options.repo,
      issueNumber: options.plan.issueNumber,
      nextLabel: options.plan.inProgressLabel,
      removeLabels: options.plan.removeLabels,
    });
    if (options.plan.assignee) {
      yield* runProcessOrThrow(
        [
          "gh",
          "issue",
          "edit",
          issueNumber,
          "--add-assignee",
          options.plan.assignee,
          ...repoArgs,
        ],
        { cwd: options.cwd, label: "gh issue edit --add-assignee" },
      );
    }
    if (options.postComment === false) return;
    yield* postIssueComment({
      cwd: options.cwd,
      repo: options.repo,
      issueNumber,
      body: options.plan.commentBody,
    });
  },
);
export const transitionGitHubIssueLabels = Effect.fn(
  "GitHub.transitionGitHubIssueLabels",
)(function* (options: {
  cwd: string;
  repo?: string | undefined;
  issueNumber: string | number;
  nextLabel: string;
  removeLabels: readonly string[];
}): Effect.fn.Return<void, GitHubError, GitHubRequirements> {
  const issueNumber = String(options.issueNumber);
  const repoArgs = options.repo ? ["--repo", options.repo] : [];
  const labelArgs = options.removeLabels
    .filter((candidate) => candidate !== options.nextLabel)
    .flatMap((label) => ["--remove-label", label]);
  yield* runProcessOrThrow(
    [
      "gh",
      "issue",
      "edit",
      issueNumber,
      "--add-label",
      options.nextLabel,
      ...labelArgs,
      ...repoArgs,
    ],
    { cwd: options.cwd, label: "gh issue edit --transition-label" },
  );
});
export function buildIssueDependenciesSummaryArgv(
  repo: string,
  issueNumber: string | number,
): string[] {
  return ["gh", "api", `repos/${repo}/issues/${issueNumber}`];
}
export function buildIssueBlockedByDependenciesArgv(
  repo: string,
  issueNumber: string | number,
): string[] {
  return [
    "gh",
    "api",
    `repos/${repo}/issues/${issueNumber}/dependencies/blocked_by`,
  ];
}
export function buildIssueBlockingDependenciesArgv(
  repo: string,
  issueNumber: string | number,
): string[] {
  return [
    "gh",
    "api",
    `repos/${repo}/issues/${issueNumber}/dependencies/blocking`,
  ];
}
export function buildBodyBlockerViewArgv(
  ref: Pick<BodyBlockerRef, "repo" | "number">,
): string[] {
  return [
    "gh",
    "issue",
    "view",
    String(ref.number),
    "--repo",
    ref.repo,
    "--json",
    "number,title,state,stateReason,closed,closedAt,url",
  ];
}
export const fetchGitHubIssue = Effect.fn("GitHub.fetchGitHubIssue")(function* (
  input: string,
  options: {
    cwd: string;
    repo?: string | undefined;
  },
): Effect.fn.Return<GitHubIssueSnapshot, GitHubError, GitHubRequirements> {
  const parsed = yield* Effect.try({
    try: () => parseIssueRef(input, options.repo),
    catch: (cause) =>
      new GitHubRequestError({
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  });
  const args = [
    "gh",
    "issue",
    "view",
    parsed.issueNumber,
    "--json",
    "number,title,body,state,labels,assignees,milestone,url",
  ];
  if (parsed.repo) args.push("--repo", parsed.repo);
  const stdout = yield* runProcessOrThrow(args, {
    cwd: options.cwd,
    label: "gh issue view",
  });
  const issue = yield* parseIssue(stdout).pipe(
    Effect.mapError((cause) => new GitHubResponseError({ cause })),
  );
  const repo = yield* resolveGitHubIssueRepo({
    cwd: options.cwd,
    explicitRepo: parsed.repo,
    issueUrl: issue.url,
  });
  const relationships = yield* fetchGitHubIssueRelationships({
    cwd: options.cwd,
    repo,
    issueNumber: parsed.issueNumber,
    body: issue.body ?? "",
  });
  const comments = yield* fetchIssueComments({
    cwd: options.cwd,
    repo: repo ?? "{owner}/{repo}",
    issueNumber: parsed.issueNumber,
  });
  return {
    issue: { ...issue, comments },
    issueNumber: parsed.issueNumber,
    repo,
    fetchedAt: DateTime.formatIso(yield* DateTime.now),
    relationships,
  };
});
export const resolveGitHubIssueRepo = Effect.fn(
  "GitHub.resolveGitHubIssueRepo",
)(function* (options: {
  cwd: string;
  explicitRepo?: string | undefined;
  issueUrl?: string | undefined;
}) {
  if (options.explicitRepo) return options.explicitRepo;
  const fromUrl = repoFromIssueUrl(options.issueUrl);
  if (fromUrl) return fromUrl;
  return yield* getCurrentGitHubRepository(options).pipe(
    Effect.map((repo) => repo || undefined),
    Effect.catch(() => Effect.succeed(undefined)),
  );
});
export const fetchGitHubIssueRelationships = Effect.fn(
  "GitHub.fetchGitHubIssueRelationships",
)(function* (options: {
  cwd: string;
  repo?: string | undefined;
  issueNumber: string | number;
  body: string;
}): Effect.fn.Return<
  GitHubIssueRelationships,
  GitHubError,
  GitHubRequirements
> {
  const fetchedAt = DateTime.formatIso(yield* DateTime.now);
  const native = options.repo
    ? yield* fetchNativeRelationshipsBestEffort({
        cwd: options.cwd,
        repo: options.repo,
        issueNumber: options.issueNumber,
      })
    : {
        nativeDependenciesAvailable: false,
        blockedBy: [] as GitHubIssueDependency[],
        blocking: [] as GitHubIssueDependency[],
        unavailableReason:
          "repository could not be resolved for dependency API requests",
      };
  const bodyDeclaredBlockers = options.repo
    ? yield* verifyBodyDeclaredBlockers({
        cwd: options.cwd,
        refs: parseBodyDeclaredBlockerRefs(options.body, options.repo),
      })
    : [];
  return {
    fetchedAt,
    repo: options.repo,
    nativeDependenciesAvailable: native.nativeDependenciesAvailable,
    issueDependenciesSummary: native.issueDependenciesSummary,
    blockedBy: native.blockedBy,
    blocking: native.blocking,
    bodyDeclaredBlockers,
    unavailableReason: native.unavailableReason,
  };
});
export function parseBodyDeclaredBlockerRefs(
  body: string,
  currentRepo: string,
): BodyBlockerRef[] {
  const lines = body.split(/\r?\n/);
  const refs: BodyBlockerRef[] = [];
  let inFence = false;
  let inDependencySection = false;
  for (const line of lines) {
    if (/^\s*```/.test(line) || /^\s*~~~/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (/^\s*#{2,3}\s*(?:Blocked by|Depends on)\s*$/i.test(line)) {
      inDependencySection = true;
      continue;
    }
    if (inDependencySection && /^\s*#{1,6}\s+/.test(line)) {
      inDependencySection = false;
    }
    const inlineMatch =
      /^\s*(?:[-*]\s*)?(?:Blocked by|Depends on)\s*:?\s*(.+)$/i.exec(line);
    if (inlineMatch?.[1])
      refs.push(
        ...extractExplicitIssueRefsFromStart(inlineMatch[1], currentRepo),
      );
    else if (inDependencySection)
      refs.push(
        ...extractExplicitIssueRefsFromStart(
          line.replace(/^\s*[-*]\s*/, ""),
          currentRepo,
        ),
      );
  }
  return dedupeBodyBlockerRefs(refs);
}
const dependencySchema = Schema.Struct({
  number: Schema.Int,
  title: Schema.optional(Schema.NullOr(Schema.String)),
  url: Schema.optional(Schema.NullOr(Schema.String)),
  html_url: Schema.optional(Schema.NullOr(Schema.String)),
  state: Schema.optional(Schema.NullOr(Schema.String)),
  stateReason: Schema.optional(Schema.NullOr(Schema.String)),
  state_reason: Schema.optional(Schema.NullOr(Schema.String)),
  closedAt: Schema.optional(Schema.NullOr(Schema.String)),
  closed_at: Schema.optional(Schema.NullOr(Schema.String)),
});
function normalizeGitHubIssueDependency(
  value: typeof dependencySchema.Type,
): GitHubIssueDependency {
  return {
    number: value.number,
    title: value.title ?? "",
    url: value.url ?? value.html_url ?? undefined,
    state: value.state?.toUpperCase() ?? "unknown",
    stateReason: value.stateReason ?? value.state_reason,
    closedAt: value.closedAt ?? value.closed_at,
  };
}
const dependencyArraySchema = Schema.mutable(
  Schema.Array(Schema.NullOr(dependencySchema)),
);
const dependencyListSchema = Schema.Union([
  dependencyArraySchema,
  Schema.Struct({ blocked_by: dependencyArraySchema }),
  Schema.Struct({ blockedBy: dependencyArraySchema }),
  Schema.Struct({ blocking: dependencyArraySchema }),
  Schema.Struct({ nodes: dependencyArraySchema }),
  Schema.Struct({ items: dependencyArraySchema }),
]);
const decodeDependencyList = Schema.decodeUnknownEffect(
  Schema.fromJsonString(dependencyListSchema),
);
export const parseGitHubIssueDependencies = Effect.fn(
  "parseGitHubIssueDependencies",
)(function* (raw: string) {
  const value = yield* decodeDependencyList(raw).pipe(
    Effect.mapError((cause) => new GitHubResponseError({ cause })),
  );
  const entries = Array.isArray(value)
    ? value
    : "blocked_by" in value
      ? value.blocked_by
      : "blockedBy" in value
        ? value.blockedBy
        : "blocking" in value
          ? value.blocking
          : "nodes" in value
            ? value.nodes
            : value.items;
  return entries
    .filter((entry) => entry !== null)
    .map(normalizeGitHubIssueDependency);
});
const count = Schema.optional(
  Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
);
const dependenciesSummarySchema = Schema.Struct({
  blockedBy: count,
  blocked_by: count,
  blocking: count,
  totalBlockedBy: count,
  total_blocked_by: count,
  totalBlocking: count,
  total_blocking: count,
});
const summaryPayloadSchema = Schema.Struct({
  issue_dependencies_summary: Schema.optional(
    Schema.NullOr(dependenciesSummarySchema),
  ),
  issueDependenciesSummary: Schema.optional(
    Schema.NullOr(dependenciesSummarySchema),
  ),
});
const decodeSummary = Schema.decodeUnknownEffect(
  Schema.fromJsonString(summaryPayloadSchema),
);
const bodyBlockerSchema = Schema.Struct({
  ...dependencySchema.fields,
  closed: Schema.optional(Schema.NullOr(Schema.Boolean)),
});
const decodeBodyBlocker = Schema.decodeUnknownEffect(
  Schema.fromJsonString(bodyBlockerSchema),
);

const fetchNativeRelationshipsBestEffort = Effect.fn(
  "GitHub.fetchNativeRelationshipsBestEffort",
)(function* (options: {
  cwd: string;
  repo: string;
  issueNumber: string | number;
}): Effect.fn.Return<
  {
    nativeDependenciesAvailable: boolean;
    issueDependenciesSummary?: GitHubIssueDependenciesSummary | undefined;
    blockedBy: GitHubIssueDependency[];
    blocking: GitHubIssueDependency[];
    unavailableReason?: string | undefined;
  },
  GitHubError,
  GitHubRequirements
> {
  return yield* Effect.gen(function* () {
    const [issueRaw, blockedByRaw, blockingRaw] = yield* Effect.all(
      [
        runProcessOrThrow(
          buildIssueDependenciesSummaryArgv(options.repo, options.issueNumber),
          { cwd: options.cwd, label: "gh api issue dependency summary" },
        ),
        runProcessOrThrow(
          buildIssueBlockedByDependenciesArgv(
            options.repo,
            options.issueNumber,
          ),
          { cwd: options.cwd, label: "gh api issue dependencies blocked_by" },
        ),
        runProcessOrThrow(
          buildIssueBlockingDependenciesArgv(options.repo, options.issueNumber),
          { cwd: options.cwd, label: "gh api issue dependencies blocking" },
        ),
      ],
      { concurrency: "unbounded" },
    );
    const issuePayload = yield* decodeSummary(issueRaw).pipe(
      Effect.mapError((cause) => new GitHubResponseError({ cause })),
    );
    const blockedBy = yield* parseGitHubIssueDependencies(blockedByRaw);
    const blocking = yield* parseGitHubIssueDependencies(blockingRaw);
    const issueDependenciesSummary = normalizeIssueDependenciesSummary(
      issuePayload,
      blockedBy,
      blocking,
    );
    return {
      nativeDependenciesAvailable: true,
      issueDependenciesSummary,
      blockedBy,
      blocking,
    };
  }).pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        return {
          nativeDependenciesAvailable: false,
          blockedBy: [],
          blocking: [],
          unavailableReason: formatError(error),
        };
      }),
    ),
  );
});
const verifyBodyDeclaredBlockers = Effect.fn(
  "GitHub.verifyBodyDeclaredBlockers",
)(function* (options: {
  cwd: string;
  refs: BodyBlockerRef[];
}): Effect.fn.Return<BodyDeclaredBlocker[], GitHubError, GitHubRequirements> {
  const results: BodyDeclaredBlocker[] = [];
  for (const ref of options.refs) {
    yield* Effect.gen(function* () {
      const raw = yield* runProcessOrThrow(buildBodyBlockerViewArgv(ref), {
        cwd: options.cwd,
        label: "gh issue view body-declared blocker",
      });
      const parsed = yield* decodeBodyBlocker(raw).pipe(
        Effect.mapError((cause) => new GitHubResponseError({ cause })),
      );
      const dependency = normalizeGitHubIssueDependency(parsed);
      const closed = parsed.closed;
      results.push({
        raw: ref.raw,
        repo: ref.repo,
        number: dependency.number,
        verified: true,
        title: dependency.title,
        url: dependency.url,
        state: dependency.state,
        stateReason: dependency.stateReason,
        closed: closed ?? dependency.state === "CLOSED",
        closedAt: dependency.closedAt,
      });
    }).pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          results.push({
            raw: ref.raw,
            repo: ref.repo,
            number: ref.number,
            verified: false,
            unavailableReason: formatError(error),
          });
        }),
      ),
    );
  }
  return results;
});
function normalizeIssueDependenciesSummary(
  issuePayload: typeof summaryPayloadSchema.Type,
  blockedBy: GitHubIssueDependency[],
  blocking: GitHubIssueDependency[],
): GitHubIssueDependenciesSummary {
  const summary =
    issuePayload.issue_dependencies_summary ??
    issuePayload.issueDependenciesSummary;
  return {
    blockedBy:
      summary?.blockedBy ?? summary?.blocked_by ?? activeIssueCount(blockedBy),
    blocking: summary?.blocking ?? activeIssueCount(blocking),
    totalBlockedBy:
      summary?.totalBlockedBy ?? summary?.total_blocked_by ?? blockedBy.length,
    totalBlocking:
      summary?.totalBlocking ?? summary?.total_blocking ?? blocking.length,
  };
}

function activeIssueCount(issues: GitHubIssueDependency[]): number {
  return issues.filter((issue) => issue.state !== "CLOSED").length;
}
function extractExplicitIssueRefsFromStart(
  text: string,
  currentRepo: string,
): BodyBlockerRef[] {
  const refs: BodyBlockerRef[] = [];
  let remainder = text.trim();
  while (remainder.length > 0) {
    const match =
      /^(https?:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/issues\/(\d+)|([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)|#(\d+))/i.exec(
        remainder,
      );
    if (!match?.[1]) break;
    const repo = match[2] ?? match[4] ?? currentRepo;
    const number = Number(match[3] ?? match[5] ?? match[6]);
    if (Number.isInteger(number) && number > 0)
      refs.push({ raw: match[1], repo, number });
    remainder = remainder.slice(match[1].length).trimStart();
    const separator = /^(?:[,;]|\band\b|&)\s*/i.exec(remainder);
    if (!separator?.[0]) break;
    remainder = remainder.slice(separator[0].length).trimStart();
  }
  return refs;
}
function dedupeBodyBlockerRefs(refs: BodyBlockerRef[]): BodyBlockerRef[] {
  const seen = new Set<string>();
  const result: BodyBlockerRef[] = [];
  for (const ref of refs) {
    const key = `${ref.repo.toLowerCase()}#${ref.number}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(ref);
  }
  return result;
}
function repoFromIssueUrl(url?: string): string | undefined {
  return url?.match(
    /^https?:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/\d+/i,
  )?.[1];
}
function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
